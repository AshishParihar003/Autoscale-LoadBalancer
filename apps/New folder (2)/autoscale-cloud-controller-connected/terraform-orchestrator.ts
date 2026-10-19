import { Router, type Request, type Response } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const router = Router();
const execFileAsync = promisify(execFile);
const plans = new Map<string, { file: string; desiredInstances: number; createdAt: number; output: string }>();
const operations: Array<Record<string, unknown>> = [];
let operationInProgress = false;

const MAX_OUTPUT = 2 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = Number(process.env.TERRAFORM_COMMAND_TIMEOUT_MS || 600_000);
const APPLY_TIMEOUT_MS = Number(process.env.TERRAFORM_APPLY_TIMEOUT_MS || 1_200_000);
// When launched from apps/autoscale-website, the real Terraform files live at
// ../../infrastructure/terraform in the repository. Prefer a directory that
// actually contains .tf files; an explicit environment override always wins.
const configuredDirectory = () => {
  const override = process.env.TERRAFORM_PROJECT_DIR?.trim();
  if (override) return path.resolve(override);
  const candidates = [
    path.resolve(process.cwd(), "infrastructure", "terraform"),
    path.resolve(process.cwd(), "../../infrastructure/terraform")
  ];
  return candidates.find((candidate) => {
    try {
      return existsSync(candidate) && readdirSync(candidate).some((name) => name.endsWith(".tf") || name.endsWith(".tf.json"));
    } catch { return false; }
  }) || candidates[1];
};
const terraformBinary = () => process.env.TERRAFORM_BIN || "terraform";
const instanceVariable = () => process.env.TERRAFORM_INSTANCE_VARIABLE || "vm_count";
const ansibleBinary = () => process.env.ANSIBLE_BIN || "ansible-playbook";
const resolveConfiguredPath = (value: string) => path.isAbsolute(value) ? value : path.resolve(configuredDirectory(), value);

function addOperation(record: Record<string, unknown>) {
  operations.unshift(record);
  if (operations.length > 50) operations.length = 50;
}

function sendError(res: Response, error: unknown, fallback: string) {
  const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number; killed?: boolean };
  const message = err?.code === "ENOENT"
    ? `Terraform executable "${terraformBinary()}" was not found. Install Terraform or set TERRAFORM_BIN.`
    : err?.killed
      ? `Terraform command timed out. Configured timeout: ${COMMAND_TIMEOUT_MS} ms (apply timeout may be longer).`
      : err?.message || fallback;
  return res.status(err?.code === "ENOENT" ? 503 : 400).json({
    error: fallback,
    message,
    output: [err?.stdout, err?.stderr].filter(Boolean).join("\n").slice(0, MAX_OUTPUT)
  });
}

async function runTerraform(args: string[], cwd = configuredDirectory(), timeoutMs = COMMAND_TIMEOUT_MS) {
  const stat = await fs.stat(cwd).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Terraform project directory does not exist: ${cwd}. Set TERRAFORM_PROJECT_DIR to a valid directory.`);
  return execFileAsync(terraformBinary(), args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
    env: process.env
  });
}

function safeOutput(result: { stdout?: string; stderr?: string }) {
  // Terraform output can contain sensitive values in some configurations. Limit
  // output length and avoid logging it to the server console.
  return [result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, MAX_OUTPUT);
}

// Run Ansible only after Terraform apply succeeds. The project must explicitly
// configure a playbook and inventory; absence is reported as SKIPPED, never as success.
async function runAnsibleAfterApply() {
  const playbookSetting = process.env.ANSIBLE_PLAYBOOK?.trim();
  const inventorySetting = process.env.ANSIBLE_INVENTORY?.trim();
  if (!playbookSetting || !inventorySetting) {
    return {
      status: "SKIPPED",
      message: "Terraform succeeded, but Ansible was not run because ANSIBLE_PLAYBOOK and/or ANSIBLE_INVENTORY are not configured."
    };
  }

  const playbook = resolveConfiguredPath(playbookSetting);
  const inventory = resolveConfiguredPath(inventorySetting);
  const [playbookStat, inventoryStat] = await Promise.all([
    fs.stat(playbook).catch(() => null),
    fs.stat(inventory).catch(() => null)
  ]);
  if (!playbookStat?.isFile()) {
    return { status: "FAILED", message: `Configured Ansible playbook does not exist: ${playbook}` };
  }
  if (!inventoryStat) {
    return { status: "FAILED", message: `Configured Ansible inventory does not exist: ${inventory}` };
  }

  const timeout = Number(process.env.ANSIBLE_COMMAND_TIMEOUT_MS || 600_000);
  try {
    const result = await execFileAsync(ansibleBinary(), [playbook, "-i", inventory], {
      cwd: process.env.ANSIBLE_WORKING_DIR ? path.resolve(process.env.ANSIBLE_WORKING_DIR) : path.dirname(playbook),
      timeout,
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
      env: process.env
    });
    return { status: "SUCCEEDED", output: safeOutput(result), message: "Ansible playbook completed successfully." };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
    return {
      status: "FAILED",
      message: err.code === "ENOENT"
        ? `Ansible executable \"${ansibleBinary()}\" was not found. Install Ansible or configure ANSIBLE_BIN (Ansible control-node support on Windows may require WSL).`
        : err.killed ? `Ansible timed out after ${timeout} ms.` : err.message || "Ansible playbook failed.",
      output: [err.stdout, err.stderr].filter(Boolean).join("\n").slice(0, MAX_OUTPUT)
    };
  }
}

function authorized(req: Request) {
  const expected = process.env.ADMIN_TOKEN;
  const supplied = req.header("x-admin-token") || "";
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

router.get("/status", async (_req, res) => {
  const directory = configuredDirectory();
  const exists = await fs.stat(directory).then(s => s.isDirectory()).catch(() => false);
  const files = exists ? (await fs.readdir(directory).catch(() => [])).filter(n => n.endsWith(".tf") || n.endsWith(".tf.json")) : [];
  const initialized = exists ? await fs.stat(path.join(directory, ".terraform")).then(s => s.isDirectory()).catch(() => false) : false;
  let managedCapacity: number | null = null;
  let websiteUrl: string | null = null;
  let stateAvailable = false;
  if (exists && initialized) {
    try {
      const outputResult = await execFileAsync(terraformBinary(), ["output", "-json"], {
        cwd: directory, timeout: 15_000, maxBuffer: 256 * 1024, windowsHide: true, env: process.env
      });
      const outputs = JSON.parse(outputResult.stdout || "{}");
      stateAvailable = true;
      const capacity = outputs.vm_scale_set_capacity?.value ?? outputs.vm_count?.value ?? outputs.instance_count?.value;
      if (typeof capacity === "number" && Number.isFinite(capacity)) managedCapacity = capacity;
      const url = outputs.website_url?.value;
      if (typeof url === "string") websiteUrl = url;
    } catch {
      // No state/outputs yet is a normal pre-deployment condition. Do not turn
      // a diagnostic status request into an error or expose Terraform internals.
    }
  }
  res.json({
    status: exists && files.length ? "configured" : "not-configured",
    projectDirectory: directory,
    directoryExists: exists,
    configurationFiles: files,
    initialized,
    stateAvailable,
    managedCapacity,
    websiteUrl,
    capacitySource: managedCapacity === null ? "unavailable" : "terraform state output",
    applyEnabled: Boolean(process.env.ADMIN_TOKEN),
    ansibleConfigured: Boolean(process.env.ANSIBLE_PLAYBOOK?.trim() && process.env.ANSIBLE_INVENTORY?.trim()),
    instanceVariable: instanceVariable()
  });
});

router.get("/version", async (_req, res) => {
  try {
    const result = await execFileAsync(terraformBinary(), ["version"], {
      timeout: 15_000, maxBuffer: 256 * 1024, windowsHide: true
    });
    res.json({ status: "PASS", version: (result.stdout || "").trim(), output: safeOutput(result) });
  } catch (error) { sendError(res, error, "Could not run terraform version."); }
});

router.get("/diagnostics", async (_req, res) => {
  const directory = configuredDirectory();
  const checks: Array<{ name: string; status: "PASS" | "FAIL" | "NOT CONFIGURED" | "NOT RUN"; message: string; details?: string }> = [];
  const stat = await fs.stat(directory).catch(() => null);
  const exists = Boolean(stat?.isDirectory());
  checks.push({
    name: "Terraform project directory",
    status: exists ? "PASS" : "FAIL",
    message: exists ? "Configured project directory exists." : `Directory not found. Set TERRAFORM_PROJECT_DIR.`
  });
  const files = exists ? (await fs.readdir(directory).catch(() => [])).filter(n => n.endsWith(".tf") || n.endsWith(".tf.json")) : [];
  checks.push({
    name: "Terraform configuration",
    status: files.length ? "PASS" : exists ? "FAIL" : "NOT RUN",
    message: files.length ? `${files.length} Terraform configuration file(s) found.` : "No .tf or .tf.json files found.",
    details: files.join(", ")
  });
  try {
    const result = await execFileAsync(terraformBinary(), ["version"], { timeout: 15_000, maxBuffer: 256 * 1024, windowsHide: true });
    checks.push({ name: "Terraform CLI", status: "PASS", message: "Terraform executable launched successfully.", details: (result.stdout || "").trim().split("\n").slice(0, 2).join("\n") });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    checks.push({ name: "Terraform CLI", status: "FAIL", message: err.code === "ENOENT" ? `Terraform executable "${terraformBinary()}" not found.` : err.message || "Terraform version command failed." });
  }
  const initialized = exists ? await fs.stat(path.join(directory, ".terraform")).then(s => s.isDirectory()).catch(() => false) : false;
  checks.push({ name: "Provider initialization", status: initialized ? "PASS" : exists ? "NOT CONFIGURED" : "NOT RUN", message: initialized ? "A .terraform directory exists." : "Run Terraform init after checking the project configuration." });
  const envChecks = [
    ["Azure CLI", Boolean(process.env.ARM_USE_CLI || process.env.AZURE_CONFIG_DIR)],
    ["ARM_CLIENT_ID", Boolean(process.env.ARM_CLIENT_ID)],
    ["ARM_SUBSCRIPTION_ID", Boolean(process.env.ARM_SUBSCRIPTION_ID)],
    ["ARM_TENANT_ID", Boolean(process.env.ARM_TENANT_ID)],
    ["ARM_CLIENT_SECRET", Boolean(process.env.ARM_CLIENT_SECRET)]
  ];
  const configuredAuth = envChecks.some(([, present]) => present);
  checks.push({
    name: "Azure authentication configuration",
    status: configuredAuth ? "PASS" : "NOT CONFIGURED",
    message: configuredAuth ? "At least one Azure authentication-related environment setting is present. This does not prove credentials are valid." : "No common ARM authentication environment variables detected. Azure CLI or managed identity may still be configured outside these variables."
  });
  res.json({ checks, projectDirectory: directory, configurationFiles: files, note: "Environment checks never return credential values. Authentication is not fully verified until a provider operation succeeds." });
});

router.post("/init", async (_req, res) => {
  if (operationInProgress) return res.status(409).json({ message: "Another Terraform operation is running." });
  operationInProgress = true;
  const id = randomUUID();
  try {
    const result = await runTerraform(["init", "-input=false", "-no-color"]);
    const output = safeOutput(result);
    addOperation({ id, command: "terraform init", status: "SUCCEEDED", createdAt: new Date().toISOString(), output });
    return res.json({ id, status: "SUCCEEDED", output });
  } catch (error) {
    addOperation({ id, command: "terraform init", status: "FAILED", createdAt: new Date().toISOString() });
    return sendError(res, error, "Terraform initialization failed.");
  } finally { operationInProgress = false; }
});

router.post("/fmt-check", async (_req, res) => {
  try {
    const result = await runTerraform(["fmt", "-check", "-recursive"]);
    res.json({ status: "PASS", output: safeOutput(result) || "Terraform files are formatted." });
  } catch (error) { sendError(res, error, "Terraform formatting check failed."); }
});

router.post("/validate", async (_req, res) => {
  try {
    const result = await runTerraform(["validate", "-no-color"]);
    res.json({ status: "PASS", output: safeOutput(result) || "Terraform configuration is valid." });
  } catch (error) { sendError(res, error, "Terraform validation failed. Run terraform init and inspect the provider/configuration errors."); }
});

router.post("/plan", async (req, res) => {
  const parsed = z.object({ desiredInstances: z.number().int().min(0).max(10) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "desiredInstances must be an integer from 0 to 10." });
  if (operationInProgress) return res.status(409).json({ message: "Another Terraform operation is running." });
  const directory = configuredDirectory();
  const tfFiles = await fs.readdir(directory).then(names => names.filter(n => n.endsWith(".tf") || n.endsWith(".tf.json"))).catch(() => []);
  if (!tfFiles.length) return res.status(400).json({ message: `No Terraform configuration found in ${directory}. Set TERRAFORM_PROJECT_DIR or add .tf files.` });
  operationInProgress = true;
  const planId = randomUUID();
  const planDir = path.join(directory, ".autoscale-plans");
  const planFile = path.join(planDir, `${planId}.tfplan`);
  try {
    await fs.mkdir(planDir, { recursive: true });
    const args = ["plan", "-input=false", "-no-color", `-out=${planFile}`, `-var=${instanceVariable()}=${parsed.data.desiredInstances}`];
    const result = await runTerraform(args, directory);
    const output = safeOutput(result);
    plans.set(planId, { file: planFile, desiredInstances: parsed.data.desiredInstances, createdAt: Date.now(), output });
    addOperation({ id: planId, command: "terraform plan", status: "AWAITING_APPROVAL", createdAt: new Date().toISOString(), desiredInstances: parsed.data.desiredInstances, output });
    return res.json({
      planId, status: "AWAITING_APPROVAL", desiredInstances: parsed.data.desiredInstances,
      planOutput: output || "Terraform plan succeeded with no textual output.",
      approvalRequired: true, infrastructureChanged: false,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString()
    });
  } catch (error) {
    await fs.rm(planFile, { force: true }).catch(() => {});
    addOperation({ id: planId, command: "terraform plan", status: "FAILED", createdAt: new Date().toISOString() });
    return sendError(res, error, "Terraform plan failed.");
  } finally { operationInProgress = false; }
});

router.post("/approve", async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ message: "Apply is disabled or unauthorized. Set ADMIN_TOKEN on the server and send it as x-admin-token." });
  const parsed = z.object({ planId: z.string().uuid(), approved: z.literal(true) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "A valid planId and approved:true are required." });
  if (operationInProgress) return res.status(409).json({ message: "Another Terraform operation is running." });
  const plan = plans.get(parsed.data.planId);
  if (!plan) return res.status(404).json({ message: "Plan not found, already used, or expired. Generate a fresh plan." });
  if (Date.now() - plan.createdAt > 15 * 60_000) {
    plans.delete(parsed.data.planId);
    await fs.rm(plan.file, { force: true }).catch(() => {});
    return res.status(410).json({ message: "Plan expired. Generate and review a new plan." });
  }
  operationInProgress = true;
  try {
    const result = await runTerraform(["apply", "-input=false", "-no-color", "-auto-approve", plan.file], configuredDirectory(), APPLY_TIMEOUT_MS);
    const output = safeOutput(result);
    plans.delete(parsed.data.planId);
    await fs.rm(plan.file, { force: true }).catch(() => {});

    // Only configure the newly applied infrastructure after Terraform succeeds.
    const ansible = await runAnsibleAfterApply();
    const status = ansible.status === "FAILED" ? "TERRAFORM_SUCCEEDED_ANSIBLE_FAILED"
      : ansible.status === "SKIPPED" ? "TERRAFORM_SUCCEEDED_ANSIBLE_SKIPPED"
      : "SUCCEEDED";
    const operation = {
      operationId: parsed.data.planId,
      command: "terraform apply + ansible",
      status,
      createdAt: new Date().toISOString(),
      desiredInstances: plan.desiredInstances,
      terraformStatus: "SUCCEEDED",
      ansible,
      output
    };
    addOperation({ id: parsed.data.planId, ...operation });
    return res.json({
      ...operation,
      message: ansible.status === "SUCCEEDED"
        ? "Terraform apply and Ansible configuration completed. Verify Azure instance health."
        : ansible.status === "SKIPPED"
          ? "Terraform apply completed, but Ansible was skipped. Configure ANSIBLE_PLAYBOOK and ANSIBLE_INVENTORY to run configuration management."
          : "Terraform apply completed, but Ansible configuration failed. Inspect the Ansible output before treating the deployment as ready.",
      infrastructureChanged: true
    });
  } catch (error) {
    addOperation({ id: parsed.data.planId, command: "terraform apply", status: "FAILED", createdAt: new Date().toISOString() });
    return sendError(res, error, "Terraform apply failed.");
  } finally { operationInProgress = false; }
});

router.get("/operations", (_req, res) => res.json({ operations }));
router.get("/operations/:id", (req, res) => {
  const operation = operations.find(item => item.id === req.params.id);
  if (!operation) return res.status(404).json({ message: "Operation not found in this server session." });
  return res.json(operation);
});

export default router;

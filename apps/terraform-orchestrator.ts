import { Router, type Request, type Response } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const router = Router();
const execFileAsync = promisify(execFile);
const plans = new Map<string, { file: string; desiredInstances: number; createdAt: number; output: string }>();
const operations: Array<Record<string, unknown>> = [];
let operationInProgress = false;

const MAX_OUTPUT = 2 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = Number(process.env.TERRAFORM_COMMAND_TIMEOUT_MS || 120_000);
const configuredDirectory = () => path.resolve(process.env.TERRAFORM_PROJECT_DIR || path.join(process.cwd(), "infrastructure", "terraform"));
const terraformBinary = () => process.env.TERRAFORM_BIN || "terraform";
const instanceVariable = () => process.env.TERRAFORM_INSTANCE_VARIABLE || "vm_count";

function addOperation(record: Record<string, unknown>) {
  operations.unshift(record);
  if (operations.length > 50) operations.length = 50;
}

function sendError(res: Response, error: unknown, fallback: string) {
  const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number; killed?: boolean };
  const message = err?.code === "ENOENT"
    ? `Terraform executable "${terraformBinary()}" was not found. Install Terraform or set TERRAFORM_BIN.`
    : err?.killed
      ? `Terraform command timed out after ${COMMAND_TIMEOUT_MS} ms.`
      : err?.message || fallback;
  return res.status(err?.code === "ENOENT" ? 503 : 400).json({
    error: fallback,
    message,
    output: [err?.stdout, err?.stderr].filter(Boolean).join("\n").slice(0, MAX_OUTPUT)
  });
}

async function runTerraform(args: string[], cwd = configuredDirectory()) {
  const stat = await fs.stat(cwd).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Terraform project directory does not exist: ${cwd}. Set TERRAFORM_PROJECT_DIR to a valid directory.`);
  return execFileAsync(terraformBinary(), args, {
    cwd,
    timeout: COMMAND_TIMEOUT_MS,
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
  res.json({
    status: exists && files.length ? "configured" : "not-configured",
    projectDirectory: directory,
    directoryExists: exists,
    configurationFiles: files,
    initialized: exists ? await fs.stat(path.join(directory, ".terraform")).then(s => s.isDirectory()).catch(() => false) : false,
    applyEnabled: Boolean(process.env.ADMIN_TOKEN),
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
    const result = await runTerraform(["apply", "-input=false", "-no-color", "-auto-approve", plan.file]);
    const output = safeOutput(result);
    plans.delete(parsed.data.planId);
    await fs.rm(plan.file, { force: true }).catch(() => {});
    addOperation({ id: parsed.data.planId, command: "terraform apply", status: "SUCCEEDED", createdAt: new Date().toISOString(), output });
    return res.json({ operationId: parsed.data.planId, status: "SUCCEEDED", message: "Terraform apply completed. Verify Azure resource status and application health.", output, infrastructureChanged: true });
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

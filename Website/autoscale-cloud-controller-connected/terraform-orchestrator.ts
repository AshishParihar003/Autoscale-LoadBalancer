import "dotenv/config";
import { Router, type Request, type Response } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync
} from "node:fs";
import fs from "node:fs/promises";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const router = Router();
const execFileAsync = promisify(execFile);

const MAX_OUTPUT = 2 * 1024 * 1024;
const PLAN_EXPIRY_MS = 15 * 60 * 1000;

type SavedPlan = {
  file: string;
  desiredInstances: number;
  createdAt: number;
  output: string;
};

type OperationRecord = Record<string, unknown>;

const plans = new Map<string, SavedPlan>();
const destroyPlans = new Map<string, SavedPlan>();
const operations: OperationRecord[] = [];
let operationInProgress = false;

const operationLogFile = process.env.CONTROLLER_LOG_FILE?.trim()
  ? path.resolve(process.env.CONTROLLER_LOG_FILE.trim())
  : path.resolve(process.cwd(), "logs", "terraform-operations.jsonl");

const COMMAND_TIMEOUT_MS = Number(
  process.env.TERRAFORM_COMMAND_TIMEOUT_MS || 600_000
);

const APPLY_TIMEOUT_MS = Number(
  process.env.TERRAFORM_APPLY_TIMEOUT_MS || 1_200_000
);

const terraformBinary = () => process.env.TERRAFORM_BIN || "terraform";

const instanceVariable = () =>
  process.env.TERRAFORM_INSTANCE_VARIABLE || "vm_count";

const ansibleBinary = () => process.env.ANSIBLE_BIN || "ansible-playbook";

/**
 * Resolve the Terraform directory.
 *
 * TERRAFORM_PROJECT_DIR takes priority. Otherwise, look in the common
 * project locations relative to the current working directory.
 */
function configuredDirectory(): string {
  const override = process.env.TERRAFORM_PROJECT_DIR?.trim();

  if (override) {
    return path.resolve(override);
  }

  const candidates = [
    path.resolve(process.cwd(), "infrastructure", "terraform"),
    path.resolve(process.cwd(), "../../infrastructure/terraform")
  ];

  return (
    candidates.find((candidate) => {
      try {
        return (
          existsSync(candidate) &&
          readdirSync(candidate).some(
            (name) => name.endsWith(".tf") || name.endsWith(".tf.json")
          )
        );
      } catch {
        return false;
      }
    }) || candidates[1]
  );
}

function resolveConfiguredPath(value: string): string {
  return path.isAbsolute(value)
    ? value
    : path.resolve(configuredDirectory(), value);
}

/**
 * V2.0 server-side approval session.
 *
 * ADMIN_TOKEN is accepted only by POST /session/login and is exchanged for a
 * short-lived HttpOnly cookie. It is never accepted as an x-admin-token header.
 * The frontend must not persist this value in localStorage or embed it in code.
 */
const SESSION_COOKIE = "autoscale_admin_session";
const SESSION_TTL_MS = 30 * 60 * 1000;

function sessionSigningSecret(): string {
  return process.env.CONTROLLER_SESSION_SECRET?.trim() ||
    process.env.ADMIN_TOKEN?.trim() || "";
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function signSession(payload: string): string {
  return createHmac("sha256", sessionSigningSecret()).update(payload).digest("hex");
}

function getCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

function authorized(req: Request): boolean {
  const secret = sessionSigningSecret();
  if (!secret) return false;
  const cookie = getCookie(req, SESSION_COOKIE);
  if (!cookie) return false;
  const separator = cookie.lastIndexOf(".");
  if (separator <= 0) return false;
  const payload = cookie.slice(0, separator);
  const suppliedSignature = cookie.slice(separator + 1);
  if (!safeEqual(signSession(payload), suppliedSignature)) return false;
  const [expiresText, nonce] = payload.split(":");
  const expiresAt = Number(expiresText);
  return Boolean(nonce) && Number.isFinite(expiresAt) && expiresAt > Date.now();
}

/**
 * Local single-user development does not require an application-level admin
 * token or browser session. Terraform uses the Azure identity configured for
 * the backend process (for example, `az login` / Azure CLI auth).
 *
 * This bypass is deliberately unavailable in production and only accepts
 * loopback requests. Public deployments must use a real server-side identity
 * layer before exposing Apply/Destroy endpoints.
 */
function isLoopbackRequest(req: Request): boolean {
  const address = req.socket.remoteAddress?.toLowerCase() || "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function localDevelopmentOperationsEnabled(req: Request): boolean {
  return process.env.NODE_ENV !== "production" && isLoopbackRequest(req);
}

function requireAuthorization(req: Request, res: Response): boolean {
  if (authorized(req) || localDevelopmentOperationsEnabled(req)) return true;
  res.status(401).json({
    message: "Infrastructure changes are disabled for unauthenticated remote requests. Use the local dashboard during development or configure production authentication."
  });
  return false;
}

/**
 * Load recent operation history from disk.
 */
try {
  if (existsSync(operationLogFile)) {
    const saved = readFileSync(operationLogFile, "utf8")
      .split(/\r?\n/)
      .filter(Boolean);

    for (const line of saved.slice(-50).reverse()) {
      try {
        operations.push(JSON.parse(line) as OperationRecord);
      } catch {
        // Ignore malformed historical records.
      }
    }
  }
} catch (error) {
  console.error(
    "Could not load Terraform operation history:",
    error instanceof Error ? error.message : String(error)
  );
}

/**
 * Save an operation in memory and append it to the JSONL log.
 */
function addOperation(record: OperationRecord): void {
  const withTimestamp = {
    ...record,
    loggedAt: new Date().toISOString()
  };

  operations.unshift(withTimestamp);

  if (operations.length > 50) {
    operations.length = 50;
  }

  try {
    mkdirSync(path.dirname(operationLogFile), { recursive: true });

    appendFileSync(
      operationLogFile,
      `${JSON.stringify(withTimestamp)}\n`,
      {
        encoding: "utf8",
        mode: 0o600
      }
    );
  } catch (error) {
    console.error(
      "Could not persist Terraform operation log:",
      error instanceof Error ? error.message : String(error)
    );
  }
}

type ProcessFailure = NodeJS.ErrnoException & {
  stdout?: string;
  stderr?: string;
  code?: string | number;
  killed?: boolean;
  signal?: string;
};

/**
 * Capture useful stdout/stderr details when a child process fails.
 */
function processFailureDetails(error: unknown) {
  const err = error as ProcessFailure;

  const stdout = redactSecrets(String(err?.stdout || "").slice(0, MAX_OUTPUT));
  const stderr = redactSecrets(String(err?.stderr || "").slice(0, MAX_OUTPUT));

  const output = [
    stdout && `STDOUT:\n${stdout}`,
    stderr && `STDERR:\n${stderr}`
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, MAX_OUTPUT);

  return { err, stdout, stderr, output };
}

function sendError(
  res: Response,
  error: unknown,
  fallback: string,
  context: Record<string, unknown> = {}
) {
  const { err, stdout, stderr, output } = processFailureDetails(error);

  const message =
    err?.code === "ENOENT"
      ? `Executable "${terraformBinary()}" was not found. Install Terraform or set TERRAFORM_BIN.`
      : err?.killed
        ? "Terraform command timed out. Check the operation log for partial output."
        : err?.message || fallback;

  const statusCode = err?.code === "ENOENT" ? 503 : 400;

  return res.status(statusCode).json({
    error: fallback,
    message,
    output,
    stdout,
    stderr,
    exitCode: typeof err?.code === "number" ? err.code : null,
    signal: err?.signal || null,
    ...context
  });
}

/**
 * Execute a Terraform command in the configured project directory.
 */
async function runTerraform(
  args: string[],
  cwd = configuredDirectory(),
  timeoutMs = COMMAND_TIMEOUT_MS
) {
  const stat = await fs.stat(cwd).catch(() => null);

  if (!stat?.isDirectory()) {
    throw new Error(
      `Terraform project directory does not exist: ${cwd}. ` +
      "Set TERRAFORM_PROJECT_DIR to a valid directory."
    );
  }

  return execFileAsync(terraformBinary(), args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
    env: process.env
  });
}

function redactSecrets(value: string): string {
  return value
    .replace(/(ARM_CLIENT_SECRET|ADMIN_TOKEN|CONTROLLER_SESSION_SECRET|client_secret|access_token|password)(\\s*[=:]\\s*)[^\\s,;]+/gi, "$1$2[REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]");
}

function safeOutput(result: { stdout?: string; stderr?: string }): string {
  return redactSecrets([result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_OUTPUT));
}

/**
 * Run Ansible only after Terraform apply succeeds.
 *
 * Ansible is skipped if the playbook or inventory is not configured.
 */
async function runAnsibleAfterApply() {
  const playbookSetting = process.env.ANSIBLE_PLAYBOOK?.trim();
  const inventorySetting = process.env.ANSIBLE_INVENTORY?.trim();

  if (!playbookSetting || !inventorySetting) {
    return {
      status: "SKIPPED",
      message:
        "Terraform succeeded, but Ansible was not run because " +
        "ANSIBLE_PLAYBOOK and/or ANSIBLE_INVENTORY are not configured."
    };
  }

  const playbook = resolveConfiguredPath(playbookSetting);
  const inventory = resolveConfiguredPath(inventorySetting);

  const [playbookStat, inventoryStat] = await Promise.all([
    fs.stat(playbook).catch(() => null),
    fs.stat(inventory).catch(() => null)
  ]);

  if (!playbookStat?.isFile()) {
    return {
      status: "FAILED",
      message: `Configured Ansible playbook does not exist: ${playbook}`
    };
  }

  if (!inventoryStat) {
    return {
      status: "FAILED",
      message: `Configured Ansible inventory does not exist: ${inventory}`
    };
  }

  const timeout = Number(
    process.env.ANSIBLE_COMMAND_TIMEOUT_MS || 600_000
  );

  try {
    const result = await execFileAsync(
      ansibleBinary(),
      [playbook, "-i", inventory],
      {
        cwd: process.env.ANSIBLE_WORKING_DIR
          ? path.resolve(process.env.ANSIBLE_WORKING_DIR)
          : path.dirname(playbook),
        timeout,
        maxBuffer: MAX_OUTPUT,
        windowsHide: true,
        env: process.env
      }
    );

    return {
      status: "SUCCEEDED",
      output: safeOutput(result),
      message: "Ansible playbook completed successfully."
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };

    return {
      status: "FAILED",
      message:
        err.code === "ENOENT"
          ? `Ansible executable "${ansibleBinary()}" was not found. ` +
            "Install Ansible or configure ANSIBLE_BIN. " +
            "Ansible control-node support on Windows may require WSL."
          : err.killed
            ? `Ansible timed out after ${timeout} ms.`
            : err.message || "Ansible playbook failed.",
      output: [err.stdout, err.stderr]
        .filter(Boolean)
        .join("\n")
        .slice(0, MAX_OUTPUT)
    };
  }
}

/**
 * POST /api/azure/session/login
 * Exchanges the server-configured ADMIN_TOKEN for a short-lived HttpOnly cookie.
 */
router.post("/session/login", (req, res) => {
  const expected = process.env.ADMIN_TOKEN?.trim();
  const supplied = typeof req.body?.token === "string" ? req.body.token : "";
  if (!expected || !supplied || !safeEqual(expected, supplied)) {
    return res.status(401).json({ message: "Invalid administrator credentials." });
  }
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = `${expiresAt}:${randomUUID()}`;
  const value = `${payload}.${signSession(payload)}`;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie",
    `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/api/azure; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`);
  return res.json({ authenticated: true, expiresAt: new Date(expiresAt).toISOString() });
});

/** POST /api/azure/session/logout */
router.post("/session/logout", (_req, res) => {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie",
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/api/azure; Max-Age=0${secure}`);
  return res.json({ authenticated: false });
});

/** GET /api/azure/session */
router.get("/session", (req, res) => {
  return res.json({ authenticated: authorized(req) });
});

/**
 * GET /api/azure/status
 *
 * Reports Terraform configuration and whether approval is enabled.
 * This does not prove Azure credentials are valid.
 */
router.get("/status", async (_req, res) => {
  const directory = configuredDirectory();

  const exists = await fs
    .stat(directory)
    .then((stat) => stat.isDirectory())
    .catch(() => false);

  const files = exists
    ? (await fs.readdir(directory).catch(() => [])).filter(
        (name) => name.endsWith(".tf") || name.endsWith(".tf.json")
      )
    : [];

  const initialized = exists
    ? await fs
        .stat(path.join(directory, ".terraform"))
        .then((stat) => stat.isDirectory())
        .catch(() => false)
    : false;

  let managedCapacity: number | null = null;
  let websiteUrl: string | null = null;
  let stateAvailable = false;

  if (exists && initialized) {
    try {
      const outputResult = await execFileAsync(
        terraformBinary(),
        ["output", "-json"],
        {
          cwd: directory,
          timeout: 15_000,
          maxBuffer: 256 * 1024,
          windowsHide: true,
          env: process.env
        }
      );

      const outputs = JSON.parse(outputResult.stdout || "{}");

      stateAvailable = true;

      const capacity =
        outputs.vm_scale_set_capacity?.value ??
        outputs.vm_count?.value ??
        outputs.instance_count?.value;

      if (typeof capacity === "number" && Number.isFinite(capacity)) {
        managedCapacity = capacity;
      }

      const url = outputs.website_url?.value;

      if (typeof url === "string") {
        websiteUrl = url;
      }
    } catch {
      // Missing outputs or state can be normal before initial deployment.
    }
  }

  return res.json({
    status: exists && files.length ? "configured" : "not-configured",
    projectDirectory: directory,
    directoryExists: exists,
    configurationFiles: files,
    initialized,
    stateAvailable,
    managedCapacity,
    websiteUrl,
    capacitySource:
      managedCapacity === null ? "unavailable" : "terraform state output",
    applyEnabled: process.env.NODE_ENV !== "production" || Boolean(process.env.ADMIN_TOKEN && sessionSigningSecret()),
    approvalAuth: "HttpOnly session cookie",
    ansibleConfigured: Boolean(
      process.env.ANSIBLE_PLAYBOOK?.trim() &&
      process.env.ANSIBLE_INVENTORY?.trim()
    ),
    instanceVariable: instanceVariable()
  });
});

/**
 * GET /api/azure/version
 */
router.get("/version", async (_req, res) => {
  try {
    const result = await execFileAsync(
      terraformBinary(),
      ["version"],
      {
        timeout: 15_000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
        env: process.env
      }
    );

    return res.json({
      status: "PASS",
      version: (result.stdout || "").trim(),
      output: safeOutput(result)
    });
  } catch (error) {
    return sendError(res, error, "Could not run terraform version.");
  }
});

/**
 * GET /api/azure/diagnostics
 */
router.get("/diagnostics", async (_req, res) => {
  const directory = configuredDirectory();

  const checks: Array<{
    name: string;
    status: "PASS" | "FAIL" | "NOT CONFIGURED" | "NOT RUN";
    message: string;
    details?: string;
  }> = [];

  const stat = await fs.stat(directory).catch(() => null);
  const exists = Boolean(stat?.isDirectory());

  checks.push({
    name: "Terraform project directory",
    status: exists ? "PASS" : "FAIL",
    message: exists
      ? "Configured project directory exists."
      : "Directory not found. Set TERRAFORM_PROJECT_DIR."
  });

  const files = exists
    ? (await fs.readdir(directory).catch(() => [])).filter(
        (name) => name.endsWith(".tf") || name.endsWith(".tf.json")
      )
    : [];

  checks.push({
    name: "Terraform configuration",
    status: files.length ? "PASS" : exists ? "FAIL" : "NOT RUN",
    message: files.length
      ? `${files.length} Terraform configuration file(s) found.`
      : "No .tf or .tf.json files found.",
    details: files.join(", ")
  });

  try {
    const result = await execFileAsync(
      terraformBinary(),
      ["version"],
      {
        timeout: 15_000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
        env: process.env
      }
    );

    checks.push({
      name: "Terraform CLI",
      status: "PASS",
      message: "Terraform executable launched successfully.",
      details: (result.stdout || "")
        .trim()
        .split("\n")
        .slice(0, 2)
        .join("\n")
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;

    checks.push({
      name: "Terraform CLI",
      status: "FAIL",
      message:
        err.code === "ENOENT"
          ? `Terraform executable "${terraformBinary()}" not found.`
          : err.message || "Terraform version command failed."
    });
  }

  const initialized = exists
    ? await fs
        .stat(path.join(directory, ".terraform"))
        .then((stat) => stat.isDirectory())
        .catch(() => false)
    : false;

  checks.push({
    name: "Provider initialization",
    status: initialized
      ? "PASS"
      : exists
        ? "NOT CONFIGURED"
        : "NOT RUN",
    message: initialized
      ? "A .terraform directory exists."
      : "Run Terraform init after checking the project configuration."
  });

  const envChecks: Array<[string, boolean]> = [
    [
      "Azure CLI",
      Boolean(process.env.ARM_USE_CLI || process.env.AZURE_CONFIG_DIR)
    ],
    ["ARM_CLIENT_ID", Boolean(process.env.ARM_CLIENT_ID)],
    ["ARM_SUBSCRIPTION_ID", Boolean(process.env.ARM_SUBSCRIPTION_ID)],
    ["ARM_TENANT_ID", Boolean(process.env.ARM_TENANT_ID)],
    ["ARM_CLIENT_SECRET", Boolean(process.env.ARM_CLIENT_SECRET)]
  ];

  const configuredAuth = envChecks.some(([, present]) => present);

  checks.push({
    name: "Azure authentication configuration",
    status: configuredAuth ? "PASS" : "NOT CONFIGURED",
    message: configuredAuth
      ? "At least one Azure authentication-related environment setting is present. This does not prove credentials are valid."
      : "No common ARM authentication environment variables detected. Azure CLI or managed identity may still be configured outside these variables."
  });

  return res.json({
    checks,
    projectDirectory: directory,
    configurationFiles: files,
    note:
      "Environment checks never return credential values. Authentication is not fully verified until a provider operation succeeds."
  });
});

/**
 * POST /api/azure/init
 *
 * Initializes the Terraform working directory. Does not apply resources.
 */
router.post("/init", async (_req, res) => {
  if (operationInProgress) {
    return res.status(409).json({
      message: "Another Terraform operation is running."
    });
  }

  operationInProgress = true;
  const id = randomUUID();

  try {
    const result = await runTerraform([
      "init",
      "-input=false",
      "-no-color"
    ]);

    const output = safeOutput(result);

    addOperation({
      id,
      command: "terraform init",
      status: "SUCCEEDED",
      createdAt: new Date().toISOString(),
      output
    });

    return res.json({ id, status: "SUCCEEDED", output });
  } catch (error) {
    const details = processFailureDetails(error);

    addOperation({
      id,
      command: "terraform init",
      status: "FAILED",
      createdAt: new Date().toISOString(),
      message: details.err?.message || "Terraform initialization failed.",
      output: details.output,
      stdout: details.stdout,
      stderr: details.stderr
    });

    return sendError(
      res,
      error,
      "Terraform initialization failed.",
      { operationId: id, command: "terraform init" }
    );
  } finally {
    operationInProgress = false;
  }
});

/**
 * POST /api/azure/fmt-check
 */
router.post("/fmt-check", async (_req, res) => {
  try {
    const result = await runTerraform(["fmt", "-check", "-recursive"]);

    return res.json({
      status: "PASS",
      output: safeOutput(result) || "Terraform files are formatted."
    });
  } catch (error) {
    return sendError(res, error, "Terraform formatting check failed.");
  }
});

/**
 * POST /api/azure/validate
 */
router.post("/validate", async (_req, res) => {
  try {
    const result = await runTerraform(["validate", "-no-color"]);

    return res.json({
      status: "PASS",
      output: safeOutput(result) || "Terraform configuration is valid."
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Terraform configuration validation failed. Run Terraform init and inspect provider/configuration errors."
    );
  }
});

/**
 * POST /api/azure/plan
 *
 * Creates a saved plan for later approval.
 * Planning may contact Azure and refresh state, but does not apply changes.
 */
router.post("/plan", async (req, res) => {
  const parsed = z
    .object({
      desiredInstances: z.number().int().min(0).max(5)
    })
    .safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      message: "desiredInstances must be an integer from 0 to 5."
    });
  }

  if (operationInProgress) {
    return res.status(409).json({
      message: "Another Terraform operation is running."
    });
  }

  const directory = configuredDirectory();

  const tfFiles = await fs
    .readdir(directory)
    .then((names) =>
      names.filter(
        (name) => name.endsWith(".tf") || name.endsWith(".tf.json")
      )
    )
    .catch(() => []);

  if (!tfFiles.length) {
    return res.status(400).json({
      message:
        `No Terraform configuration found in ${directory}. ` +
        "Set TERRAFORM_PROJECT_DIR or add .tf files."
    });
  }

  operationInProgress = true;

  const planId = randomUUID();
  const planDir = path.join(directory, ".autoscale-plans");
  const planFile = path.join(planDir, `${planId}.tfplan`);

  try {
    await fs.mkdir(planDir, { recursive: true });

    const args = [
      "plan",
      "-input=false",
      "-no-color",
      `-out=${planFile}`,
      `-var=${instanceVariable()}=${parsed.data.desiredInstances}`
    ];

    const result = await runTerraform(args, directory);
    const output = safeOutput(result);

    plans.set(planId, {
      file: planFile,
      desiredInstances: parsed.data.desiredInstances,
      createdAt: Date.now(),
      output
    });

    addOperation({
      id: planId,
      command: "terraform plan",
      status: "AWAITING_APPROVAL",
      createdAt: new Date().toISOString(),
      desiredInstances: parsed.data.desiredInstances,
      output
    });

    return res.json({
      planId,
      status: "AWAITING_APPROVAL",
      desiredInstances: parsed.data.desiredInstances,
      planOutput: output || "Terraform plan succeeded with no textual output.",
      approvalRequired: true,
      infrastructureChanged: false,
      expiresAt: new Date(Date.now() + PLAN_EXPIRY_MS).toISOString()
    });
  } catch (error) {
    await fs.rm(planFile, { force: true }).catch(() => {});

    const details = processFailureDetails(error);

    addOperation({
      id: planId,
      command: "terraform plan",
      status: "FAILED",
      createdAt: new Date().toISOString(),
      desiredInstances: parsed.data.desiredInstances,
      message: details.err?.message || "Terraform plan failed.",
      output: details.output,
      stdout: details.stdout,
      stderr: details.stderr
    });

    return sendError(
      res,
      error,
      "Terraform plan failed.",
      {
        operationId: planId,
        command: "terraform plan",
        projectDirectory: directory
      }
    );
  } finally {
    operationInProgress = false;
  }
});

/**
 * POST /api/azure/approve
 *
 * Uses the backend Azure identity and exact APPLY confirmation. Local single-user development does not require a separate app session.
 * This endpoint can create or modify billable infrastructure.
 */
router.post("/approve", async (req, res) => {
  if (!requireAuthorization(req, res)) return;

  const parsed = z
    .object({
      planId: z.string().uuid(),
      approved: z.literal(true),
      confirmation: z.literal("APPLY")
    })
    .safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      message: 'A valid planId, approved:true, and confirmation:"APPLY" are required.',
    });
  }

  if (operationInProgress) {
    return res.status(409).json({
      message: "Another Terraform operation is running."
    });
  }

  const plan = plans.get(parsed.data.planId);

  if (!plan) {
    return res.status(404).json({
      message: "Plan not found, already used, or expired. Generate a fresh plan."
    });
  }

  if (Date.now() - plan.createdAt > PLAN_EXPIRY_MS) {
    plans.delete(parsed.data.planId);
    await fs.rm(plan.file, { force: true }).catch(() => {});

    return res.status(410).json({
      message: "Plan expired. Generate and review a new plan."
    });
  }

  operationInProgress = true;

  try {
    const result = await runTerraform(
      [
        "apply",
        "-input=false",
        "-no-color",
        "-auto-approve",
        plan.file
      ],
      configuredDirectory(),
      APPLY_TIMEOUT_MS
    );

    const output = safeOutput(result);

    plans.delete(parsed.data.planId);
    await fs.rm(plan.file, { force: true }).catch(() => {});

    // Run Ansible only after Terraform apply succeeds.
    const ansible = await runAnsibleAfterApply();

    const status =
      ansible.status === "FAILED"
        ? "TERRAFORM_SUCCEEDED_ANSIBLE_FAILED"
        : ansible.status === "SKIPPED"
          ? "TERRAFORM_SUCCEEDED_ANSIBLE_SKIPPED"
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

    addOperation({
      id: parsed.data.planId,
      ...operation
    });

    return res.json({
      ...operation,
      message:
        ansible.status === "SUCCEEDED"
          ? "Terraform apply and Ansible configuration completed. Verify Azure instance health."
          : ansible.status === "SKIPPED"
            ? "Terraform apply completed, but Ansible was skipped. Configure ANSIBLE_PLAYBOOK and ANSIBLE_INVENTORY to run configuration management."
            : "Terraform apply completed, but Ansible configuration failed. Inspect the Ansible output before treating the deployment as ready.",
      infrastructureChanged: true
    });
  } catch (error) {
    const details = processFailureDetails(error);

    addOperation({
      id: parsed.data.planId,
      command: "terraform apply",
      status: "FAILED",
      createdAt: new Date().toISOString(),
      desiredInstances: plan.desiredInstances,
      message: details.err?.message || "Terraform apply failed.",
      output: details.output,
      stdout: details.stdout,
      stderr: details.stderr
    });

    return sendError(
      res,
      error,
      "Terraform apply failed.",
      {
        operationId: parsed.data.planId,
        command: "terraform apply",
        projectDirectory: configuredDirectory()
      }
    );
  } finally {
    operationInProgress = false;
  }
});

/**
 * POST /api/azure/destroy/plan
 * Creates a saved destroy plan; it does not destroy infrastructure.
 */
router.post("/destroy/plan", async (_req, res) => {
  if (operationInProgress) {
    return res.status(409).json({ message: "Another Terraform operation is running." });
  }
  const directory = configuredDirectory();
  const planId = randomUUID();
  const planDir = path.join(directory, ".autoscale-plans");
  const planFile = path.join(planDir, `${planId}.destroy.tfplan`);
  operationInProgress = true;
  try {
    const tfFiles = await fs.readdir(directory).catch(() => []);
    if (!tfFiles.some((name) => name.endsWith(".tf") || name.endsWith(".tf.json"))) {
      return res.status(400).json({ message: "No Terraform configuration files found." });
    }
    await fs.mkdir(planDir, { recursive: true });
    const result = await runTerraform(
      ["plan", "-destroy", "-input=false", "-no-color", `-out=${planFile}`],
      directory
    );
    const output = safeOutput(result);
    destroyPlans.set(planId, { file: planFile, desiredInstances: 0, createdAt: Date.now(), output });
    addOperation({
      id: planId, command: "terraform plan -destroy", status: "AWAITING_APPROVAL",
      createdAt: new Date().toISOString(), output
    });
    return res.json({
      planId, status: "AWAITING_APPROVAL", planOutput: output,
      approvalRequired: true, infrastructureChanged: false,
      expiresAt: new Date(Date.now() + PLAN_EXPIRY_MS).toISOString()
    });
  } catch (error) {
    await fs.rm(planFile, { force: true }).catch(() => {});
    return sendError(res, error, "Terraform destroy plan failed.", { operationId: planId });
  } finally {
    operationInProgress = false;
  }
});

/**
 * POST /api/azure/destroy/approve
 * Requires a valid HttpOnly administrator session and exact DESTROY confirmation.
 */
router.post("/destroy/approve", async (req, res) => {
  if (!requireAuthorization(req, res)) return;
  const parsed = z.object({
    planId: z.string().uuid(),
    approved: z.literal(true),
    confirmation: z.literal("DESTROY")
  }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      message: 'A valid planId, approved:true, and confirmation:"DESTROY" are required.'
    });
  }
  if (operationInProgress) {
    return res.status(409).json({ message: "Another Terraform operation is running." });
  }
  const plan = destroyPlans.get(parsed.data.planId);
  if (!plan) {
    return res.status(404).json({ message: "Destroy plan not found, already used, or expired. Generate a fresh plan." });
  }
  if (Date.now() - plan.createdAt > PLAN_EXPIRY_MS) {
    destroyPlans.delete(parsed.data.planId);
    await fs.rm(plan.file, { force: true }).catch(() => {});
    return res.status(410).json({ message: "Destroy plan expired. Generate and review a new plan." });
  }
  operationInProgress = true;
  try {
    const result = await runTerraform(
      ["apply", "-input=false", "-no-color", "-auto-approve", plan.file],
      configuredDirectory(),
      APPLY_TIMEOUT_MS
    );
    const output = safeOutput(result);
    destroyPlans.delete(parsed.data.planId);
    await fs.rm(plan.file, { force: true }).catch(() => {});
    const operation = {
      id: parsed.data.planId, operationId: parsed.data.planId,
      command: "terraform destroy", status: "SUCCEEDED",
      createdAt: new Date().toISOString(), output, infrastructureChanged: true
    };
    addOperation(operation);
    return res.json({ ...operation, message: "Terraform destroy completed. Verify the Azure resource state." });
  } catch (error) {
    const details = processFailureDetails(error);
    addOperation({
      id: parsed.data.planId, command: "terraform destroy", status: "FAILED",
      createdAt: new Date().toISOString(),
      message: details.err?.message || "Terraform destroy failed.",
      output: redactSecrets(details.output)
    });
    return sendError(res, error, "Terraform destroy failed.", { operationId: parsed.data.planId });
  } finally {
    operationInProgress = false;
  }
});

/**
 * GET /api/azure/operations
 */
router.get("/operations", (_req, res) => {
  return res.json({
    operations,
    logFile: operationLogFile,
    persistent: true
  });
});

/**
 * GET /api/azure/operations/:id
 */
router.get("/operations/:id", (req, res) => {
  const operation = operations.find(
    (item) => item.id === req.params.id
  );

  if (!operation) {
    return res.status(404).json({
      message: "Operation not found in this server's recorded history."
    });
  }

  return res.json(operation);
});

export default router;
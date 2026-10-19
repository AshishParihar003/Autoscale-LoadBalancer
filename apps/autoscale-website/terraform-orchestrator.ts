
import { Router, type Request, type Response } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";

const router = Router();
const runFile = promisify(execFile);

const terraformDir = path.resolve(
  process.env.TERRAFORM_DIR ??
    path.join(process.cwd(), "../../infrastructure/terraform")
);

const planDir = path.join(terraformDir, ".phase2-plans");

type SavedPlan = {
  file: string;
  desiredInstances: number;
  status: "AWAITING_APPROVAL" | "APPLYING" | "SUCCEEDED" | "FAILED";
  output?: string;
  createdAt: string;
};

const plans = new Map<string, SavedPlan>();
const operations = new Map<string, SavedPlan>();

function safeError(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    return String((error as { stderr?: string }).stderr || "Terraform command failed");
  }

  return error instanceof Error ? error.message : "Terraform operation failed";
}

router.post("/plan", async (req: Request, res: Response) => {
  const desiredInstances = req.body?.desiredInstances;

  if (
    !Number.isInteger(desiredInstances) ||
    desiredInstances < 0 ||
    desiredInstances > 10
  ) {
    return res.status(400).json({
      error: "desiredInstances must be an integer between 0 and 10."
    });
  }

  if (!existsSync(path.join(terraformDir, "main.tf"))) {
    return res.status(500).json({
      error: "Terraform configuration was not found.",
      terraformDir
    });
  }

  const planId = randomUUID();
  mkdirSync(planDir, { recursive: true });
  const planFile = path.join(planDir, `${planId}.tfplan`);

  try {
    const { stdout, stderr } = await runFile(
      "terraform",
      [
        `-chdir=${terraformDir}`,
        "plan",
        "-input=false",
        "-no-color",
        `-out=${planFile}`,
        `-var=vm_count=${desiredInstances}`
      ],
      { timeout: 120_000, windowsHide: true, maxBuffer: 5 * 1024 * 1024 }
    );

    plans.set(planId, {
      file: planFile,
      desiredInstances,
      status: "AWAITING_APPROVAL",
      output: `${stdout}\n${stderr}`.trim(),
      createdAt: new Date().toISOString()
    });

    return res.json({
      planId,
      status: "AWAITING_APPROVAL",
      desiredInstances,
      planOutput: `${stdout}\n${stderr}`.trim(),
      approvalRequired: true,
      infrastructureChanged: false
    });
  } catch (error) {
    return res.status(500).json({
      status: "PLAN_FAILED",
      error: safeError(error)
    });
  }
});

router.post("/approve", async (req: Request, res: Response) => {
  const { planId, approved } = req.body ?? {};

  if (approved !== true || typeof planId !== "string") {
    return res.status(400).json({
      error: "Provide a valid planId and explicitly set approved to true."
    });
  }

  const plan = plans.get(planId);

  if (!plan || plan.status !== "AWAITING_APPROVAL") {
    return res.status(404).json({
      error: "Plan not found, already used, or awaiting no approval."
    });
  }

  // Consume the approval before starting, preventing duplicate submissions
  // within this running process.
  plans.delete(planId);
  plan.status = "APPLYING";
  operations.set(planId, plan);

  // Respond immediately; poll the operation endpoint for the final result.
  res.status(202).json({
    operationId: planId,
    status: "APPLYING"
  });

  try {
    const { stdout, stderr } = await runFile(
      "terraform",
      [
        `-chdir=${terraformDir}`,
        "apply",
        "-input=false",
        "-no-color",
        plan.file
      ],
      { timeout: 600_000, windowsHide: true, maxBuffer: 5 * 1024 * 1024 }
    );

    plan.status = "SUCCEEDED";
    plan.output = `${stdout}\n${stderr}`.trim();
  } catch (error) {
    plan.status = "FAILED";
    plan.output = safeError(error);
  }
});



router.get("/operations/:id", (req: Request, res: Response) => {
  const operationId = req.params.id;

  if (typeof operationId !== "string") {
    return res.status(400).json({
      error: "Invalid operation ID."
    });
  }

  const operation = operations.get(operationId);

  if (!operation) {
    return res.status(404).json({
      error: "Operation not found."
    });
  }

  return res.json({
    operationId,
    status: operation.status,
    desiredInstances: operation.desiredInstances,
    output: operation.output,
    createdAt: operation.createdAt
  });
});


export default router;

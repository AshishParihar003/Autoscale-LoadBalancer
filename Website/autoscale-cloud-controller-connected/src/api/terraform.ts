import { apiRequest } from "../api";

/**
 * AutoScale Cloud Controller V2.0 API contracts.
 *
 * Privileged operations rely on authenticated same-origin server sessions.
 * The browser must never collect or send ADMIN_TOKEN or SSH private keys.
 *
 * The backend must implement the corresponding session-authenticated routes
 * before Apply or Destroy can work. This file alone does not implement auth
 * or provisioning.
 */

export type ScalingMode = "automatic" | "manual";
export type InfrastructureTarget = "azure-vms" | "docker-containers";

export type TerraformPlanResponse = {
  planId: string;
  status: "AWAITING_APPROVAL";
  desiredInstances: number;
  planOutput: string;
  approvalRequired: boolean;
  infrastructureChanged: false;
  expiresAt?: string;
};

export type TerraformOperationResponse = {
  operationId?: string;
  id?: string;
  status: string;
  message?: string;
  output?: string;
  terraformStatus?: string;
  infrastructureChanged?: boolean;
  ansible?: {
    status: string;
    message?: string;
    output?: string;
  };
};

export type ScalingConfiguration = {
  mode: ScalingMode;
  target: InfrastructureTarget;
  requestsPerVm: number;
  minInstances: number;
  maxInstances: number;
  enabled: boolean;
};

export type ScalingConfigurationResponse = {
  config: ScalingConfiguration;
  message?: string;
};

export type ScalingDecision = {
  action: "scale-out" | "scale-in" | "no-change";
  currentInstances: number;
  desiredInstances: number;
  requestsPerMinute: number;
  requestsPerVm: number;
  mode: ScalingMode;
  reason: string;
  approvalRequired: boolean;
  planId?: string;
};

export type ScalingStatusResponse = {
  enabled: boolean;
  mode: ScalingMode;
  requestsPerVm: number;
  minInstances: number;
  maxInstances: number;
  currentInstances: number;
  desiredInstances: number;
  requestsPerMinute: number;
  lastDecision?: ScalingDecision;
  message?: string;
};

export type DestroyPlanResponse = {
  planId: string;
  status: "AWAITING_APPROVAL";
  resourcesToDestroy?: number;
  planOutput: string;
  approvalRequired: true;
  warning: string;
  expiresAt?: string;
};

const MAX_INSTANCES = 5;

/** Create a saved Terraform plan only. This must not apply infrastructure. */
export async function createTerraformPlan(
  desiredInstances: number
): Promise<TerraformPlanResponse> {
  validateInstanceCount(desiredInstances);

  try {
    const result = await apiRequest<TerraformPlanResponse>("/api/azure/plan", {
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({ desiredInstances }),
    });

    console.info("[AutoScale][Terraform] Plan created", {
      planId: result.planId,
      desiredInstances: result.desiredInstances,
      approvalRequired: result.approvalRequired,
    });

    return result;
  } catch (error) {
    logApiError("createTerraformPlan", error);
    throw error;
  }
}

/**
 * Apply the exact saved plan after explicit user approval.
 * The server must independently validate the authenticated session, plan
 * ownership/validity, expiry, operation lock, and confirmation phrase.
 */
export async function approveTerraformPlan(
  planId: string,
  confirmation: string
): Promise<TerraformOperationResponse> {
  validatePlanId(planId, "Terraform");
  if (confirmation !== "APPLY") {
    throw new Error('Type "APPLY" to confirm this infrastructure change.');
  }

  try {
    const result = await apiRequest<TerraformOperationResponse>(
      "/api/azure/approve",
      {
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ planId, approved: true, confirmation }),
      }
    );

    console.info("[AutoScale][Terraform] Apply response received", {
      planId,
      operationId: result.operationId ?? result.id,
      status: result.status,
    });

    return result;
  } catch (error) {
    logApiError("approveTerraformPlan", error);
    throw error;
  }
}

/** Create a destroy preview only. No resources should be destroyed here. */
export async function createTerraformDestroyPlan(): Promise<DestroyPlanResponse> {
  try {
    return await apiRequest<DestroyPlanResponse>("/api/azure/destroy/plan", {
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({}),
    });
  } catch (error) {
    logApiError("createTerraformDestroyPlan", error);
    throw error;
  }
}

/** Destroy only the exact saved destroy plan after explicit approval. */
export async function approveTerraformDestroy(
  planId: string,
  confirmation: string
): Promise<TerraformOperationResponse> {
  validatePlanId(planId, "Destroy");
  if (confirmation !== "DESTROY") {
    throw new Error('Type "DESTROY" to confirm infrastructure removal.');
  }

  try {
    return await apiRequest<TerraformOperationResponse>(
      "/api/azure/destroy/approve",
      {
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ planId, approved: true, confirmation }),
      }
    );
  } catch (error) {
    logApiError("approveTerraformDestroy", error);
    throw error;
  }
}

export async function updateScalingConfiguration(
  config: ScalingConfiguration
): Promise<ScalingConfigurationResponse> {
  validateScalingConfiguration(config);

  try {
    return await apiRequest<ScalingConfigurationResponse>(
      "/api/controller/scaling/config",
      {
        method: "PUT",
        credentials: "same-origin",
        body: JSON.stringify(config),
      }
    );
  } catch (error) {
    logApiError("updateScalingConfiguration", error);
    throw error;
  }
}

export async function getScalingStatus(): Promise<ScalingStatusResponse> {
  try {
    return await apiRequest<ScalingStatusResponse>(
      "/api/controller/scaling/status",
      { credentials: "same-origin" }
    );
  } catch (error) {
    logApiError("getScalingStatus", error);
    throw error;
  }
}

export async function evaluateScaling(): Promise<ScalingDecision> {
  try {
    return await apiRequest<ScalingDecision>(
      "/api/controller/scaling/evaluate",
      {
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({}),
      }
    );
  } catch (error) {
    logApiError("evaluateScaling", error);
    throw error;
  }
}

function validatePlanId(planId: string, operation: string): void {
  if (typeof planId !== "string" || !planId.trim()) {
    throw new Error(`A valid ${operation.toLowerCase()} plan ID is required.`);
  }
}

function validateInstanceCount(count: number): void {
  if (!Number.isInteger(count) || count < 0 || count > MAX_INSTANCES) {
    throw new Error(
      `Instance count must be an integer between 0 and ${MAX_INSTANCES}.`
    );
  }
}

function validateScalingConfiguration(config: ScalingConfiguration): void {
  if (!config || (config.mode !== "automatic" && config.mode !== "manual")) {
    throw new Error("Scaling mode must be automatic or manual.");
  }

  if (config.target !== "azure-vms" && config.target !== "docker-containers") {
    throw new Error("Unsupported infrastructure target.");
  }

  if (!Number.isInteger(config.requestsPerVm) || config.requestsPerVm < 1) {
    throw new Error("Requests per VM must be a positive integer.");
  }

  if (!Number.isInteger(config.minInstances) || config.minInstances < 0) {
    throw new Error("Minimum instances must be a non-negative integer.");
  }

  if (
    !Number.isInteger(config.maxInstances) ||
    config.maxInstances < 1 ||
    config.maxInstances > MAX_INSTANCES
  ) {
    throw new Error(`Maximum instances must be between 1 and ${MAX_INSTANCES}.`);
  }

  if (config.minInstances > config.maxInstances) {
    throw new Error("Minimum instances cannot exceed maximum instances.");
  }

  if (typeof config.enabled !== "boolean") {
    throw new Error("Scaling enabled must be true or false.");
  }
}

function logApiError(operation: string, error: unknown): void {
  // Never log cookies, authorization values, private keys, or request bodies.
  console.error(`[AutoScale][API] ${operation} failed`, {
    message: error instanceof Error ? error.message : "Unknown API error",
  });
}

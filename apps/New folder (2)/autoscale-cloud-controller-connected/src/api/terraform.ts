import { apiRequest } from "../api";

export type TerraformPlanResponse = {
  planId: string;
  status: "AWAITING_APPROVAL";
  desiredInstances: number;
  planOutput: string;
  approvalRequired: boolean;
  infrastructureChanged: boolean;
};

export function createTerraformPlan(desiredInstances: number): Promise<TerraformPlanResponse> {
  return apiRequest<TerraformPlanResponse>("/api/azure/plan", {
    method: "POST",
    body: JSON.stringify({ desiredInstances })
  });
}

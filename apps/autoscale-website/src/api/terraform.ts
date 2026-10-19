
export type TerraformPlanResponse = {
  planId: string;
  status: "AWAITING_APPROVAL";
  desiredInstances: number;
  planOutput: string;
  approvalRequired: boolean;
  infrastructureChanged: boolean;
};

export async function createTerraformPlan(
  desiredInstances: number
): Promise<TerraformPlanResponse> {
  const response = await fetch(
    "http://localhost:4000/api/azure/plan",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ desiredInstances }),
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      result.error || "Failed to generate Terraform plan"
    );
  }

  return result as TerraformPlanResponse;
}

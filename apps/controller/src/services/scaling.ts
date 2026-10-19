
export interface ScalingConfig {
  targetRequestsPerMinute: number;
  requestsPerMinutePerVm: number;
  minVms: number;
  maxVms: number;
}

export interface ScalingEstimate {
  targetRequestsPerMinute: number;
  requestsPerMinutePerVm: number;
  desiredVmCount: number;
  estimatedCapacity: number;
  capacityUtilizationPercent: number;
}

export function estimateCapacity(
  config: ScalingConfig
): ScalingEstimate {
  const {
    targetRequestsPerMinute,
    requestsPerMinutePerVm,
    minVms,
    maxVms,
  } = config;

  if (!Number.isFinite(targetRequestsPerMinute) ||
      targetRequestsPerMinute < 0) {
    throw new Error("Target traffic must be a non-negative number.");
  }

  if (!Number.isFinite(requestsPerMinutePerVm) ||
      requestsPerMinutePerVm <= 0) {
    throw new Error("Per-VM capacity must be greater than zero.");
  }

  if (!Number.isInteger(minVms) ||
      !Number.isInteger(maxVms) ||
      minVms < 0 ||
      maxVms < minVms) {
    throw new Error("Invalid minimum or maximum VM configuration.");
  }

  const requiredVms =
    targetRequestsPerMinute === 0
      ? 0
      : Math.ceil(
          targetRequestsPerMinute / requestsPerMinutePerVm
        );

  if (requiredVms > maxVms) {
    throw new Error(
      `Workload requires ${requiredVms} VMs, but the maximum is ${maxVms}.`
    );
  }

  const desiredVmCount = Math.max(minVms, requiredVms);
  const estimatedCapacity =
    desiredVmCount * requestsPerMinutePerVm;

  const capacityUtilizationPercent =
    estimatedCapacity === 0
      ? 0
      : (targetRequestsPerMinute / estimatedCapacity) * 100;

  return {
    targetRequestsPerMinute,
    requestsPerMinutePerVm,
    desiredVmCount,
    estimatedCapacity,
    capacityUtilizationPercent: Number(
      capacityUtilizationPercent.toFixed(2)
    ),
  };
}





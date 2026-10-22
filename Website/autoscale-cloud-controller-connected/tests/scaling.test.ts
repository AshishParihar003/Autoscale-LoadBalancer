import test from "node:test";
import assert from "node:assert/strict";
import { estimateCapacity } from "../server/scaling.js";

test("capacity estimate returns zero instances for zero workload", () => {
  const result = estimateCapacity({
    targetRequestsPerMinute: 0,
    requestsPerMinutePerVm: 500,
    minVms: 0,
    maxVms: 5
  });
  assert.equal(result.desiredVmCount, 0);
  assert.equal(result.estimatedCapacity, 0);
});

test("capacity estimate rounds up to cover workload", () => {
  const result = estimateCapacity({
    targetRequestsPerMinute: 501,
    requestsPerMinutePerVm: 500,
    minVms: 0,
    maxVms: 5
  });
  assert.equal(result.desiredVmCount, 2);
  assert.equal(result.estimatedCapacity, 1000);
});

test("capacity estimate rejects workload above max capacity", () => {
  assert.throws(() => estimateCapacity({
    targetRequestsPerMinute: 2501,
    requestsPerMinutePerVm: 500,
    minVms: 0,
    maxVms: 5
  }), /maximum is 5/);
});

test("capacity estimate enforces minimum instances", () => {
  const result = estimateCapacity({
    targetRequestsPerMinute: 1,
    requestsPerMinutePerVm: 500,
    minVms: 2,
    maxVms: 5
  });
  assert.equal(result.desiredVmCount, 2);
});

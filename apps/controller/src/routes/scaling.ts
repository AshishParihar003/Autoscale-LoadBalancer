
import { Router } from "express";
import { z } from "zod";
import { estimateCapacity } from "../services/scaling.js";

const router = Router();

const scalingSchema = z.object({
  targetRequestsPerMinute: z.number().finite().nonnegative(),
});

router.post("/estimate", (req, res) => {
  const validation = scalingSchema.safeParse(req.body);

  if (!validation.success) {
    return res.status(400).json({
      error: "Invalid scaling request",
      details: validation.error.issues,
    });
  }

  try {
    const estimate = estimateCapacity({
      targetRequestsPerMinute:
        validation.data.targetRequestsPerMinute,
      requestsPerMinutePerVm: 500,
      minVms: 0,
      maxVms: 5,
    });

    return res.json({
      success: true,
      estimate,
      approvalRequired: true,
      infrastructureChanged: false,
    });
  } catch (error) {
    return res.status(400).json({
      error:
        error instanceof Error
          ? error.message
          : "Unable to estimate capacity",
    });
  }
});

export default router;

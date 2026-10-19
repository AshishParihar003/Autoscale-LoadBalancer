
import { Router } from "express";

const router = Router();

router.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "autoscale-controller",
    timestamp: new Date().toISOString()
  });
});

export default router;


// Load environment variables from .env.
import "dotenv/config";

import express, { type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { estimateCapacity } from "./scaling.js";
import terraformOrchestrator from "../terraform-orchestrator.js";

// ------------------------------------------------------
// 1. TYPES
// ------------------------------------------------------

// Infrastructure target supported by the dashboard.
type Target = "azure-vms" | "docker-containers";

// Represents an instance in the LOCAL SIMULATION.
// These are not real Azure virtual machines.
type Instance = {
  id: string;
  name: string;
  status: string;
  publicIp?: string;
  cpuPercent?: number;
  memoryPercent?: number;
};

// One point in the dashboard's resource history chart.
type HistoryPoint = {
  time: string;
  requests: number;
  cpu: number;
  memory: number;
  instances: number;
};

// A simulated scaling plan.
type Plan = {
  planId: string;
  target: Target;
  targetTraffic: number;
  currentInstances: number;
  requiredInstances: number;
  action: string;
  warnings: string[];
  createdAt: string;
};

// Result of a simulated scaling operation.
type Operation = {
  operationId: string;
  status: string;
  message: string;
  createdAt: string;
};

// ------------------------------------------------------
// 2. EXPRESS APPLICATION
// ------------------------------------------------------

const app = express();

// Parse incoming JSON request bodies.
app.use(express.json({ limit: "1mb" }));

// ------------------------------------------------------
// 3. SIMULATION CONFIGURATION
// ------------------------------------------------------

// IMPORTANT:
// These settings belong to the local simulation.
// Changing activeInstances does not create or delete Azure VMs.

const MAX_INSTANCES = 5;

// Assumed capacity per VM for demonstration purposes.
// This is an estimate, not a measured production capacity.
const REQUESTS_PER_VM = 500;

// Current simulated controller state.
let target: Target = "azure-vms";
let trafficTarget = 0;
let desiredInstances = 1;
let activeInstances = 1;
let latestOperation: Operation | null = null;

// These Maps exist only in memory.
// Plans disappear when the backend restarts.
const plans = new Map<string, Plan>();

// Stores recent simulated metrics for the dashboard.
const history: HistoryPoint[] = [];

const startedAt = Date.now();

// ------------------------------------------------------
// 4. SIMULATED INSTANCE GENERATOR
// ------------------------------------------------------

// Creates fake instance records for the dashboard.
// This function does not query Azure or Docker.
function instances(): Instance[] {
  return Array.from({ length: activeInstances }, (_, index) => ({
    id: `local-instance-${index + 1}`,
    name: `demo-instance-${index + 1}`,
    status: "running",
    publicIp: "Local simulation",

    // Estimate CPU usage using the configured traffic.
    cpuPercent: Math.min(
      95,
      Math.round(
        (trafficTarget /
          Math.max(1, activeInstances * REQUESTS_PER_VM)) *
          75
      )
    ),

    // Estimate memory usage for demonstration purposes.
    memoryPercent: Math.min(
      90,
      Math.round(
        (trafficTarget /
          Math.max(1, activeInstances * REQUESTS_PER_VM)) *
          60
      )
    ),
  }));
}

// ------------------------------------------------------
// 5. DASHBOARD STATE SNAPSHOT
// ------------------------------------------------------

// Returns the current simulation state to the frontend.
// The frontend polls GET /api/controller/state.
function snapshot() {
  const cpuPercent =
    activeInstances === 0
      ? 0
      : Math.min(
          95,
          Math.round(
            (trafficTarget /
              Math.max(1, activeInstances * REQUESTS_PER_VM)) *
              75
          )
        );

  const memoryPercent =
    activeInstances === 0
      ? 0
      : Math.min(
          90,
          Math.round(
            (trafficTarget /
              Math.max(1, activeInstances * REQUESTS_PER_VM)) *
              60
          )
        );

  const now = new Date();

  // Create a new history sample.
  const point: HistoryPoint = {
    time: now.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
    requests: trafficTarget,
    cpu: cpuPercent,
    memory: memoryPercent,
    instances: activeInstances,
  };

  // Keep at most one sample for each displayed timestamp.
  if (!history.length || history[history.length - 1].time !== point.time) {
    history.push(point);
  }

  // Keep only the latest 30 history points.
  while (history.length > 30) {
    history.shift();
  }

  return {
    application: {
      name: "Sample Web Application",
      url: "http://localhost:4000/demo",
      status: activeInstances > 0 ? "running" : "stopped",
      health: activeInstances > 0 ? "healthy" : "unknown",
    },

    metrics: {
      requestsPerMinute: trafficTarget,
      cpuPercent,
      memoryPercent,
      healthyInstances: activeInstances,
      desiredInstances,
      activeInstances,
      timestamp: now.toISOString(),
    },

    infrastructure: {
      target,
      instances: instances(),
    },

    history,

    // Explicitly identify these metrics as simulated.
    mode: "simulation",

    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    latestOperation,
  };
}

// ------------------------------------------------------
// 6. TERRAFORM ROUTES
// ------------------------------------------------------

// Mount the separate Terraform orchestrator.
//
// Example routes, based on the existing orchestrator:
// POST /api/azure/plan
// POST /api/azure/approve
// GET  /api/azure/operations/:id
//
// These routes are separate from /api/controller/plan
// and /api/controller/execute.
//
// IMPORTANT:
// Mounting the router does not prove Azure credentials
// are valid or that Terraform apply will succeed.
// The orchestrator must implement those operations.
app.use("/api/azure", terraformOrchestrator);

// ------------------------------------------------------
// 7. HEALTH CHECK
// ------------------------------------------------------

// Reports that the local controller process is responding.
// This does not verify Azure connectivity.
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "autoscale-controller",
    mode: "simulation",
    terraformRoutesMounted: true,
    timestamp: new Date().toISOString(),
  });
});

// ------------------------------------------------------
// 8. CONTROLLER STATE API
// ------------------------------------------------------

// Returns simulated metrics and instance information.
app.get("/api/controller/state", (_req, res) => {
  res.json(snapshot());
});

// ------------------------------------------------------
// 9. CAPACITY ESTIMATION API
// ------------------------------------------------------

// Calculates an estimated VM count from the target traffic.
// It does not create or modify infrastructure.
app.post("/api/scaling/estimate", (req, res) => {
  const parsed = z
    .object({
      targetRequestsPerMinute: z.number().finite().min(0).max(1_000_000),
    })
    .safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid scaling request",
      details: parsed.error.issues,
    });
  }

  try {
    const estimate = estimateCapacity({
      targetRequestsPerMinute: parsed.data.targetRequestsPerMinute,
      requestsPerMinutePerVm: REQUESTS_PER_VM,
      minVms: 0,
      maxVms: MAX_INSTANCES,
    });

    return res.json({
      success: true,
      estimate,
      approvalRequired: true,
      infrastructureChanged: false,
      mode: "simulation",
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

// ------------------------------------------------------
// 10. SIMULATED TRAFFIC API
// ------------------------------------------------------

// Updates the simulated traffic number.
// This does NOT send real HTTP requests to the demo website.
app.post("/api/controller/traffic", (req, res) => {
  const schema = z.object({
    requestsPerMinute: z.number().finite().min(0).max(1_000_000),
  });

  const parsed = schema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      message:
        "requestsPerMinute must be between 0 and 1,000,000.",
    });
  }

  trafficTarget = parsed.data.requestsPerMinute;

  return res.json({
    success: true,
    requestsPerMinute: trafficTarget,
    mode: "simulation",
    message:
      `Simulation traffic target set to ` +
      `${trafficTarget.toLocaleString()} requests/min. ` +
      "No real HTTP load was generated.",
  });
});

// ------------------------------------------------------
// 11. SIMULATED SCALING PLAN
// ------------------------------------------------------

// Creates a plan for the local simulation.
//
// This is NOT the Terraform plan endpoint.
// For Terraform planning, use POST /api/azure/plan.
app.post("/api/controller/plan", (req, res) => {
  const schema = z.object({
    target: z
      .enum(["azure-vms", "docker-containers"])
      .default("azure-vms"),

    targetTraffic: z.number().finite().min(0).max(1_000_000),

    desiredInstances: z
      .number()
      .int()
      .min(0)
      .max(MAX_INSTANCES)
      .nullable()
      .optional(),

    approvalRequired: z.boolean().optional(),
  });

  const parsed = schema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      message:
        `Invalid scaling plan. Local simulation supports ` +
        `0-${MAX_INSTANCES} instances and traffic up to ` +
        "1,000,000 requests/min.",
    });
  }

  const data = parsed.data;

  const estimate = estimateCapacity({
    targetRequestsPerMinute: data.targetTraffic,
    requestsPerMinutePerVm: REQUESTS_PER_VM,
    minVms: 0,
    maxVms: MAX_INSTANCES,
  });

  // Use a manual override if provided.
  // Otherwise use the estimated capacity.
  const requiredInstances =
    data.desiredInstances == null
      ? estimate.desiredVmCount
      : data.desiredInstances;

  target = data.target;

  const plan: Plan = {
    planId: randomUUID(),
    target,
    targetTraffic: data.targetTraffic,
    currentInstances: activeInstances,
    requiredInstances,

    action:
      requiredInstances > activeInstances
        ? "Scale out"
        : requiredInstances < activeInstances
          ? requiredInstances === 0
            ? "Scale to zero"
            : "Scale in"
          : "No capacity change",

    warnings: [
      "SIMULATION ONLY: this plan changes in-memory demo state, not Azure or Docker infrastructure.",
      ...(requiredInstances === 0
        ? ["Zero instances makes the demo website unavailable."]
        : []),
    ],

    createdAt: new Date().toISOString(),
  };

  // Save the simulated plan until it is executed or the
  // server restarts.
  plans.set(plan.planId, plan);

  return res.json({
    ...plan,
    mode: "simulation",
    approvalRequired: true,
    infrastructureChanged: false,
  });
});

// ------------------------------------------------------
// 12. SIMULATED PLAN EXECUTION
// ------------------------------------------------------

// This endpoint changes only the in-memory simulation.
// It does NOT run Terraform apply.
//
// Do not connect a real Azure approval button to this
// endpoint and label the result as real provisioning.
app.post("/api/controller/execute", (req, res) => {
  const parsed = z
    .object({
      planId: z.string().uuid(),
    })
    .safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      message: "A valid planId is required.",
    });
  }

  const plan = plans.get(parsed.data.planId);

  if (!plan) {
    return res.status(404).json({
      message: "Plan not found or expired. Create a new plan.",
    });
  }

  // Update the fake instance count.
  activeInstances = plan.requiredInstances;
  desiredInstances = plan.requiredInstances;
  trafficTarget = plan.targetTraffic;

  // Mark the result clearly as simulated.
  latestOperation = {
    operationId: randomUUID(),
    status: "SUCCEEDED_SIMULATED",
    message:
      `Simulation updated capacity from ${plan.currentInstances} ` +
      `to ${plan.requiredInstances} instance(s). ` +
      "No cloud resources were changed.",
    createdAt: new Date().toISOString(),
  };

  plans.delete(plan.planId);

  return res.json({
    ...latestOperation,
    mode: "simulation",
    infrastructureChanged: false,
  });
});

// ------------------------------------------------------
// 13. SIMULATION CONFIGURATION
// ------------------------------------------------------

// Changes the simulation's selected infrastructure target.
// This does not configure Azure or Docker itself.
app.patch("/api/controller/config", (req, res) => {
  const parsed = z
    .object({
      target: z.enum(["azure-vms", "docker-containers"]),
    })
    .safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      message: "target must be azure-vms or docker-containers.",
    });
  }

  target = parsed.data.target;

  return res.json({
    success: true,
    target,
    mode: "simulation",
    infrastructureChanged: false,
  });
});

// ------------------------------------------------------
// 14. LOCAL DEMO WEBSITE
// ------------------------------------------------------

// Serves a small sample website for local development.
// This page is not deployed to Azure by this endpoint.
app.get("/demo", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width">
  <title>Demo Website</title>
  <style>
    body {
      font: 16px system-ui;
      max-width: 720px;
      margin: 10vh auto;
      padding: 24px;
      background: #0b1220;
      color: #e5edf9;
    }
    main {
      border: 1px solid #334155;
      border-radius: 16px;
      padding: 28px;
    }
    h1 { color: #8eb0ff; }
  </style>
</head>
<body>
  <main>
    <h1>Sample Web Application</h1>
    <p>The AutoScale Cloud Controller demo website is running.</p>
    <p>Current mode: local simulation.</p>
    <p>This page is not deployed to Azure.</p>
  </main>
</body>
</html>`);
});

// ------------------------------------------------------
// 15. SERVE THE BUILT FRONTEND
// ------------------------------------------------------

// Resolve the directory containing this server file.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Vite's built frontend is expected in this dist directory.
const distPath = path.resolve(__dirname, "../../dist");

app.use(express.static(distPath));

// For non-API routes, return the React application's index.html.
// API requests that do not match a route receive a JSON 404.
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path === "/health") {
    return res.status(404).json({
      message: "API route not found.",
    });
  }

  return res.sendFile(
    path.join(distPath, "index.html"),
    (error) => {
      if (error) next(error);
    }
  );
});

// ------------------------------------------------------
// 16. START SERVER
// ------------------------------------------------------

const port = Number(process.env.PORT ?? 4000);

app.listen(port, () => {
  console.log(
    `AutoScale Cloud Controller listening on http://localhost:${port}`
  );

  console.log("Controller metrics mode: LOCAL SIMULATION");
  console.log("Terraform router mounted at: /api/azure");
  console.log(
    "NOTE: Router registration does not mean Azure provisioning has been tested."
  );
});

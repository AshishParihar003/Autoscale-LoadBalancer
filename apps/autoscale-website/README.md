# AutoScale Cloud Controller — Unified Local App

This folder combines the supplied React/Vite dashboard and Express/TypeScript controller into one project.

## What works in this version

- One Node.js project and one origin.
- React/Vite dashboard.
- Express serves API routes and the production frontend build.
- `GET /health`
- `GET /api/controller/state`
- `POST /api/controller/traffic`
- `POST /api/scaling/estimate`
- `POST /api/controller/plan`
- `POST /api/controller/execute`
- `PATCH /api/controller/config`
- `GET /demo`
- Approval flow and in-memory capacity simulation.
- Vite development proxy routes `/api` and `/health` to the backend.

## Important: current execution mode

This version is **LOCAL SIMULATION ONLY**. Approving a plan updates in-memory state so we can test the UI/API flow. It does **not** create Azure VMs, run Terraform, execute Ansible, generate real HTTP load, or deploy the demo website to Azure. The `/demo` page is served by the local controller.

The real Azure adapter and Terraform/Ansible orchestration will be connected after the local end-to-end flow is verified. Do not interpret `SUCCEEDED_SIMULATED` as a real cloud deployment.

## Requirements

- Node.js 20 or newer
- npm

## Run locally

From this folder:

```powershell
npm install
npm run dev
```

Open the Vite URL shown in the terminal (normally `http://localhost:5173`).

The development command starts:
- Express API on `http://localhost:4000`
- Vite frontend on `http://localhost:5173`

Vite proxies API calls to Express. Keep both processes running in this development mode.

## Build and run as one service

```powershell
npm run build
npm start
```

Then open `http://localhost:4000`.

Express serves the built frontend and the API from the same port. This is the intended shape for a single-service deployment.

## Test endpoints

```powershell
curl.exe http://localhost:4000/health
curl.exe http://localhost:4000/api/controller/state
curl.exe -X POST http://localhost:4000/api/scaling/estimate -H "Content-Type: application/json" -d "{\"targetRequestsPerMinute\":1000}"
```

## Capacity simulation limits

- Max instances: 5
- Estimated capacity per instance: 500 requests/min
- State is in memory and resets when the server restarts.
- This is for safe integration testing only.

## Next integration stages

1. Verify UI/API flow locally.
2. Add durable operation state and structured logs.
3. Connect Terraform/ Azure VM Scale Set capacity through a secured Azure identity.
4. Establish secure instance management for Ansible; do not expose SSH broadly.
5. Configure, deploy and health-check the demo website.
6. Run one short approved Azure test and destroy resources afterward.

# AutoScale Cloud Controller — Frontend

A React + Vite + TypeScript dashboard using plain CSS. It is designed to become the control surface for a real workload-monitoring and infrastructure-scaling backend.

## Included

- Single sample application status card
- VM / Docker scaling target selector
- Current capacity and desired capacity view
- Workload and health charts (illustrative until a backend is connected)
- Scale-out recommendation with explicit approval action
- Scale-in policy and zero-workload policy controls
- Activity log and API connection status
- Firebase Hosting configuration
- API client scaffold via `VITE_API_BASE_URL`

## Important: real infrastructure is not connected yet

The frontend does not create or delete Azure VMs or Docker containers by itself. Approval buttons currently demonstrate the UI flow and create local activity entries only. Connect the API methods in `src/api.ts` to a secured backend before enabling real provisioning.

The frontend is intentionally not responsible for holding Azure credentials or running Terraform. The backend should authenticate the user, collect real metrics, calculate scaling decisions, and trigger controlled Azure DevOps/Terraform operations.

## Requirements

- Node.js 20 or newer (Node 22 LTS is suitable)
- npm
- Firebase CLI is included as a dev dependency

## Run locally

```bash
npm install
npm run dev
```

Open the local URL printed by Vite.

## Build

```bash
npm run build
npm run preview
```

## Deploy to Firebase Hosting

1. Create/select a Firebase project in the Firebase Console.
2. Copy `.firebaserc.example` to `.firebaserc` and replace `YOUR_FIREBASE_PROJECT_ID`.
3. Sign in:

```bash
npx firebase login
```

4. Build and deploy:

```bash
npm run deploy
```

Firebase Hosting serves the dashboard only. It does not run the autoscaling controller or host the VM-backed sample application.

## Backend contract to implement

Suggested first endpoints:

- `GET /api/overview` — app status, workload, metrics, current and desired capacity
- `GET /api/metrics?window=1h` — real metric series for charts
- `GET /api/instances` — managed instances and health
- `POST /api/scaling/plan` — calculate a proposed change
- `POST /api/scaling/approve` — approve a specific plan
- `POST /api/scaling/policy` — update min/max/cooldown and scale-in settings
- `GET /api/activity` — audit/activity history

Protect these endpoints with authentication and authorization. Never expose Azure credentials, Terraform state, or privileged deployment tokens in frontend code.

## Suggested implementation order

1. Deploy this frontend to Firebase Hosting.
2. Build the Node.js/Express API and connect `src/api.ts`.
3. Deploy the sample app to Azure VM-backed infrastructure.
4. Add real metrics and a workload generator.
5. Add approval-gated scale-out and safe scale-in through Azure DevOps + Terraform.
6. Add Docker target after VM scaling is reliable.

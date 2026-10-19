# AutoScale Cloud Controller

A React/Vite dashboard served by a single Express/Node.js server in production. The dashboard includes the existing workload/controller simulation plus a Terraform diagnostics and plan-review page.

## Important distinction

- The controller metrics and demo scaling flow in the Overview page are **local simulation data**. They do not create/delete Azure VMs.
- The Terraform page invokes the real Terraform CLI against `TERRAFORM_PROJECT_DIR`.
- `terraform plan` only previews changes.
- `terraform apply` is available only through the explicit approval endpoint and only when `ADMIN_TOKEN` is configured.
- The uploaded source archives did not contain the original Terraform `.tf` files or the previous `terraform-orchestrator.ts`. A new orchestrator was added, but you must point it at your actual Terraform configuration to run real plans.

## Requirements

- Node.js 20+ recommended
- npm
- Terraform CLI installed and available on PATH, or set `TERRAFORM_BIN`
- Azure authentication configured for the Terraform provider only when running Azure provider operations

## Install

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env` and set `TERRAFORM_PROJECT_DIR` to the directory containing your actual `.tf` files. If left blank, the server looks at `infrastructure/terraform` relative to the app working directory.

The default desired instance variable is `vm_count`; change `TERRAFORM_INSTANCE_VARIABLE` if your Terraform configuration uses a different variable name. When started from the app directory, the server now checks both the app-local Terraform folder and the repository's `../../infrastructure/terraform` folder and prefers the one that contains `.tf` files.

## Run in development

Open a terminal and run:

```powershell
npm run dev
```

The Vite UI runs on `http://127.0.0.1:5173` and proxies `/api` requests to Express on port 4000. This is development-only.

## Build and run with one server

```powershell
npm run build
npm start
```

Open `http://localhost:4000`. Express serves the built frontend and the API from the same origin.

## Terraform diagnostics workflow

1. Open **Terraform** in the sidebar.
2. Run diagnostics and check CLI/configuration/provider-init status.
3. Run `Terraform init`.
4. Run validation.
5. Generate a plan for a desired instance count from 0 to 10.
6. Inspect the plan output before taking any action.

### Explicit apply approval

To enable apply, set a strong `ADMIN_TOKEN` in the server environment. The browser sends it to `POST /api/azure/approve` via the `x-admin-token` header. The endpoint only accepts a known, unexpired plan ID and applies the saved plan file, not a newly generated plan. Plans are kept in memory and expire after 15 minutes; restarting the server invalidates them.

Do not enable apply on a publicly accessible HTTP server. Use authentication, HTTPS, network restrictions, and a least-privilege Azure identity before any deployment.

## API endpoints

- `GET /api/health`
- `GET /api/controller/state`
- `POST /api/controller/traffic` — simulation only
- `POST /api/controller/plan` — simulation only
- `POST /api/controller/execute` — simulation only
- `GET /api/azure/status`
- `GET /api/azure/version`
- `GET /api/azure/diagnostics`
- `POST /api/azure/init`
- `POST /api/azure/fmt-check`
- `POST /api/azure/validate`
- `POST /api/azure/plan`
- `POST /api/azure/approve` — protected; can change cloud resources and runs Ansible afterward when configured
- `GET /api/azure/operations`
- `GET /api/azure/operations/:id`

## Tests

```powershell
npm run typecheck
npm test
npm run build
```

Terraform commands and Azure provider behavior depend on the local machine's installed CLI, configuration, network, and credentials. Automated scaling tests do not create Azure resources.

## Security and limitations

- Never commit `.env`, Terraform state, plan files, keys, or credentials.
- The controller's demo metrics and traffic charts are intentionally marked simulation; they are not live Azure telemetry. See `docs/INTEGRATION_STATUS.md` for what was connected and what still needs the actual Terraform/Ansible files.
- Real VM provisioning is performed by Terraform only after explicit approval. Ansible runs afterward only when a playbook and inventory are configured.
- Operation history and pending plans are in memory; restarting the server clears them.
- The server has no full user account system. The apply endpoint uses a server-side token, which is not a substitute for a full production identity system.
- Review every plan. No apply or destroy command is run automatically.

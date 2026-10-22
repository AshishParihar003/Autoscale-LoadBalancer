# Test report for the connected Terraform/Ansible integration

## Checks performed in the editing environment

- TypeScript/TSX syntax transpilation: PASS for all `.ts` and `.tsx` source files.
- Full TypeScript type-check: NOT RUN successfully; dependencies and `@types/node` are not installed in this environment.
- Frontend production build: NOT RUN successfully; React/Vite dependencies are not installed in this environment.
- Automated unit tests: NOT RUN; the `tsx` test runner is not installed in this environment.
- Terraform CLI/Azure plan/apply: NOT RUN. No Azure resources were created or modified.
- Ansible playbook run: NOT RUN. The uploaded source archive did not include the actual playbook or inventory.

## Important local verification steps

From the app directory, run:

```powershell
npm install
npm run typecheck
npm test
npm run build
npm start
```

Then open `http://localhost:4000`, visit **Terraform**, run diagnostics, and check the configured project directory. Verify that it points to the repository's `infrastructure/terraform` folder and that the expected `.tf` files appear. Run `terraform init`, validation, and a plan for `2 VMs`. Review the plan before approving it.

Only configure `ADMIN_TOKEN` and approve a plan when you are ready for billable Azure changes. Ansible runs after a successful apply only if both `ANSIBLE_PLAYBOOK` and `ANSIBLE_INVENTORY` are configured and reachable from the backend host.

# Integration status and remaining prerequisites

## Connected in source

- The Overview capacity action now calls the real `/api/azure/plan` endpoint.
- The approval modal applies the exact saved Terraform plan through `/api/azure/approve` and sends the server-side `ADMIN_TOKEN` in a request header.
- The Terraform project directory auto-detects the repository's `../../infrastructure/terraform` directory when it contains `.tf` files; `TERRAFORM_PROJECT_DIR` can override it.
- Terraform status reads non-sensitive known outputs from Terraform state, including `vm_scale_set_capacity` when that output exists.
- After a successful Terraform apply, the backend attempts the configured Ansible playbook/inventory and returns `SUCCEEDED`, `SKIPPED`, or `FAILED` accurately.
- The Terraform page accepts simple commands such as `2 VM` and `2 VMs` and generates a real plan for that count.

## Not verified / must be supplied locally

The uploaded archives included frontend and backend source but did not include the real `.tf` configuration, Ansible playbook, or Ansible inventory. Therefore this package cannot prove that the current Azure resource design can be configured by Ansible or that the requested instance count maps to the expected resource.

Before applying:

1. Confirm `TERRAFORM_PROJECT_DIR` points to the actual Terraform directory.
2. Confirm `TERRAFORM_INSTANCE_VARIABLE=vm_count` matches the variable in the `.tf` files.
3. Confirm the Terraform output `vm_scale_set_capacity` exists if the dashboard should read actual capacity.
4. Set `ANSIBLE_PLAYBOOK` and `ANSIBLE_INVENTORY` to real files that target reachable hosts from the backend's execution environment.
5. Review the Terraform plan. A request for 2 instances may create a whole network/load balancer/VM scale set if those resources do not exist yet, not just two standalone VMs.
6. Only then approve the saved plan. This can incur Azure charges.

The UI's traffic and CPU charts are still explicitly local simulation. They are not Azure Monitor telemetry and do not yet trigger automatic scaling based on real Azure metrics.

# Terraform project directory

The controller expects your real Terraform configuration in this directory by default, or at the directory set with `TERRAFORM_PROJECT_DIR`.

The provided frontend/backend source archives did not include the original Terraform `.tf` files, so this folder intentionally does not invent or replace your Azure resource topology. Copy your existing Terraform configuration here, including provider configuration and the `vm_count` variable used by the controller, or point `TERRAFORM_PROJECT_DIR` to its existing location.

The dashboard passes the desired instance count using `-var=vm_count=<count>` by default. If your Terraform variable has another name, set `TERRAFORM_INSTANCE_VARIABLE` accordingly.

Before applying any plan:
1. Run diagnostics, `terraform init`, and `terraform validate`.
2. Generate and inspect the plan output.
3. Set a strong `ADMIN_TOKEN` in the server environment.
4. Use the explicit approval control only after reviewing the plan.

Never commit `.tfstate`, `.tfplan`, credentials, or `.terraform/` contents.

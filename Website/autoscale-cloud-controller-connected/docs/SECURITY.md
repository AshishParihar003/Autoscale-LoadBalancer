# Security notes

- Terraform commands are fixed server-side command/argument arrays.
- The Terraform working directory is controlled by `TERRAFORM_PROJECT_DIR`, not by request data.
- Apply requires `ADMIN_TOKEN` and an explicit approval request tied to a saved, unexpired plan.
- Do not expose this service publicly over plain HTTP while apply is enabled.
- Use least-privilege Azure permissions and avoid public SSH.
- Terraform output may contain infrastructure details; restrict access to the dashboard and server logs.
- Pending plans and operation history are in-memory and apply is disabled unless the operator configures a token.

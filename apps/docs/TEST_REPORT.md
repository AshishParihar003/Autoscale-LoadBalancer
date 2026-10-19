# Test report template

Run the following locally and record the actual output:

- `npm run typecheck`
- `npm test`
- `npm run build`
- `terraform version`
- `terraform init -input=false`
- `terraform validate`

No Azure resources should be created by these checks. Do not run `terraform apply` during verification. Terraform commands may be marked NOT RUN when Terraform is unavailable or no actual `.tf` project has been configured.

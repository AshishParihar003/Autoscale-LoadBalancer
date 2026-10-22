# Architecture

Production browser → Express server → static Vite build and `/api/*` routes.

The controller API preserves the supplied demo/simulation. The Terraform router is a separate service mounted at `/api/azure`; it runs fixed Terraform commands in one configured working directory. The browser cannot submit arbitrary shell commands or arbitrary project paths.

The Terraform plan workflow is `diagnostics → init → validate → plan → review → explicit approval → apply saved plan`. Apply requires a server-side `ADMIN_TOKEN`, and an operation lock prevents overlapping operations in one Node process.

## Limitations

The uploaded source ZIPs did not contain the original Terraform resource configuration. The app can connect to any configured Terraform project that matches the configured instance variable, but it cannot provision the intended Azure architecture until those `.tf` files are supplied and validated.

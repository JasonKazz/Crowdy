# Crowdy on Azure for Students

This deploys the Python backend to Azure Container Apps and stores workspaces,
floor plans, uploaded images, and generated artifacts in private Azure Blob
Storage. The frontend continues to call the backend through its server routes.
User workspace records and files are durable across browser changes and backend
restarts. Running background jobs still depend on the backend process and should
be retried after an interrupted deployment.

## Resources

| Resource | Configuration |
| --- | --- |
| Subscription | Pinned to `146aa8b7-dd72-4385-a658-2e1e39da630c` |
| Resource group | `rg-crowdy-student` |
| Region | `westus2`, allowed by this student subscription |
| Backend | Container Apps Consumption profile, 0.5 vCPU, 1 GiB, one replica |
| Images | Container Registry Basic, admin access disabled |
| Persistence | StorageV2, Hot, Standard LRS, private `crowdy` blob container |
| Credentials | User-assigned managed identity with scoped `AcrPull` and `Storage Blob Data Contributor` |
| Recovery | Seven-day previous-version cleanup and deleted blob/container retention |
| Logs | Live container log streaming; no Log Analytics workspace |
| Cost alerts | $40/month resource group budget, 50%, 80%, and 100% actual + 100% forecast |

The storage account uses HTTPS and identity authentication. Public blob access and
shared account keys are disabled. Its network endpoint is reachable over HTTPS;
data requires authorization. No private endpoints, dedicated compute plans, SQL
server, Redis, or other fixed-cost database services are created.

One warm replica keeps asynchronous imports running when their initial HTTP
request finishes. Replica count is fixed at one. This is an initial development
deployment; use a job queue and concurrency-safe database design before scaling
to several backend replicas.

## Cost and the $100 credit

The credit is a total balance, not $100 each month. The authenticated subscription
had its Azure spending limit enabled during setup. Keep that setting enabled and
check the remaining balance in [Azure Sponsorships](https://www.microsoftazuresponsorships.com/Balance).
Budget alerts send notifications; they **do not stop spending**.

West US 2 USD retail prices checked on October 24, 2026:

| Item | Published rate / approximate cost |
| --- | --- |
| Container CPU, active | $0.000034 per vCPU-second |
| Container CPU, idle | $0.000004 per vCPU-second |
| Memory, active or idle | $0.000004 per GiB-second |
| ACR Basic | $0.1666/day, approximately $5 per 30 days |
| Blob Hot LRS, first storage tier | $0.0184/GB/month, plus operations |
| ACR quick builds | $0.0001 per task vCPU-second after any allowance |

For a 30-day month with the subscription's full free grants available, backend
compute is approximately **$13.39 if entirely idle** or **$46.87 if continuously
active**. Including ACR gives roughly **$18–52/month**, before storage, builds,
operations, requests beyond the allowance, and outbound data. The traffic mix,
other resources using free grants, and actual Azure meters determine the bill.
Old blob versions and soft-deleted files also consume storage.

These estimates use the
[Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices),
queried for `armRegionName eq 'westus2'`, and
[Container Apps billing](https://learn.microsoft.com/en-us/azure/container-apps/billing).
The current free grants are 180,000 vCPU-seconds, 360,000 GiB-seconds, and two
million requests per subscription per month. A Consumption profile without
Dedicated profiles, private endpoints, or planned maintenance avoids the
Dedicated management fee. This estimate is not a guarantee of how long the
remaining credit will last.

## Prerequisites

- Terraform 1.9 or newer, below 2.0; Azure CLI; Python 3; Git; ripgrep.
- Sign in to the account that owns the student subscription: `az login`.
- Permission to create resources and role assignments in that subscription.
- Register `Microsoft.App`, `Microsoft.ContainerRegistry`, `Microsoft.Storage`,
  and `Microsoft.ManagedIdentity` in **this subscription only**, if required.
  Provider auto-registration is disabled to avoid unrelated subscription changes.

Confirm the subscription explicitly:

```bash
az account show --subscription 146aa8b7-dd72-4385-a658-2e1e39da630c \
  --query '{name:name,id:id,tenantId:tenantId,state:state,spendingLimit:subscriptionPolicies.spendingLimit}'
```

Every command in the deploy script is scoped to that subscription. It never
changes the CLI default or deploys to a different subscription.

## Deploy

From the repository root:

```bash
# Optional: copy this if you need to change the allowed region or alert contacts.
cp infra/terraform.tfvars.example infra/terraform.tfvars
# Replace tenant_id with the student subscription's owning tenant.

# Optional image interpretation keys; omit providers you do not use.
export TF_VAR_gemini_api_key="$GEMINI_API_KEY"
export TF_VAR_anthropic_api_key="$ANTHROPIC_API_KEY"

./infra/scripts/check.sh
# This student subscription requires a running local Docker daemon for builds.
IMAGE_BUILD_MODE=docker ./infra/scripts/deploy.sh deploy
```

The script derives the tenant from the explicitly selected student subscription.
Keep the owning `tenant_id` in ignored `infra/terraform.tfvars.json` or
`infra/terraform.tfvars` as well if you run Terraform directly, outside the script.
Terraform creates the foundation first. The selected build mode produces a Linux
AMD64 backend image from `backend/Dockerfile` and pushes it into ACR. A second
Terraform apply starts the real backend. This avoids publishing a placeholder
API. Each apply executes its saved plan.

This student subscription currently blocks ACR Tasks (`TasksOperationsNotAllowed`).
Start your local Docker daemon and use
`IMAGE_BUILD_MODE=docker ./infra/scripts/deploy.sh deploy` to build Linux AMD64
locally and push using the signed-in account. The registry's admin account stays
disabled. A failed cloud build does not trigger an unreviewed infrastructure
change or deploy an unbuilt image.

The default `IMAGE_BUILD_MODE=acr` uses an ACR cloud build and needs no local
Docker daemon, for subscriptions where ACR Tasks are enabled.

Both build modes stage an explicit temporary context containing only `Dockerfile`,
`pyproject.toml`, `uv.lock`, and application source/text assets from `app/`.
Hidden files, `.env` files, symlinks, bytecode, virtual environments, credentials,
and runtime uploads are excluded before the context reaches Docker or ACR.
An exit trap removes the staged context when the script finishes or fails.

`./infra/scripts/deploy.sh bootstrap` creates only the foundation for inspection.
It refuses to run against an existing deployed app. `plan` creates a reviewable
saved Terraform plan without applying it. Set `TERRAFORM_BIN` to use a Terraform
binary outside your `PATH`.

The generated `infra/deployment.auto.tfvars.json` records the deployed image and
`deploy_backend=true`. Keep it together with your state: without deployment intent,
Terraform's default is foundation-only and a plan can propose removing the app.
The script's `plan` mode refuses to plan an existing app if this file is missing.
On an already deployed environment, run `deploy` to build and publish an update.

Provided `TF_VAR_gemini_api_key` and `TF_VAR_anthropic_api_key` values are saved
atomically to ignored `infra/secrets.auto.tfvars.json` with owner-only permissions
(`0600`). An omitted variable preserves its saved value. Supplying an explicitly
empty variable removes that provider's secret on the next apply. This file
contains credentials: keep it private with the Terraform state and never commit
or print it. Retaining it ensures later plans do not silently remove API keys
when a new terminal has no `TF_VAR_` exports. Environment exports supplied to the
script update this saved configuration before the plan is created.

## Connect the frontend

Set these in the **frontend server** environment, then restart or redeploy it:

```bash
CROWDY_BACKEND_URL=<terraform -chdir=infra output -raw backend_url>
CROWDY_BACKEND_TOKEN=<terraform -chdir=infra output -raw backend_token>
```

The angle-bracket values above are placeholders, not shell commands. Retrieve
the sensitive token privately; never paste it into an issue or commit. Do not use
`NEXT_PUBLIC_` for backend credentials. `/health` is anonymous; protected API
requests require the bearer token. Workspace ownership comes from the frontend's
authenticated session. No browser storage is required for cloud workspace data.

The backend receives these automatically from Terraform:

```text
AZURE_STORAGE_ACCOUNT_URL=https://<account>.blob.core.windows.net/
AZURE_STORAGE_CONTAINER=crowdy
AZURE_CLIENT_ID=<managed identity client ID>
CROWDY_BACKEND_TOKEN=<Container Apps secret>
GEMINI_API_KEY=<optional Container Apps secret>
ANTHROPIC_API_KEY=<optional Container Apps secret>
```

## State, validation, and operations

Terraform state and plan files contain the backend token and optional API keys.
Git ignores state, saved plans, provider caches, and local tfvars. The provider
lockfile is committed for reproducibility. Keep state securely backed up; do not
delete it after deployment. This initial setup uses local state so it does not
need a second bootstrap storage account. Before collaborating on infrastructure,
migrate state to a separate Azure Blob backend using Entra authentication and
state locking. [Azure's state guidance](https://learn.microsoft.com/en-us/azure/developer/terraform/store-state-in-azure-storage)
explains the migration setup.

Validate configuration with `./infra/scripts/check.sh`. Check the deployed URL's
`/health`, then create a workspace, upload an image, and load the same workspace
from a fresh browser session. Confirm actual blobs exist under the container.
For logs, run `az containerapp logs show --follow` with the app name, resource
group, and explicit student `--subscription` from Terraform outputs. Blob RBAC
can take a few minutes to propagate after initial creation.

Terraform protects the storage account with `prevent_destroy`. Stopping or
redeploying compute preserves uploaded data. Destroying all resources would
delete workspaces and uploads, along with retained versions and backups. Export
needed data, then deliberately remove that protection and review a destroy plan
only when you intend to erase the deployment. No deployment script destroys
resources or disables the student's spending limit.

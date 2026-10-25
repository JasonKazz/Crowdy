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
| Optional crowd estimation | Separate Container App, 1 vCPU, 2 GiB, exactly one warm replica |
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

# Shared Vercel AI Gateway key enables both Gemini and Claude extraction.
export TF_VAR_ai_gateway_api_key="$AI_GATEWAY_API_KEY"
# For direct access instead, omit the Gateway export and supply desired keys:
# export TF_VAR_gemini_api_key="$GEMINI_API_KEY"
# export TF_VAR_anthropic_api_key="$ANTHROPIC_API_KEY"

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
The context root stays private (`0700`); its application directories use `0755`
and public build files use `0644`, allowing the non-root image user to read files
copied by Docker even under a restrictive deployment `umask`. In Docker build
mode, an offline import smoke check runs as that user before ACR login or push.
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

Provided `TF_VAR_ai_gateway_api_key`, `TF_VAR_gemini_api_key`, and
`TF_VAR_anthropic_api_key` values are saved
atomically to ignored `infra/secrets.auto.tfvars.json` with owner-only permissions
(`0600`). An omitted variable preserves its saved value. Supplying an explicitly
empty variable removes that provider's secret on the next apply. This file
contains credentials: keep it private with the Terraform state and never commit
or print it. Retaining it ensures later plans do not silently remove API keys
when a new terminal has no `TF_VAR_` exports. Environment exports supplied to the
script update this saved configuration before the plan is created.

The Gateway key is a sensitive Terraform variable, stored in the backend's
`ai-gateway-api-key` Container Apps secret and exposed only as backend environment
variable `AI_GATEWAY_API_KEY`. It enables both provider choices through Vercel's
fixed `https://ai-gateway.vercel.sh/v1/chat/completions` endpoint and takes
precedence over native keys. The frontend needs no provider credential. Native
Gemini and Anthropic secrets remain independent and are preserved when omitted.
Gateway defaults are `google/gemini-3.8-flash` and `anthropic/claude-sonnet-5.5`;
the backend supports `AI_GATEWAY_GEMINI_MODEL` and `AI_GATEWAY_ANTHROPIC_MODEL`
overrides separately from native `GEMINI_MODEL` and `ANTHROPIC_MODEL`. The Gateway
endpoint cannot be overridden. See [provider setup](../docs/image-extraction.md).

## Deploy the independent crowd-estimation service

`crowd_estimation.tf` adds the still-image and live-frame YOLO service without changing the
backend image or deployment flag. It is disabled by default. After the existing
foundation has been deployed, explicitly build and enable it with:

```bash
./infra/scripts/check.sh
./infra/scripts/deploy-crowd-estimation.sh deploy
```

The separate script uses `services/crowd-estimation/Dockerfile`, stages only its
Dockerfile, dependency files, and Python application source, and builds Linux
AMD64 image `crowdy-crowd-estimation:<timestamp>-<commit>` in the existing ACR.
The current student subscription blocks ACR Tasks, so this script requires a
running local Docker daemon, then logs into ACR using the signed-in Azure account
and pushes the image. It does not build or replace the backend image. Terraform
still reviews the full configuration, so retain the existing backend deployment
and secrets files.

The staged context stays private on the host (`0700`), while its application
directories use `0755` and source/dependency files use `0644`. Docker preserves
these modes when copying files, so the image's non-root user can import source
even when deployment runs with a restrictive `umask`. Before ACR login or push,
the script runs an offline import and baked-weight readability smoke check as
the image's configured user; a packaging failure stops publication.

The service reuses the Container Apps environment and registry. Its separate
managed identity receives only `AcrPull`; it receives no workspace-storage role,
volume, or Azure Blob configuration. It exposes HTTPS ingress to container port
8001 and uses TCP startup, readiness, and liveness probes on that port to avoid
Azure's HTTP probe scheme normalization. Uvicorn opens its listener only after
the FastAPI startup lifespan has loaded and warmed the model, so TCP readiness
still waits for usable inference. The startup probe allows approximately five
minutes for this warmup. Anonymous HTTP `/healthz` and `/readyz` endpoints remain
available for callers and manual checks. See [Azure's health probe guidance](https://learn.microsoft.com/en-us/azure/container-apps/health-probes).

The service has 1 vCPU and 2 GiB of memory. Both replica defaults and validations
require one warm replica because camera sessions and their latest previews are
stored in process memory. Update any older overrides in your ignored
`infra/terraform.tfvars` to match:

```hcl
crowd_estimation_min_replicas = 1
crowd_estimation_max_replicas = 1
```

A warm replica adds compute cost beyond the backend estimates above. The
container runs one Uvicorn worker. More workers/replicas require shared session
storage and coordinated frame updates first; scale-to-zero would discard active
sessions. Restarts and deployments still invalidate camera links, which must be
created again. The service expires sessions after 30 minutes and holds at most
16 sessions, retaining only the latest estimate and bounded JPEG preview.
See the [live session API](../services/crowd-estimation/README.md#live-camera-sessions).

The HTTP rule retains a target of one concurrent request, while minimum and
maximum capacity stay fixed at one. Azure reads omit the default scale-rule
cooldown and polling values, so Terraform narrowly ignores their normalization
along with Single-mode ingress traffic weights. CPU, memory, replica limits,
the HTTP rule, image, and security remain managed.

Terraform sets the following service environment:

```text
CROWDY_CROWD_ESTIMATION_TOKEN=<separate Container Apps secret>
CROWDY_YOLO_MODEL=/srv/crowdy/models/yolo26n.pt
CROWDY_YOLO_DEVICE=cpu
CROWDY_YOLO_THREADS=2
```

The model is baked into the image, so the replica does not need to download weights at
startup. Use the `crowd_estimation_url` output as the service base URL and retrieve
the sensitive `crowd_estimation_token` output privately for the trusted caller's
`CROWDY_CROWD_ESTIMATION_TOKEN`. Submit an image to `POST /v1/estimates` as multipart
field `image`, with `Authorization: Bearer <token>`. Keep the token on the server;
it must never use a `NEXT_PUBLIC_` variable or be sent to the browser. The probes
are anonymous. The `crowd_estimation_container_app_name` output identifies the
separate app for logs and operations.

`./infra/scripts/deploy-crowd-estimation.sh plan` creates a saved plan without
building or applying; it is also the default when no argument is supplied. Before
the first deployment, this plan reflects the default disabled service. The
`deploy` command writes ignored `infra/crowd-estimation.auto.tfvars.json` only
after the image build succeeds. This file preserves `deploy_crowd_estimation=true`
and the independent `crowd_estimation_image` across later backend deployments.
Keep both service deployment-intent files with the state and restore both before
running either deployment script; otherwise a missing opt-in flag can cause
Terraform to propose removing that service. The crowd-estimation script refuses
to continue if a managed app's corresponding intent file is missing. The existing
backend deployment script is maintained independently. No crowd-estimation
resources are created by the normal backend workflow until the service is
explicitly enabled.

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
AI_GATEWAY_API_KEY=<optional Container Apps secret for both providers>
```

## State, validation, and operations

Terraform state and plan files contain the service tokens and optional API keys.
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

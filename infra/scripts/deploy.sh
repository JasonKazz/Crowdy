#!/usr/bin/env bash
# Build and deploy into the explicitly authorized student subscription.
set -euo pipefail
umask 077

infra_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_dir="$(cd "$infra_dir/.." && pwd)"
student_subscription="146aa8b7-dd72-4385-a658-2e1e39da630c"
terraform_bin="${TERRAFORM_BIN:-terraform}"
deploy_mode="${1:-deploy}"
image_build_mode="${IMAGE_BUILD_MODE:-acr}"
export CHECKPOINT_DISABLE="${CHECKPOINT_DISABLE:-1}"

if [[ "$deploy_mode" != "bootstrap" && "$deploy_mode" != "deploy" && "$deploy_mode" != "plan" ]]; then
  printf 'Usage: %s [bootstrap|deploy|plan]\n' "$0" >&2
  exit 2
fi
if [[ "$image_build_mode" != "acr" && "$image_build_mode" != "docker" ]]; then
  printf 'IMAGE_BUILD_MODE must be acr or docker.\n' >&2
  exit 2
fi

command -v az >/dev/null
command -v "$terraform_bin" >/dev/null
command -v python3 >/dev/null
command -v rg >/dev/null

if [[ "${ARM_SUBSCRIPTION_ID:-$student_subscription}" != "$student_subscription" || "${TF_VAR_subscription_id:-$student_subscription}" != "$student_subscription" ]]; then
  printf 'Refusing to deploy outside the authorized Azure for Students subscription.\n' >&2
  exit 1
fi
export ARM_SUBSCRIPTION_ID="$student_subscription"
export TF_VAR_subscription_id="$student_subscription"

# Every Azure command is explicitly scoped; do not change the user's CLI default.
student_tenant="$(az account show --subscription "$student_subscription" --query tenantId -o tsv)"
student_state="$(az account show --subscription "$student_subscription" --query state -o tsv)"
if [[ "$student_state" != "Enabled" || -z "$student_tenant" ]]; then
  printf 'The student subscription must be signed in and enabled. Run az login with its owning account.\n' >&2
  exit 1
fi
if [[ -n "${ARM_TENANT_ID:-}" && "$ARM_TENANT_ID" != "$student_tenant" ]]; then
  printf 'ARM_TENANT_ID does not own the authorized student subscription.\n' >&2
  exit 1
fi
if [[ -n "${TF_VAR_tenant_id:-}" && "$TF_VAR_tenant_id" != "$student_tenant" ]]; then
  printf 'TF_VAR_tenant_id does not own the authorized student subscription.\n' >&2
  exit 1
fi
export ARM_TENANT_ID="$student_tenant"
export TF_VAR_tenant_id="$student_tenant"

# Terraform inputs must survive this shell; otherwise omitted optional keys
# revert to empty defaults and a later plan removes the deployed API secrets.
# Read values directly from the environment, never command arguments or output.
python3 - "$infra_dir/secrets.auto.tfvars.json" <<'PY'
import json
import os
import sys
from pathlib import Path

path = Path(sys.argv[1])
values = json.loads(path.read_text()) if path.exists() else {}
allowed = {'gemini_api_key', 'anthropic_api_key'}
if not isinstance(values, dict) or not set(values).issubset(allowed):
    raise SystemExit('The local secrets file must contain only supported API-key variables.')
if any(not isinstance(value, str) for value in values.values()):
    raise SystemExit('The local API-key variables must be strings.')
changed = False
for name in allowed:
    variable = 'TF_VAR_' + name
    if variable in os.environ:
        values[name] = os.environ[variable]
        changed = True
if changed:
    # Keep interrupted writes ignored by Git without matching Terraform's
    # *.auto.tfvars.json auto-load pattern.
    temporary = path.with_name('.' + path.name + '.tmp.tfvars.json')
    temporary.write_text(json.dumps(values, indent=2) + '\n')
    os.chmod(temporary, 0o600)
    temporary.replace(path)
elif path.exists():
    os.chmod(path, 0o600)
PY

"$terraform_bin" -chdir="$infra_dir" init -input=false
"$terraform_bin" -chdir="$infra_dir" validate

app_is_managed=false
if state_entries="$("$terraform_bin" -chdir="$infra_dir" state list 2>&1)"; then
  :
elif [[ ! -f "$infra_dir/terraform.tfstate" && "$state_entries" == *"No state file was found"* ]]; then
  # Expected on the very first deployment; other state errors must fail closed.
  state_entries=""
else
  printf 'Unable to read Terraform state; refusing to plan or apply.\n%s\n' "$state_entries" >&2
  exit 1
fi
if rg -q '^azurerm_container_app\.backend\[' <<< "$state_entries"; then
  app_is_managed=true
fi

if [[ "$deploy_mode" == "plan" ]]; then
  if [[ "$app_is_managed" == true && ! -f "$infra_dir/deployment.auto.tfvars.json" ]]; then
    printf 'The backend exists but local image deployment intent is missing. Restore deployment.auto.tfvars.json or run deploy before planning.\n' >&2
    exit 1
  fi
  "$terraform_bin" -chdir="$infra_dir" plan -input=false -out=current.tfplan
  exit 0
fi

if [[ "$deploy_mode" == "bootstrap" && "$app_is_managed" == true ]]; then
  printf 'Backend already exists. Bootstrap would remove it; run deploy or plan instead.\n' >&2
  exit 1
fi

if [[ "$app_is_managed" == false ]]; then
  "$terraform_bin" -chdir="$infra_dir" plan -input=false -var=deploy_backend=false -out=foundation.tfplan
  "$terraform_bin" -chdir="$infra_dir" apply -input=false foundation.tfplan
fi

if [[ "$deploy_mode" == "bootstrap" ]]; then
  printf 'Foundation created. Run %s deploy to build and deploy the backend.\n' "$0"
  exit 0
fi

registry_name="$("$terraform_bin" -chdir="$infra_dir" output -raw registry_name)"
registry_server="$("$terraform_bin" -chdir="$infra_dir" output -raw registry_login_server)"
image_tag="$(date -u +%Y%m%dT%H%M%SZ)-$(git -C "$repo_dir" rev-parse --short HEAD)"
image_name="crowdy-backend:$image_tag"

# Build an explicit source-only context. ACR CLI versions differ in how they
# interpret .dockerignore; uploading the working directory can include local
# environments, runtime uploads, or credentials before Docker sees the ignore.
build_context="$(mktemp -d "${TMPDIR:-/tmp}/crowdy-build.XXXXXXXX")"
cleanup_build_context() {
  rm -rf "$build_context"
}
trap cleanup_build_context EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 - "$repo_dir/backend" "$build_context" <<'PY'
import shutil
import sys
from pathlib import Path

source, destination = map(Path, sys.argv[1:])
for name in ('Dockerfile', 'pyproject.toml', 'uv.lock'):
    original = source / name
    if original.is_symlink() or not original.is_file():
        raise SystemExit('A required backend build source is missing or is a symlink.')
    shutil.copyfile(original, destination / name)

# Package runtime code and its text assets, never hidden credentials, bytecode,
# virtual environments, user uploads, or symlinks to files outside the app tree.
app = source / 'app'
if app.is_symlink() or not app.is_dir():
    raise SystemExit('The backend app source must be an ordinary directory.')
source_extensions = {'.py', '.js', '.html', '.css', '.txt', '.svg'}
for original in app.rglob('*'):
    relative = original.relative_to(app)
    if any(part.startswith('.') or part == '__pycache__' for part in relative.parts):
        continue
    if original.is_symlink():
        raise SystemExit('The backend build context cannot contain symlinks.')
    if original.is_dir():
        continue
    if original.suffix not in source_extensions:
        continue
    target = destination / 'app' / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(original, target)
PY

# ACR quick builds avoid requiring a local Docker daemon and produce the amd64
# wheel platform needed by JuPedSim. No environment secrets enter the build.
if [[ "$image_build_mode" == "acr" ]]; then
  az acr build \
    --subscription "$student_subscription" \
    --registry "$registry_name" \
    --image "$image_name" \
    --platform linux/amd64 \
    --timeout 1800 \
    --file "$build_context/Dockerfile" \
    "$build_context"
else
  # Some student offers restrict ACR Tasks. An existing local Docker daemon can
  # build the same image and push it using the signed-in user's registry rights.
  command -v docker >/dev/null
  docker build --platform linux/amd64 --file "$build_context/Dockerfile" \
    --tag "$registry_server/$image_name" "$build_context"
  az acr login --subscription "$student_subscription" --name "$registry_name"
  docker push "$registry_server/$image_name"
fi

# Persist deployment intent locally so a future plain terraform plan does not
# accidentally remove the app by falling back to deploy_backend=false.
python3 - "$infra_dir/deployment.auto.tfvars.json" "$registry_server/$image_name" <<'PY'
import json
import os
import sys
from pathlib import Path

path = Path(sys.argv[1])
temporary = path.with_name('.' + path.name + '.tmp.tfvars.json')
temporary.write_text(json.dumps({'deploy_backend': True, 'backend_image': sys.argv[2]}, indent=2) + '\n')
os.chmod(temporary, 0o600)
temporary.replace(path)
PY

"$terraform_bin" -chdir="$infra_dir" plan -input=false -out=backend.tfplan
"$terraform_bin" -chdir="$infra_dir" apply -input=false backend.tfplan
backend_url="$("$terraform_bin" -chdir="$infra_dir" output -raw backend_url)"
printf 'Backend deployed: %s\n' "$backend_url"
printf 'Set CROWDY_BACKEND_URL and the sensitive backend_token output in the frontend server environment.\n'

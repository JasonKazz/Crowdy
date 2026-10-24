#!/usr/bin/env bash
# Explicitly opt in to building/deploying the independent YOLO service.
set -euo pipefail
umask 077

infra_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_dir="$(cd "$infra_dir/.." && pwd)"
student_subscription="146aa8b7-dd72-4385-a658-2e1e39da630c"
terraform_bin="${TERRAFORM_BIN:-terraform}"
deploy_mode="${1:-plan}"
export CHECKPOINT_DISABLE="${CHECKPOINT_DISABLE:-1}"

if [[ "$deploy_mode" == "--help" || "$deploy_mode" == "-h" ]]; then
  printf 'Usage: %s [plan|deploy]\n' "$0"
  printf 'Requires the existing Crowdy Azure foundation. Default: plan.\n'
  exit 0
fi
if [[ "$deploy_mode" != "deploy" && "$deploy_mode" != "plan" ]]; then
  printf 'Usage: %s [plan|deploy]\n' "$0" >&2
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

# Keep the user's CLI default unchanged; every Azure command names the exact
# subscription that already hosts the backend and registry.
student_tenant="$(az account show --subscription "$student_subscription" --query tenantId -o tsv)"
student_state="$(az account show --subscription "$student_subscription" --query state -o tsv)"
if [[ "$student_state" != "Enabled" || -z "$student_tenant" ]]; then
  printf 'The student subscription must be signed in and enabled.\n' >&2
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

"$terraform_bin" -chdir="$infra_dir" init -input=false
"$terraform_bin" -chdir="$infra_dir" validate

# State membership is sufficient; never print state values or bearer tokens.
if ! state_entries="$("$terraform_bin" -chdir="$infra_dir" state list)"; then
  printf 'Unable to read existing foundation state. Run scripts/deploy.sh bootstrap first.\n' >&2
  exit 1
fi
for resource in azurerm_container_registry.images azurerm_container_app_environment.main; do
  if ! rg -Fxq "$resource" <<< "$state_entries"; then
    printf 'Missing foundation resource %s. Run scripts/deploy.sh bootstrap first.\n' "$resource" >&2
    exit 1
  fi
done
if rg -q '^azurerm_container_app\.backend\[' <<< "$state_entries" && [[ ! -f "$infra_dir/deployment.auto.tfvars.json" ]]; then
  printf 'Backend deployment intent is missing. Restore deployment.auto.tfvars.json before proceeding.\n' >&2
  exit 1
fi
if rg -q '^azurerm_container_app\.crowd_estimation\[' <<< "$state_entries" && [[ ! -f "$infra_dir/crowd-estimation.auto.tfvars.json" ]]; then
  printf 'Crowd-estimation deployment intent is missing. Restore crowd-estimation.auto.tfvars.json before proceeding.\n' >&2
  exit 1
fi

if [[ "$deploy_mode" == "plan" ]]; then
  "$terraform_bin" -chdir="$infra_dir" plan -input=false -out=crowd-estimation.tfplan
  exit 0
fi

command -v git >/dev/null
command -v docker >/dev/null
registry_name="$("$terraform_bin" -chdir="$infra_dir" output -raw registry_name)"
registry_server="$("$terraform_bin" -chdir="$infra_dir" output -raw registry_login_server)"
image_tag="$(date -u +%Y%m%dT%H%M%SZ)-$(git -C "$repo_dir" rev-parse --short HEAD)"
image_name="crowdy-crowd-estimation:$image_tag"

# Stage only build inputs. Ignore local models, uploaded images, .env files,
# environments and caches before Docker sees the context.
build_context="$(mktemp -d "${TMPDIR:-/tmp}/crowdy-crowd-build.XXXXXXXX")"
cleanup_build_context() {
  rm -rf "$build_context"
}
trap cleanup_build_context EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 - "$repo_dir/services/crowd-estimation" "$build_context" <<'PY'
import shutil
import sys
from pathlib import Path

source, destination = map(Path, sys.argv[1:])
for name in ('Dockerfile', 'pyproject.toml', 'uv.lock'):
    original = source / name
    if original.is_symlink() or not original.is_file():
        raise SystemExit('A required crowd-estimation build source is missing or is a symlink.')
    shutil.copyfile(original, destination / name)

app = source / 'app'
if app.is_symlink() or not app.is_dir():
    raise SystemExit('The crowd-estimation app source must be an ordinary directory.')
for original in app.rglob('*'):
    relative = original.relative_to(app)
    if any(part.startswith('.') or part == '__pycache__' for part in relative.parts):
        continue
    if original.is_symlink():
        raise SystemExit('The crowd-estimation build context cannot contain symlinks.')
    if original.is_dir() or original.suffix != '.py':
        continue
    target = destination / 'app' / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(original, target)
PY

# The student subscription does not support ACR Tasks. Build locally for the
# Azure runtime's architecture and push using the signed-in user's ACR rights.
docker build --platform linux/amd64 --file "$build_context/Dockerfile" \
  --tag "$registry_server/$image_name" "$build_context"
az acr login --subscription "$student_subscription" --name "$registry_name"
docker push "$registry_server/$image_name"

# A separate intent file keeps subsequent backend deploys from overwriting this
# service's image or opt-in flag. An interrupted image build writes no intent.
python3 - "$infra_dir/crowd-estimation.auto.tfvars.json" "$registry_server/$image_name" <<'PY'
import json
import os
import sys
from pathlib import Path

path = Path(sys.argv[1])
temporary = path.with_name('.' + path.name + '.tmp.tfvars.json')
temporary.write_text(json.dumps({
    'deploy_crowd_estimation': True,
    'crowd_estimation_image': sys.argv[2],
}, indent=2) + '\n')
os.chmod(temporary, 0o600)
temporary.replace(path)
PY

"$terraform_bin" -chdir="$infra_dir" plan -input=false -out=crowd-estimation.tfplan
"$terraform_bin" -chdir="$infra_dir" apply -input=false crowd-estimation.tfplan
service_url="$("$terraform_bin" -chdir="$infra_dir" output -raw crowd_estimation_url)"
printf 'Crowd-estimation service deployed: %s\n' "$service_url"
printf 'Use the crowd_estimation_token output privately for server-to-server bearer authentication.\n'

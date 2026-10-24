#!/usr/bin/env bash
set -euo pipefail
infra_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
terraform_bin="${TERRAFORM_BIN:-terraform}"
export CHECKPOINT_DISABLE="${CHECKPOINT_DISABLE:-1}"
"$terraform_bin" -chdir="$infra_dir" fmt -check -recursive
"$terraform_bin" -chdir="$infra_dir" init -backend=false -input=false
"$terraform_bin" -chdir="$infra_dir" validate
bash -n "$infra_dir/scripts/deploy.sh" "$infra_dir/scripts/deploy-crowd-estimation.sh" "$infra_dir/scripts/check.sh"
python3 -m unittest discover -s "$infra_dir/tests" -p 'test_*.py'

#!/usr/bin/env bash
# git.fetch : met à jour origin/<base> localement. cwd = worktree du sujet.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_env AID_BASE

git fetch origin "$AID_BASE"

printf '::aid:: {"fetched": true}\n'

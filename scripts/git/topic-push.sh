#!/usr/bin/env bash
# git.pousser : pousse la branche du sujet sur origin. cwd = worktree du sujet.
# L'avance (aheadBehind.ahead > 0) est déjà vérifiée côté route avant de lancer ce script.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_env AID_BRANCH

if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  git push origin "$AID_BRANCH"
else
  git push -u origin "$AID_BRANCH"
fi

printf '::aid:: {"pushed": true}\n'

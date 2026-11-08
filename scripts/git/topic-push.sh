#!/usr/bin/env bash
# git.pousser : pousse la branche du sujet sur origin. cwd = worktree du sujet.
# L'avance (aheadBehind.ahead > 0) est déjà vérifiée côté route avant de lancer ce script.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_env AID_BRANCH

if [ "${AID_PUSH_TETE+x}" = x ]; then
  [[ "$AID_PUSH_TETE" =~ ^[0-9a-fA-F]{40}$ ]] || die_human "tête locale invalide"
  [ "${AID_PUSH_DISTANTE+x}" = x ] || die_human "tête distante attendue requise"
  [[ -z "$AID_PUSH_DISTANTE" || "$AID_PUSH_DISTANTE" =~ ^[0-9a-fA-F]{40}$ ]] || die_human "tête distante invalide"
  tete="$(git rev-parse --verify "refs/heads/$AID_BRANCH")" || die_human "branche locale absente"
  [ "$tete" = "$AID_PUSH_TETE" ] || die_human "la tête locale a changé"
  args=("--force-with-lease=refs/heads/$AID_BRANCH:$AID_PUSH_DISTANTE")
  if ! git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    args+=(-u)
  fi
  git push "${args[@]}" origin "$AID_PUSH_TETE:refs/heads/$AID_BRANCH"
elif git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  git push origin "$AID_BRANCH"
else
  git push -u origin "$AID_BRANCH"
fi

printf '::aid:: {"pushed": true}\n'

#!/usr/bin/env bash
# pr.rafraichir : relit l'état de la PR GitHub (vérifications, revues). cwd = worktree du sujet.
# Pas de transition d'état : republie juste le résultat dans actions.result (D18).
# Chantier 27 (D124) : avec la tête de la PR, pour que chaque preuve se dise sur elle.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_env AID_PR_NUMBER
GH="${AID_GH_BIN:-gh}"

printf '::aid:: %s\n' \
  "$("$GH" pr view "$AID_PR_NUMBER" --json statusCheckRollup,reviews,mergeable,title,body,url,headRefOid,state,number,baseRefName,headRefName)"

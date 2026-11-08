#!/usr/bin/env bash
# topic.merge : fusionne la PR GitHub selon la stratégie choisie. cwd = worktree du sujet.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_env AID_PR_NUMBER AID_MERGE_STRATEGY
GH="${AID_GH_BIN:-gh}"

if [ "${AID_MERGE_EXIGER_TETE:-}" = "1" ] && ! [[ "${AID_MERGE_HEAD:-}" =~ ^[0-9a-fA-F]{40}$ ]]; then
  die_human "tête de fusion requise : 40 caractères hexadécimaux"
fi

case "$AID_MERGE_STRATEGY" in
  squash) strategy_flag=--squash ;;
  merge) strategy_flag=--merge ;;
  rebase) strategy_flag=--rebase ;;
  *) die "stratégie de fusion inconnue : $AID_MERGE_STRATEGY" ;;
esac

args=("$AID_PR_NUMBER" "$strategy_flag")
[ "${AID_MERGE_DELETE_BRANCH:-}" = "1" ] && args+=(--delete-branch)
[ -n "${AID_MERGE_MESSAGE:-}" ] && args+=(--subject "$AID_MERGE_MESSAGE")
# Chantier 27 (D123) : GitHub refuse si la tête de la PR n'est plus celle que l'écran a montrée.
[ -n "${AID_MERGE_HEAD:-}" ] && args+=(--match-head-commit "$AID_MERGE_HEAD")

# Refus de GitHub (protection de branche…) remonté tel quel, pas de message réécrit par A-I-D.
output="$("$GH" pr merge "${args[@]}" 2>&1)" || die_human "$output"

printf '::aid:: {"merged": true}\n'

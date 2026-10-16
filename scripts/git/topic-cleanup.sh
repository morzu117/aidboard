#!/usr/bin/env bash
# topic.cleanup : retire le worktree et la branche locale, sans jamais perdre de travail.
# cwd = worktree du sujet (racine du repo si le worktree a disparu).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_env AID_REPO_ROOT AID_BRANCH AID_BASE AID_WORKTREE
CODEGRAPH="${AID_CODEGRAPH_BIN:-codegraph}"

# 1. Rien de non commité. L'index .codegraph est une donnée dérivée : il ne compte pas.
if [ -d "$AID_WORKTREE" ]; then
  dirty="$(git -C "$AID_WORKTREE" status --porcelain -- . ':(exclude).codegraph')"
  if [ -n "$dirty" ]; then
    echo "$dirty" >&2
    die_human "modifications non commitées : rien n'est supprimé"
  fi
fi

cd "$AID_REPO_ROOT" # jamais supprimer un worktree depuis l'intérieur
git worktree prune  # worktree effacé à la main : on oublie son entrée

# 2. Aucun commit perdu sans confirmation qui répète leur nombre exact.
have_branch=0
git show-ref --verify --quiet "refs/heads/$AID_BRANCH" && have_branch=1
if [ "$have_branch" = 1 ]; then
  git fetch --quiet origin "$AID_BASE" || echo "fetch impossible : comparaison avec l'origin/$AID_BASE local" >&2
  n="$(git rev-list --count "origin/$AID_BASE..$AID_BRANCH")"
  if [ "$n" -gt 0 ] && [ "${AID_CONFIRM_UNMERGED:-}" != "$n" ]; then
    printf '::aid:: {"unmergedCommits": %s}\n' "$n"
    die_human "$n commit(s) absents de origin/$AID_BASE : confirmer pour supprimer"
  fi
fi

# 3. Le démon d'index du worktree, seulement si le pid est bien un codegraph (un pid périmé peut être réutilisé).
pidfile="$AID_WORKTREE/.codegraph/daemon.pid"
if [ -f "$pidfile" ]; then
  pid="$(cat "$pidfile")"
  if ps -p "$pid" -o command= 2>/dev/null | grep -q codegraph; then
    kill "$pid" 2>/dev/null || true
  fi
fi
if [ -d "$AID_WORKTREE/.codegraph" ]; then
  "$CODEGRAPH" uninit -f "$AID_WORKTREE" >/dev/null 2>&1 || true
  rm -rf "$AID_WORKTREE/.codegraph"
fi

[ -d "$AID_WORKTREE" ] && git worktree remove "$AID_WORKTREE"
# -D est sûr ici : les commits non fusionnés ont été confirmés plus haut
[ "$have_branch" = 1 ] && git branch -D "$AID_BRANCH" >/dev/null

printf '::aid:: {"removed": true}\n'

#!/usr/bin/env bash
# topic.cleanup : retire le worktree et la branche locale, sans jamais perdre de travail.
# cwd = worktree du sujet (racine du repo si le worktree a disparu).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_env AID_REPO_ROOT AID_BRANCH AID_BASE AID_WORKTREE
CODEGRAPH="${AID_CODEGRAPH_BIN:-codegraph}"
# D21 : stash_ref non vide seulement si AID_DIRTY_ACTION=stash a réellement stashé.
stash_ref=""

# 1. Rien de non commité. L'index .codegraph est une donnée dérivée : il ne compte pas.
if [ -d "$AID_WORKTREE" ]; then
  dirty="$(git -C "$AID_WORKTREE" status --porcelain -- . ':(exclude).codegraph')"
  if [ -n "$dirty" ] && [ "${AID_DIRTY_ACTION:-}" = "stash" ]; then
    git -C "$AID_WORKTREE" stash push -u -m "aid/${AID_SLUG:-$AID_BRANCH}"
    stash_ref="$(git -C "$AID_WORKTREE" stash list --format='%H %gs' | head -1 | cut -d' ' -f1)"
    dirty=""
  fi
  if [ -n "$dirty" ] && [ "${AID_DIRTY_ACTION:-}" = "force" ]; then
    dirty=""
  fi
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
  base_ref="$AID_BASE"
  if [ -n "${AID_REMOTE:-}" ]; then
    base_ref="$AID_REMOTE/$AID_BASE"
    git fetch --quiet "$AID_REMOTE" "$AID_BASE" || echo "fetch impossible : comparaison avec le $base_ref local" >&2
  fi
  n="$(git rev-list --count "$base_ref..$AID_BRANCH")"
  if [ "$n" -gt 0 ] && [ "${AID_CONFIRM_UNMERGED:-}" != "$n" ]; then
    printf '::aid:: {"unmergedCommits": %s}\n' "$n"
    die_human "$n commit(s) absents de $base_ref : confirmer pour supprimer"
  fi
fi

if [ "${AID_CLEANUP_TETE+x}" = x ]; then
  [[ -z "$AID_CLEANUP_TETE" || "$AID_CLEANUP_TETE" =~ ^[0-9a-fA-F]{40}$ ]] || die_human "tête de nettoyage invalide"
  # Le bail précède tout retrait : son refus garde branche et worktree intacts.
  # Si le retrait échoue ensuite, le worktree et ses fichiers restent récupérables.
  if [ -n "$AID_CLEANUP_TETE" ]; then
    git update-ref -d "refs/heads/$AID_BRANCH" "$AID_CLEANUP_TETE" || die_human "la tête locale a changé"
    # Une HEAD détachée conserve les commits et permet le retrait sans forcer.
    if [ -d "$AID_WORKTREE" ] && [ "$(git -C "$AID_WORKTREE" symbolic-ref -q HEAD || true)" = "refs/heads/$AID_BRANCH" ]; then
      git -C "$AID_WORKTREE" update-ref --no-deref HEAD "$AID_CLEANUP_TETE"
    fi
  else
    printf 'verify refs/heads/%s %040d\n' "$AID_BRANCH" 0 | git update-ref --stdin || die_human "la branche locale existe"
  fi
  have_branch=0
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

if [ "${AID_DIRTY_ACTION:-}" = "force" ]; then
  [ -d "$AID_WORKTREE" ] && git worktree remove --force "$AID_WORKTREE"
else
[ -d "$AID_WORKTREE" ] && git worktree remove "$AID_WORKTREE"
fi
# -D est sûr ici : les commits non fusionnés ont été confirmés plus haut
[ "$have_branch" = 1 ] && git branch -D "$AID_BRANCH" >/dev/null

if [ -n "$stash_ref" ]; then
  printf '::aid:: {"removed": true, "stashRef": "%s"}\n' "$stash_ref"
else
printf '::aid:: {"removed": true}\n'
fi

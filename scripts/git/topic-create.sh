#!/usr/bin/env bash
# topic.create : branche et worktree neufs depuis origin/<base>. cwd = racine du repo.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_env AID_REPO_ROOT AID_SLUG AID_BRANCH AID_BASE AID_WORKTREE

git fetch --quiet origin "$AID_BASE"

git show-ref --verify --quiet "refs/heads/$AID_BRANCH" && die_human "la branche $AID_BRANCH existe déjà"
[ -e "$AID_WORKTREE" ] && die_human "le chemin $AID_WORKTREE existe déjà"

mkdir -p "$(dirname "$AID_WORKTREE")"
# --no-track : sans lui, origin/<base> devient l'amont, et un push pourrait partir sur la branche principale
git worktree add --no-track -b "$AID_BRANCH" "$AID_WORKTREE" "origin/$AID_BASE"

if [ -f .worktreeinclude ]; then
  git ls-files --others --ignored --exclude-from=.worktreeinclude -z |
    while IFS= read -r -d '' f; do
      # seulement ce que le projet ignore lui-même : un fichier suivi ou ordinaire ne se copie pas
      git check-ignore -q -- "$f" || continue
      mkdir -p "$AID_WORKTREE/$(dirname "$f")"
      cp -p -- "$f" "$AID_WORKTREE/$f"
      echo "copié : $f"
    done
fi

printf '::aid:: {"worktree": "%s"}\n' "$AID_WORKTREE"

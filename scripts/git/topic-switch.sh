#!/usr/bin/env bash
# topic.branch-changer / branche.creer / branche.creer-ici : change la branche active du
# worktree, ou en crée une (D25/D26). cwd = worktree du sujet.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_env AID_REPO_ROOT AID_BRANCH AID_WORKTREE AID_TARGET_BRANCH

# Déjà sur la branche visée (hors création) : rien à faire.
if [ "$AID_TARGET_BRANCH" = "$AID_BRANCH" ] && [ "${AID_CREATE:-}" != "1" ]; then
  printf '::aid:: {"branch": "%s"}\n' "$AID_TARGET_BRANCH"
  exit 0
fi

# 15 : « Libérer puis prendre » — on vide d'abord le dossier qui détient déjà la branche visée,
# avant le changement du sujet courant (ordre D25 ci-dessous inchangé). Jamais de stash là-bas :
# ce n'est pas le sujet courant qui en est responsable.
if [ "${AID_LIBERER:-}" = "1" ]; then
  require_env AID_LIBERER_DOSSIER
  gitdir_ailleurs="$(git -C "$AID_LIBERER_DOSSIER" rev-parse --path-format=absolute --git-dir)"
  dirty_ailleurs="$(git -C "$AID_LIBERER_DOSSIER" status --porcelain)"
  if [ -n "$dirty_ailleurs" ] \
    || [ -e "$gitdir_ailleurs/rebase-merge" ] || [ -e "$gitdir_ailleurs/rebase-apply" ] \
    || [ -e "$gitdir_ailleurs/MERGE_HEAD" ] || [ -e "$gitdir_ailleurs/CHERRY_PICK_HEAD" ]; then
    die_human "$AID_LIBERER_DOSSIER a des modifications non commitées : commit ou mise de côté là-bas d'abord"
  fi
  if [ -n "${AID_LIBERER_VERS:-}" ]; then
    git -C "$AID_LIBERER_DOSSIER" switch "$AID_LIBERER_VERS"
  else
    git -C "$AID_LIBERER_DOSSIER" switch --detach
  fi
fi

# D25 : non-commité — vocabulaire AID_DIRTY_ACTION de D21, aucun second mécanisme.
stash_ref=""
dirty="$(git status --porcelain)"
if [ -n "$dirty" ] && [ "${AID_DIRTY_ACTION:-}" = "stash" ]; then
  git stash push -u -m "aid/branche/${AID_TARGET_BRANCH}"
  stash_ref="$(git stash list --format='%H %gs' | head -1 | cut -d' ' -f1)"
  dirty=""
fi
if [ -n "$dirty" ]; then
  echo "$dirty" >&2
  die_human "modifications non commitées : changer de branche les écraserait"
fi

if [ "${AID_CREATE:-}" = "1" ]; then
  # D26 : création pure — ne touche jamais topics.branch ni l'état du sujet.
  if git show-ref --verify --quiet "refs/heads/$AID_TARGET_BRANCH"; then
    die_human "la branche $AID_TARGET_BRANCH existe déjà"
  fi
  if [ "${AID_CREATE_FROM:-}" = "base" ]; then
    require_env AID_BASE
    git fetch --quiet origin "$AID_BASE"
    git switch -c "$AID_TARGET_BRANCH" "origin/$AID_BASE"
  else
    git switch -c "$AID_TARGET_BRANCH"
  fi
else
  # D25 : refus net si la branche cible est déjà extraite dans un autre worktree A-I-D — un
  # `git switch` échouerait de toute façon, mais avec un message générique moins actionnable.
  wt=""
  while IFS= read -r line; do
    case "$line" in
      "worktree "*) wt="${line#worktree }" ;;
      "branch refs/heads/$AID_TARGET_BRANCH")
        [ "$wt" = "$AID_WORKTREE" ] || die_human "la branche $AID_TARGET_BRANCH est déjà extraite dans $wt"
        ;;
    esac
  done < <(git -C "$AID_REPO_ROOT" worktree list --porcelain)
  if [ "${AID_LIBERER:-}" = "1" ]; then
    # 15 : X est déjà libéré à ce stade — un échec ici ne doit pas laisser croire qu'il l'est resté.
    if ! sortie="$(git switch "$AID_TARGET_BRANCH" 2>&1)"; then
      echo "$sortie" >&2
      die "$AID_LIBERER_DOSSIER a été libéré (sur ${AID_LIBERER_VERS:-détachée}) ; le changement de branche du sujet a échoué : $sortie"
    fi
  else
    git switch "$AID_TARGET_BRANCH"
  fi
fi

if [ -n "$stash_ref" ]; then
  printf '::aid:: {"branch": "%s", "stashRef": "%s"}\n' "$AID_TARGET_BRANCH" "$stash_ref"
else
  printf '::aid:: {"branch": "%s"}\n' "$AID_TARGET_BRANCH"
fi

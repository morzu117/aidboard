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

# 15/review : toutes les vérifications qui peuvent refuser passent avant de toucher à X — un
# refus tardif laisserait croire que rien n'a bougé alors que X aurait déjà été libéré.
if [ "${AID_LIBERER:-}" = "1" ]; then
  require_env AID_LIBERER_DOSSIER
  gitdir_ailleurs="$(git -C "$AID_LIBERER_DOSSIER" rev-parse --path-format=absolute --git-dir 2>/dev/null)" \
    || die_human "$AID_LIBERER_DOSSIER n'est plus un worktree git valide"
  # branches-libres : les non-suivis ne bloquent plus un changement de branche.
  dirty_ailleurs="$(git -C "$AID_LIBERER_DOSSIER" status --porcelain --untracked-files=no)"
  if [ -n "$dirty_ailleurs" ] \
    || [ -e "$gitdir_ailleurs/rebase-merge" ] || [ -e "$gitdir_ailleurs/rebase-apply" ] \
    || [ -e "$gitdir_ailleurs/MERGE_HEAD" ] || [ -e "$gitdir_ailleurs/CHERRY_PICK_HEAD" ] \
    || [ -e "$gitdir_ailleurs/REVERT_HEAD" ] || [ -e "$gitdir_ailleurs/sequencer" ] \
    || [ -e "$gitdir_ailleurs/BISECT_LOG" ]; then
    die_human "$AID_LIBERER_DOSSIER a des modifications non commitées : commit ou mise de côté là-bas d'abord"
  fi
fi

# D25 : non-commité — vocabulaire AID_DIRTY_ACTION de D21, aucun second mécanisme. Juste la
# vérification ici (refus possible) ; le stash lui-même n'a lieu qu'une fois X touché, plus bas.
# branches-libres : les non-suivis ne bloquent plus un changement de branche (un `git switch`
# refusera lui-même si l'un d'eux entre en conflit avec un fichier suivi de la branche cible).
dirty="$(git status --porcelain --untracked-files=no)"
if [ -n "$dirty" ] && [ "${AID_DIRTY_ACTION:-}" != "stash" ]; then
  echo "$dirty" >&2
  die_human "modifications non commitées : changer de branche les écraserait"
fi

if [ "${AID_CREATE:-}" != "1" ]; then
  # D25 : refus net si la branche cible est déjà extraite dans un autre worktree A-I-D — un
  # `git switch` échouerait de toute façon, mais avec un message générique moins actionnable.
  # Exception : le dossier qu'on libère juste après (15), qui la détient par construction.
  wt=""
  while IFS= read -r line; do
    case "$line" in
      "worktree "*) wt="${line#worktree }" ;;
      "branch refs/heads/$AID_TARGET_BRANCH")
        if [ "$wt" != "$AID_WORKTREE" ] \
          && { [ "${AID_LIBERER:-}" != "1" ] || [ "$wt" != "$AID_LIBERER_DOSSIER" ]; }; then
          die_human "la branche $AID_TARGET_BRANCH est déjà extraite dans $wt"
        fi
        ;;
    esac
  done < <(git -C "$AID_REPO_ROOT" worktree list --porcelain)
fi

# branches-libres (review) : avec AID_LIBERER=1, X est touché avant le switch du sujet. Si le
# switch du sujet échoue plus bas parce qu'un de ses non-suivis serait écrasé, X a déjà été
# libéré pour rien. Détecté ici, avant tout changement — sans liberer, le refus natif de
# `git switch` est déjà propre (rien n'a bougé non plus), pas besoin de ce détour.
if [ "${AID_LIBERER:-}" = "1" ]; then
  fichiers_ecrases_par() {
    local dossier="$1" cible="$2" chemin
    while IFS= read -r -d '' chemin; do
      if git -C "$dossier" cat-file -e "$cible:$chemin" 2>/dev/null; then
        printf '%s\n' "$chemin"
      fi
    done < <(git -C "$dossier" ls-files --others --exclude-standard -z)
    return 0
  }

  message_conflit() {
    local dossier="$1" cible="$2" fichiers="$3" total apercu reste
    total="$(printf '%s\n' "$fichiers" | grep -c .)"
    apercu="$(printf '%s\n' "$fichiers" | head -5 | paste -sd, -)"
    apercu="${apercu//,/, }"
    if [ "$total" -gt 5 ]; then
      reste=$((total - 5))
      apercu="$apercu et $reste autres"
    fi
    printf "%s : fichiers non suivis qui seraient écrasés par %s : %s — déplace-les ou supprime-les d'abord" \
      "$dossier" "$cible" "$apercu"
  }

  cible_sujet=""
  if [ "${AID_CREATE:-}" != "1" ]; then
    cible_sujet="$AID_TARGET_BRANCH"
  elif [ "${AID_CREATE_FROM:-}" = "base" ]; then
    require_env AID_BASE
    git fetch --quiet origin "$AID_BASE"
    cible_sujet="origin/$AID_BASE"
  fi
  if [ -n "$cible_sujet" ]; then
    conflits_sujet="$(fichiers_ecrases_par "$AID_WORKTREE" "$cible_sujet")"
    [ -z "$conflits_sujet" ] || die_human "$(message_conflit "$AID_WORKTREE" "$cible_sujet" "$conflits_sujet")"
  fi

  if [ -n "${AID_LIBERER_VERS:-}" ]; then
    conflits_ailleurs="$(fichiers_ecrases_par "$AID_LIBERER_DOSSIER" "$AID_LIBERER_VERS")"
    [ -z "$conflits_ailleurs" ] || die_human "$(message_conflit "$AID_LIBERER_DOSSIER" "$AID_LIBERER_VERS" "$conflits_ailleurs")"
  fi
fi

# Plus de refus possible à partir d'ici : on touche à X, puis au sujet courant.
libere=0
libere_annonce=0
if [ "${AID_LIBERER:-}" = "1" ]; then
  if [ -n "${AID_LIBERER_VERS:-}" ]; then
    git -C "$AID_LIBERER_DOSSIER" switch "$AID_LIBERER_VERS"
  else
    git -C "$AID_LIBERER_DOSSIER" switch --detach
  fi
  libere=1
  # review (B2) : seules deux sorties passent par fail_apres_liberation ; sous `set -e`, tout
  # autre échec après ce point (AID_CREATE, git fetch…) sortirait sans le dire — ce trap couvre
  # le reste, sans dupliquer le message si fail_apres_liberation l'a déjà écrit.
  trap '
    code=$?
    if [ "$code" -ne 0 ] && [ "$libere_annonce" != "1" ]; then
      echo "$AID_LIBERER_DOSSIER a été libéré (sur ${AID_LIBERER_VERS:-détachée}) ; le script a échoué avant la fin" >&2
    fi
    exit "$code"
  ' EXIT
fi

# 15 : X est déjà libéré à ce stade — tout échec qui suit doit le dire, pour ne pas laisser
# croire que rien n'a bougé.
fail_apres_liberation() {
  if [ "$libere" = "1" ]; then
    libere_annonce=1
    die "$AID_LIBERER_DOSSIER a été libéré (sur ${AID_LIBERER_VERS:-détachée}) ; $1"
  else
    die "$1"
  fi
}

# review (B1) : `stash pop <sha>` échoue toujours (git veut stash@{n}) — l'entrée se retrouve par
# son SHA dans `stash list`, apply puis drop pour ne pas la perdre si apply échoue.
restituer_stash() {
  local sha="$1" entry
  entry="$(git stash list --format='%gd %H' | awk -v s="$sha" '$2 == s { print $1; exit }')"
  [ -n "$entry" ] || return 1
  git stash apply "$entry" && git stash drop "$entry"
}

stash_ref=""
if [ -n "$dirty" ]; then
  git stash push -u -m "aid/branche/${AID_TARGET_BRANCH}" || fail_apres_liberation "la mise de côté a échoué"
  stash_ref="$(git stash list --format='%H %gs' | head -1 | cut -d' ' -f1)"
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
  if ! sortie="$(git switch "$AID_TARGET_BRANCH" 2>&1)"; then
    echo "$sortie" >&2
    # review (2) : un stash créé ici reste rattaché au sujet, jamais à X — sa restitution ne
    # dépend donc que de ce switch, pas de la libération.
    if [ -n "$stash_ref" ] && restituer_stash "$stash_ref"; then
      fail_apres_liberation "le changement de branche du sujet a échoué : $sortie"
    elif [ -n "$stash_ref" ]; then
      fail_apres_liberation "le changement de branche du sujet a échoué, la mise de côté n'a pas pu être restituée (${stash_ref}) : $sortie"
    else
      fail_apres_liberation "le changement de branche du sujet a échoué : $sortie"
    fi
  fi
fi

if [ -n "$stash_ref" ]; then
  printf '::aid:: {"branch": "%s", "stashRef": "%s"}\n' "$AID_TARGET_BRANCH" "$stash_ref"
else
  printf '::aid:: {"branch": "%s"}\n' "$AID_TARGET_BRANCH"
fi

#!/bin/sh
# Faux tmux (chantier 17, D79) pour les tests du relais, là où tmux est absent : new-session -d -s <nom>
# <commande>, has-session -t <nom>, kill-session -t <nom>. La commande tourne en arrière-plan sous sh ;
# FAKE_TMUX_DIR garde le pid de chaque session ; FAKE_TMUX_FAIL fait échouer new-session. Les options du
# serveur (-L <socket>, -f <config>) sont acceptées et ignorées, comme le = d'une cible exacte (-t =<nom>).
dir=${FAKE_TMUX_DIR:?FAKE_TMUX_DIR requis}
while [ "$1" = -L ] || [ "$1" = -f ]; do shift 2; done
case "$1" in
new-session)
  shift
  nom=
  while [ $# -gt 0 ]; do
    case "$1" in
      -d) shift ;;
      -s) nom=$2; shift 2 ;;
      *) break ;;
    esac
  done
  if [ -n "$FAKE_TMUX_FAIL" ]; then
    echo "faux tmux : new-session refusé" >&2
    exit 1
  fi
  if [ -z "$nom" ] || [ -f "$dir/$nom" ]; then
    echo "duplicate session: $nom" >&2
    exit 1
  fi
  sh -c "$1" </dev/null >/dev/null 2>&1 &
  echo $! >"$dir/$nom"
  ;;
has-session)
  nom=${3#=}
  [ -f "$dir/$nom" ] && kill -0 "$(cat "$dir/$nom")" 2>/dev/null
  ;;
kill-session)
  nom=${3#=}
  [ -f "$dir/$nom" ] || exit 1
  kill -HUP "$(cat "$dir/$nom")" 2>/dev/null
  rm -f "$dir/$nom"
  ;;
*)
  echo "faux tmux : $1 non géré" >&2
  exit 1
  ;;
esac

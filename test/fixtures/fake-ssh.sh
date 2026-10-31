#!/bin/sh
# Faux ssh (chantier 17, D79) : remplace ssh dans les tests, jamais de réseau.
# Saute les options, lit la destination puis exécute la commande distante localement sous sh.
# FAKE_SSH_LOG    : fichier où ajouter une ligne par appel (« destination<TAB>commande »).
# FAKE_SSH_FAIL   : sort en 255 avec un message de connexion refusée, comme ssh.
# FAKE_SSH_DELAY  : secondes d'attente avant d'exécuter (latence, délai dépassé).
# FAKE_SSH_HOME   : HOME de la commande distante, pour ne jamais lire le profil de l'opérateur.
# FAKE_SSH_SHELL  : shell de connexion du compte distant (défaut : sh), pour simuler fish ou csh.
while [ $# -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    -o|-p|-l|-i|-J) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
dest="$1"
shift
cmd="$*"
# une ligne par appel, même si la commande porte des sauts de ligne (sonde POSIX du ping)
[ -z "${FAKE_SSH_LOG:-}" ] || printf '%s\t%s\n' "$dest" "$(printf '%s' "$cmd" | tr '\n' ' ')" >> "$FAKE_SSH_LOG"
if [ -n "${FAKE_SSH_FAIL:-}" ]; then
  echo "ssh: connect to host $dest port 22: Connection refused" >&2
  exit 255
fi
[ -z "${FAKE_SSH_DELAY:-}" ] || sleep "$FAKE_SSH_DELAY"
[ -z "${FAKE_SSH_HOME:-}" ] || export HOME="$FAKE_SSH_HOME"
[ -z "${FAKE_SSH_SHELL:-}" ] || exec "$FAKE_SSH_SHELL" -c "$cmd"
exec sh -c "$cmd"

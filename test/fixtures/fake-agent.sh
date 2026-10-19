#!/usr/bin/env bash
# Faux agent plein écran : écran alternatif, cadre, ligne PRÊT, écho des lignes saisies.
# « quit » sort en 0, « fail » en 3, « ask » affiche un choix numéroté comme une demande de permission.
# Remplace claude et codex dans les tests (jamais le vrai agent).
printf '\e[?1049h\e[2J\e[H'
printf '+--------------------+\n|  FAKE AGENT        |\n+--------------------+\n'
printf '\e[10;1HPRÊT\n'
cleanup() { printf '\e[?1049l'; }
trap cleanup EXIT
while IFS= read -r line; do
  case "$line" in
    quit) exit 0 ;;
    fail) exit 3 ;;
    ask) printf 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n' ;;
    # « perm » et « stop » jouent les hooks de Claude Code avec les fixtures, quand le PTY porte AID_HOOK
    perm)
      printf 'Do you want to proceed?\n❯ 1. Yes\n  2. Yes, and don’t ask again\n  3. No\n'
      [ -z "${AID_HOOK:-}" ] || sh "$AID_HOOK" PermissionRequest < "$(dirname "$0")/hooks/PermissionRequest.json"
      IFS= read -r -n1 key
      printf '\nréponse %s\n' "$key" ;;
    stop)
      [ -z "${AID_HOOK:-}" ] || sh "$AID_HOOK" Stop < "$(dirname "$0")/hooks/Stop.json"
      printf 'tour fini\n' ;;
    # cycle de reprise (daemon/pty/reprise.ts) : le prompt embarque le chemin du résumé à écrire
    "Le daemon va redémarrer"*)
      reprise_path=$(printf '%s' "$line" | grep -oE '/tmp/[^ ]+\.md')
      [ -z "$reprise_path" ] || printf 'résumé de test : rien de bloquant.\n' > "$reprise_path"
      printf 'reprise écrite\n' ;;
    *) printf '> %s\n' "$line" ;;
  esac
done

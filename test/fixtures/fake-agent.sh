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
    *) printf '> %s\n' "$line" ;;
  esac
done

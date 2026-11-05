#!/usr/bin/env bash
# Faux swarph (chantier 12, D40) : jamais le vrai swarph en test, jamais de réseau.
#   --version                              → 0.72.25
#   monitor start --as <cell> --deliver pull → journalise, pose un marqueur sous $SWARPH_STATE/<cell>/monitor.pid ; FAKE_SWARPH_EXIT
#   monitor stop --as <cell>               → journalise, retire le marqueur
#   monitor status --json --as <cell>      → FAKE_SWARPH_STATUS (fichier) s'il est posé, sinon déduit du marqueur ; FAKE_SWARPH_PENDING
#   spawn <cell> ... --dry-run             → la commande claude attendue (12.6)
#   board … --json --as <cell>            → $FAKE_SWARPH_BOARD/<nom>.json (chantier 24, voir la branche board)
#   FAKE_SWARPH_VERSION                    → remplace la version affichée par --version
# Chaque appel est journalisé dans FAKE_SWARPH_LOG (une ligne : les arguments).
printf '%s\n' "$*" >>"${FAKE_SWARPH_LOG:-/dev/null}"
if [ "$1" = "--version" ] && [ -n "${FAKE_SWARPH_VERSION:-}" ]; then
  echo "${FAKE_SWARPH_VERSION}"
  exit 0
fi
if [ "$1" = "--version" ]; then
  echo "0.72.25"
  exit 0
fi
if [ "$1" = "monitor" ]; then
  cell=""
  for ((i = 1; i <= $#; i++)); do
    if [ "${!i}" = "--as" ]; then j=$((i + 1)); cell="${!j}"; fi
  done
  # comme le vrai swarph : sans --as ni SWARPH_SELF, aucune identité, le monitor refuse (exit 2, pas de JSON)
  if [ -z "$cell" ] && [ -z "${SWARPH_SELF:-}" ]; then
    echo "swarph monitor: cannot resolve self identity; pass --as or set SWARPH_SELF" >&2
    exit 2
  fi
  cell="${cell:-${SWARPH_SELF:-cell}}"
  marker="${SWARPH_STATE:-/tmp}/$cell/monitor.pid"
  case "$2" in
    start)
      if [ "${FAKE_SWARPH_EXIT:-0}" != "0" ]; then
        echo "monitor: cannot start" >&2
        exit "${FAKE_SWARPH_EXIT}"
      fi
      mkdir -p "$(dirname "$marker")"
      echo $$ >"$marker"
      exit 0
      ;;
    stop)
      rm -f "${SWARPH_STATE:-/tmp}"/*/monitor.pid
      exit 0
      ;;
    status)
      if [ -n "${FAKE_SWARPH_STATUS:-}" ] && [ -f "${FAKE_SWARPH_STATUS}" ]; then
        cat "${FAKE_SWARPH_STATUS}"
        exit 0
      fi
      if ls "${SWARPH_STATE:-/tmp}"/*/monitor.pid >/dev/null 2>&1; then
        printf '{"running": true, "pid": 4242, "pidfile_status": "alive", "observation_cursor": 0, "sinks": [{"name": "inbox", "pending": %s, "pending_from": null}], "state_dir": "%s"}\n' "${FAKE_SWARPH_PENDING:-0}" "${SWARPH_STATE:-/tmp}"
        exit 0
      fi
      printf '{"running": false, "pid": null, "pidfile_status": "missing", "observation_cursor": 0, "sinks": [], "state_dir": "%s"}\n' "${SWARPH_STATE:-/tmp}"
      exit 1
      ;;
  esac
fi
if [ "$1" = "spawn" ] && [[ " $* " != *" --dry-run "* ]]; then
  # la cell ouverte en PTY (12.6) : affiche ce que swarph passerait à claude et son environnement
  # utile, puis attend « quit » sur l'entrée, comme une session
  echo "FAKE_CELL cell=$2 args=${*:3}"
  echo "MESH_GATEWAY_URL=${MESH_GATEWAY_URL:-}"
  echo "SWARPH_STATE=${SWARPH_STATE:-}"
  echo "SWARPH_SELF=${SWARPH_SELF:-}"
  while IFS= read -r line; do
    [ "$line" = "quit" ] && exit 0
  done
  exit 0
fi
if [ "$1" = "spawn" ]; then
  echo "claude --name $2 --session-id 00000000-0000-4000-8000-000000000000"
  exit 0
fi
if [ "$1" = "board" ]; then
  # Lectures du board (chantier 24) : seulement les six formes que le daemon construit (D93), toujours
  # `--json --as <cell>` en fin. Le nom du fichier servi est déduit des arguments :
  #   board projects list                    → projects-list.json
  #   board cards list --project <id>        → cards-list-<id>.json
  #   board cards show|graph <id>            → cards-show-<id>.json, cards-graph-<id>.json
  #   board cards thread <id> --limit <n>    → cards-thread-<id>.json
  #   board obligations list --card <id>     → obligations-list-<id>.json
  # FAKE_SWARPH_BOARD_ERROR : forbidden | unreachable | credential | other (code 1), too-old (code 2).
  # FAKE_SWARPH_BOARD_SLEEP : secondes d'attente avant de répondre.
  [ -n "${FAKE_SWARPH_BOARD_SLEEP:-}" ] && sleep "${FAKE_SWARPH_BOARD_SLEEP}"
  # FAKE_SWARPH_BOARD_ERROR_FILE : même rôle, relu à chaque appel (daemon déjà lancé, e2e 24.9).
  if [ -z "${FAKE_SWARPH_BOARD_ERROR:-}" ] && [ -n "${FAKE_SWARPH_BOARD_ERROR_FILE:-}" ] && [ -f "$FAKE_SWARPH_BOARD_ERROR_FILE" ]; then
    FAKE_SWARPH_BOARD_ERROR=$(head -n 1 "$FAKE_SWARPH_BOARD_ERROR_FILE")
  fi
  case "${FAKE_SWARPH_BOARD_ERROR:-}" in
    forbidden) echo "swarph board: gateway 403: no read grant on this project" >&2; exit 1 ;;
    unreachable) echo "swarph board: gateway unreachable: <urlopen error [Errno 8] nodename nor servname provided, or not known>" >&2; exit 1 ;;
    credential) echo "swarph board: cannot resolve a mesh credential for 'morzu-mac'" >&2; exit 1 ;;
    other) echo "swarph board: something nobody planned for" >&2; exit 1 ;;
    too-old) echo "swarph board: error: argument {projects,cards,obligations}: invalid choice" >&2; exit 2 ;;
  esac
  n=$#
  if [ "$n" -lt 4 ] || [ "${*:n-2:2}" != "--json --as" ]; then
    echo "fake-swarph : board sans --json --as <cell> : $*" >&2
    exit 2
  fi
  set -- "${@:1:n-3}"
  name=""
  case "$*" in
    "board projects list") name="projects-list" ;;
    "board cards list --project "*) [ $# -eq 5 ] && name="cards-list-$5" ;;
    "board cards show "* | "board cards graph "*) [ $# -eq 4 ] && name="cards-$3-$4" ;;
    "board cards thread "*" --limit "*) [ $# -eq 6 ] && name="cards-thread-$4" ;;
    "board obligations list --card "*) [ $# -eq 5 ] && name="obligations-list-$5" ;;
  esac
  if [ -z "$name" ]; then
    echo "fake-swarph : lecture du board inconnue : $*" >&2
    exit 2
  fi
  file="${FAKE_SWARPH_BOARD:-/nonexistent}/$name.json"
  if [ ! -f "$file" ]; then
    echo "swarph board: gateway 404: not found" >&2
    exit 1
  fi
  cat "$file"
  exit 0
fi
echo "fake-swarph : commande inconnue : $*" >&2
exit 2

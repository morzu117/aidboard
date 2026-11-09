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
# Lectures fermées du chantier 37 ; les modes d'erreur du board restent partagés.
if [[ "$1" = "mesh" || "$1" = "rights" || "$1" = "codegraph" || "$1" = "memory" ]]; then
  fichier=""
  identifiant='^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
  case "$1" in
    mesh)
      if [ $# -eq 4 ] && [ "$2" = "peers" ] && [ "$3" = "--as" ] && [ -n "$4" ]; then fichier="mesh-peers.txt"; fi
      ;;
    rights)
      if [ $# -eq 4 ] && [ "$2" = "--json" ] && [ "$3" = "--as" ] && [ -n "$4" ]; then fichier="rights.json"; fi
      ;;
    codegraph)
      if [ $# -eq 9 ] && [ "$2" = "--local" ] && [ "$3" = "--json" ] && [ "$4" = "--limit" ] &&
        [ "$6" = "--caller-cell" ] && [ "$8" = "--" ] &&
        [[ "$5" =~ ^[1-9][0-9]*$ ]] && [ -n "$7" ] && [ "${#9}" -le 200 ] &&
        [[ -n "$9" && "$9" != -* && ! "$9" =~ [[:cntrl:]] ]]; then
        # Chaque caractère hors ASCII alphanumérique, point, tiret et soulignement devient _.
        requete=$(printf '%s' "$9" | LC_ALL=C sed 's/[^A-Za-z0-9._-]/_/g')
        fichier="codegraph-$requete.json"
      fi
      ;;
    memory)
      if [ $# -eq 7 ] && [ "$2" = "list" ] && [ "$3" = "--tag" ] && [ "$5" = "-n" ] && [ "$7" = "--json" ] &&
        [[ "$4" =~ $identifiant && "$6" =~ ^[1-9][0-9]*$ ]]; then fichier="memory-list-$4.json"; fi
      if [ $# -eq 4 ] && [ "$2" = "get" ] && [[ "$3" =~ $identifiant ]] &&
        [ "$4" = "--json" ]; then fichier="memory-get-$3.json"; fi
      if [ $# -eq 6 ] && [ "$2" = "links" ] && [[ "$3" =~ $identifiant ]] &&
        [ "$4" = "--direction" ] && [ "$5" = "both" ] && [ "$6" = "--json" ]; then fichier="memory-links-$3.json"; fi
      ;;
  esac
  if [ -z "$fichier" ]; then
    echo "fake-swarph : lecture inconnue : $*" >&2
    exit 2
  fi
  [ -n "${FAKE_SWARPH_BOARD_SLEEP:-}" ] && sleep "${FAKE_SWARPH_BOARD_SLEEP}"
  if [ -z "${FAKE_SWARPH_BOARD_ERROR:-}" ] && [ -f "${FAKE_SWARPH_BOARD_ERROR_FILE:-/nonexistent}" ]; then
    FAKE_SWARPH_BOARD_ERROR=$(head -n 1 "$FAKE_SWARPH_BOARD_ERROR_FILE")
  fi
  case "${FAKE_SWARPH_BOARD_ERROR:-}" in
    forbidden) echo "swarph $1: gateway 403: no read grant" >&2; exit 1 ;;
    unreachable) echo "swarph $1: gateway unreachable" >&2; exit 1 ;;
    credential) echo "swarph $1: cannot resolve a mesh credential for 'morzu-mac'" >&2; exit 1 ;;
    other) echo "swarph $1: something nobody planned for" >&2; exit 1 ;;
    too-old) echo "swarph $1: error: argument: invalid choice" >&2; exit 2 ;;
  esac
  # FAKE_SWARPH_CODEGRAPH_MODE : no-index (échec) ou stale (sortie normale).
  if [ "$1" = "codegraph" ]; then
    case "${FAKE_SWARPH_CODEGRAPH_MODE:-}" in
      no-index) echo "NO INDEX AVAILABLE" >&2; exit 1 ;;
      stale) echo "STALE INDEX" >&2 ;;
    esac
  fi
  if [ ! -f "${FAKE_SWARPH_BOARD:-/nonexistent}/$fichier" ]; then
    echo "swarph board: gateway 404: not found" >&2
    exit 1
  fi
  cat "${FAKE_SWARPH_BOARD}/$fichier"
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

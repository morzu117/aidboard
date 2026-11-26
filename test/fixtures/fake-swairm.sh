#!/usr/bin/env bash
# Cell locale déterministe : aucun vrai CLI, aucun réseau, aucun secret journalisé.
printf '%s\n' "$*" >>"${FAKE_SWAIRM_LOG:-/dev/null}"
if [ "${1:-}" = "--version" ]; then
  if [ "${FAKE_SWAIRM_VERSION_EXIT:-0}" != "0" ]; then
    echo "fake-swairm : version illisible" >&2
    exit "${FAKE_SWAIRM_VERSION_EXIT}"
  fi
  echo "0.1.0"
  exit 0
fi
if [ "${1:-}" != "cell" ]; then
  echo "fake-swairm : commande inconnue" >&2
  exit 2
fi
trap 'exit 0' TERM HUP INT
: >"${FAKE_SWAIRM_INPUT_LOG:-/dev/null}"
printf 'FAKE_SWAIRM cwd=%s argc=%s args=%s\n' "$PWD" "$#" "$*"
printf 'TERM=%s COLORTERM=%s\n' "${TERM:-}" "${COLORTERM:-}"
for key in AID_URL AID_TOKEN AID_TOPIC AID_RUN AID_AGENT AID_SPOOL AID_HOOK AID_NODE AID_CLI MESH_GATEWAY_URL SWARPH_STATE SWARPH_SELF GH_TOKEN GITHUB_TOKEN; do
  if [ -n "${!key:-}" ]; then
    printf '%s=present\n' "$key"
  else
    printf '%s=absent\n' "$key"
  fi
done
printf 'swairm> '
while IFS= read -r line; do
  printf '%s\n' "$line" >>"${FAKE_SWAIRM_INPUT_LOG:-/dev/null}"
  case "$line" in
    quit) exit 0 ;;
    help) printf 'help status inbox events quit\n' ;;
    status) printf 'status: ready\n' ;;
    inbox) printf 'inbox: empty\n' ;;
    events) printf 'events: empty\n' ;;
    *) printf 'unknown command\n' ;;
  esac
  printf 'swairm> '
done
exit 0

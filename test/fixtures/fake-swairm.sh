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
if [ "${1:-}" = "ask" ]; then
  fixtures="$(dirname "$0")/swairm"
  if [ "$#" = 3 ] && [ "$2" = "--list" ] && [ "$3" = "--json" ]; then
    fichier="$fixtures/asks.json"
  elif [ "$#" = 4 ] && [ "$2" = "--show" ] && [ "$4" = "--json" ] && [[ "$3" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4}$ ]]; then
    fichier="$fixtures/show-$3.json"
  elif [ "$#" = 8 ] && [ "$2" = "--n" ] && [ "$4" = "--modeles" ] && [ "$6" = "--question-file" ] && [ "$8" = "--json" ]; then
    fichier="$fixtures/ask-ok.json"
    if [ -n "${FAKE_SWAIRM_ASK_COPY:-}" ]; then
      cp "$7" "$FAKE_SWAIRM_ASK_COPY"
      printf '%s' "$7" >"$FAKE_SWAIRM_ASK_COPY.path"
      (stat -c '%a' "$7" 2>/dev/null || stat -f '%Lp' "$7") >"$FAKE_SWAIRM_ASK_COPY.mode"
      (stat -c '%a' "$(dirname "$7")" 2>/dev/null || stat -f '%Lp' "$(dirname "$7")") >"$FAKE_SWAIRM_ASK_COPY.dir-mode"
    fi
  else
    echo 'arguments ask invalides' >&2
    exit 2
  fi
  if [ -n "${FAKE_SWAIRM_ASK_ENV:-}" ]; then
    for key in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN OPENAI_API_KEY GH_TOKEN; do
      printf '%s=%s\n' "$key" "${!key-unset}" >>"$FAKE_SWAIRM_ASK_ENV"
    done
  fi
  case "${FAKE_SWAIRM_ASK_MODE:-ok}" in
    refus) printf 'ressemble à une clé API\nseconde ligne\n' >&2; exit 2 ;;
    ancien) echo 'invalid choice: ask' >&2; exit 2 ;;
    format) echo '{}'; exit 0 ;;
    aucun) cat "$fixtures/ask-aucun.json"; exit 3 ;;
    lent) trap 'exit 0' TERM; while :; do sleep 0.05; done ;;
  esac
  cat "$fichier"
  exit "$?"
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

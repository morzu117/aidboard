#!/usr/bin/env bash
# Faux codegraph : « init -y <chemin> » réussit ou échoue selon FAKE_CODEGRAPH_EXIT ; les autres commandes ne font rien.
[ "$1" = "init" ] || exit 0
sleep 0.2
if [ "${FAKE_CODEGRAPH_EXIT:-0}" = "0" ]; then
  mkdir -p "$3/.codegraph"
  : > "$3/.codegraph/codegraph.db"
fi
exit "${FAKE_CODEGRAPH_EXIT:-0}"

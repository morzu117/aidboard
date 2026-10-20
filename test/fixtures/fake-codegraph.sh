#!/usr/bin/env bash
# Faux codegraph : « init -y <chemin> » réussit ou échoue selon FAKE_CODEGRAPH_EXIT (comportement
# historique, inchangé). FAKE_CODEGRAPH_SLEEP fait attendre avant toute réponse, pour simuler un
# délai dépassé côté adaptateur. Les autres commandes (chantier 08) répondent depuis un fichier
# canned FAKE_CODEGRAPH_FIXTURES/<commande>.json ; explore rend un texte fixe (jamais du JSON).
# « sync -q <chemin> » (08.8) suit FAKE_CODEGRAPH_EXIT comme init et dépose .codegraph/synced.
if [ -n "${FAKE_CODEGRAPH_SLEEP:-}" ]; then
  sleep "$FAKE_CODEGRAPH_SLEEP"
fi
if [ "$1" = "init" ]; then
  sleep 0.2
  if [ "${FAKE_CODEGRAPH_EXIT:-0}" = "0" ]; then
    mkdir -p "$3/.codegraph"
    : > "$3/.codegraph/codegraph.db"
  fi
  exit "${FAKE_CODEGRAPH_EXIT:-0}"
fi
if [ "$1" = "sync" ]; then
  # « sync -q <chemin> » (08.8) : dépose un marqueur que les tests vérifient, ou échoue
  sleep 0.2
  if [ "${FAKE_CODEGRAPH_EXIT:-0}" = "0" ]; then
    : > "$3/.codegraph/synced"
  fi
  exit "${FAKE_CODEGRAPH_EXIT:-0}"
fi
if [ "$1" = "explore" ]; then
  echo "**Exploration (fixture)** — texte fixe, jamais parsé en JSON."
  exit 0
fi
if [ -n "${FAKE_CODEGRAPH_FIXTURES:-}" ] && [ -f "${FAKE_CODEGRAPH_FIXTURES}/$1.json" ]; then
  cat "${FAKE_CODEGRAPH_FIXTURES}/$1.json"
  exit 0
fi
exit 0

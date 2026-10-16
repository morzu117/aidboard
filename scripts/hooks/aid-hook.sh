#!/bin/sh
# Hook Claude Code d'A-I-D. Hors d'un terminal A-I-D il ne lance rien ; il ne fait jamais échouer la session.
# Installé par `aid hooks install` sous la forme : [ -z "$AID_HOOK" ] || sh "$AID_HOOK" <Événement>
[ -n "${AID_AGENT:-}" ] && [ -n "${AID_NODE:-}" ] && [ -n "${AID_CLI:-}" ] || exit 0
exec "$AID_NODE" "$AID_CLI" hook "$1" 2>/dev/null

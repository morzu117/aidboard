#!/bin/sh
# AID Server (chantier 13, DR3) : lance la CLI avec le Node embarqué dans cette archive.
# Installé sous ~/.aid/server/<version>/bin/aid ; `current` est un lien vers la version active.
self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case $link in
    /*) self=$link ;;
    *) self=$(dirname "$self")/$link ;;
  esac
done
here=$(cd "$(dirname "$self")/.." && pwd -P)
exec "$here/node/bin/node" "$here/dist/cli/aid.js" "$@"

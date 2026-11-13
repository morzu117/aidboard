#!/usr/bin/env bash
# Chantier 52 (D329) — prépare la version X.Y.Z dans package.json, package-lock.json
# et tauri.conf.json, puis formate ces trois fichiers avec Prettier.
#
# À lancer à la racine du dépôt : scripts/preparer-release.sh <X.Y.Z>.
# Travaille toujours dans le dossier courant ; ne fait ni commit, ni tag, ni push.
set -euo pipefail

version="${1:-}"
if [[ "$#" -ne 1 || ! "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "Version invalide : attendu X.Y.Z, sans préfixe ni suffixe" >&2
  exit 1
fi

outils="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
npm version "$version" --no-git-tag-version
node -e '
  const fs = require("node:fs");
  const fichier = "app/src-tauri/tauri.conf.json";
  const configuration = JSON.parse(fs.readFileSync(fichier, "utf8"));
  configuration.version = process.argv[1];
  fs.writeFileSync(fichier, JSON.stringify(configuration, null, 2) + "\n");
' "$version"
"$outils/node_modules/.bin/prettier" --write package.json package-lock.json app/src-tauri/tauri.conf.json

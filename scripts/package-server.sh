#!/usr/bin/env bash
# Chantier 13.3 — AID Server : une archive autonome pour la plateforme courante (DR3).
#
#   bin/aid  node/bin/node  dist/  node_modules/  migrations/  kernel/  scripts/git  scripts/hooks
#   package.json  README.md  VERSION
#
# Le contenu publié est celui du tarball `npm pack` (clé `files` de package.json), plus les
# dépendances d'exécution installées par le Node qui lance ce script, plus ce même Node,
# téléchargé depuis nodejs.org et vérifié. Même version des deux côtés : les natifs (node-pty,
# better-sqlite3) sont compilés contre l'ABI du Node embarqué, jamais contre un autre.
#
# Sortie : release/aid-server-<version>-<os>-<arch>.tar.gz et sa ligne dans release/SHA256SUMS.
# Variables : AID_RELEASE_DIR (défaut release/), AID_NODE_CACHE (défaut .cache/node/).
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

version=$(node -p "require('./package.json').version")
node_version=$(node -p "process.version")
case "$node_version" in
  v22.*) ;;
  *)
    echo "Node 22 requis pour empaqueter (ABI des natifs embarqués), trouvé $node_version" >&2
    exit 1
    ;;
esac
os=$(node -p "process.platform")
arch=$(node -p "process.arch")
case "$os-$arch" in
  darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64) ;;
  *)
    echo "plateforme non prise en charge : $os-$arch (darwin et linux, arm64 et x64)" >&2
    exit 1
    ;;
esac
if [ ! -f dist/cli/aid.js ] || [ ! -f dist/web/index.html ]; then
  echo "dist/ incomplet : npm run build d'abord" >&2
  exit 1
fi

name="aid-server-$version-$os-$arch"
out="${AID_RELEASE_DIR:-$root/release}"
cache="${AID_NODE_CACHE:-$root/.cache/node}"
stage="$out/stage/$name"

sha256() {
  if command -v sha256sum > /dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

rm -rf "$stage"
mkdir -p "$stage" "$cache" "$out"

# 1. le tarball npm : exactement ce que `files` publie (prepack sauté : dist/ est déjà là)
tarball=$(npm pack --ignore-scripts --pack-destination "$out/stage" --json 2> /dev/null \
  | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8'))[0].filename")
tar xzf "$out/stage/$tarball" -C "$stage" --strip-components=1
rm -f "$out/stage/$tarball"

# 2. dépendances d'exécution, aux versions du lockfile, compilées par CE node
cp package-lock.json "$stage/"
(cd "$stage" && npm ci --omit=dev --no-audit --no-fund --loglevel=error >&2)
rm -f "$stage/package-lock.json"

# 3. le Node officiel, même version, somme vérifiée contre SHASUMS256.txt de nodejs.org
node_dir="node-$node_version-$os-$arch"
node_tar="$node_dir.tar.gz"
if [ ! -f "$cache/$node_tar" ]; then
  echo "téléchargement de ${node_tar}..." >&2
  curl -fsSL -o "$cache/$node_tar.part" "https://nodejs.org/dist/$node_version/$node_tar"
  curl -fsSL -o "$cache/SHASUMS256-$node_version.txt" "https://nodejs.org/dist/$node_version/SHASUMS256.txt"
  expected=$(grep " $node_tar\$" "$cache/SHASUMS256-$node_version.txt" | cut -d' ' -f1)
  actual=$(sha256 "$cache/$node_tar.part")
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    rm -f "$cache/$node_tar.part"
    echo "somme SHA-256 de $node_tar incorrecte (attendu ${expected:-?}, obtenu $actual)" >&2
    exit 1
  fi
  mv "$cache/$node_tar.part" "$cache/$node_tar"
fi
mkdir -p "$stage/node"
# seulement le binaire et sa licence : ni npm, ni les en-têtes
tar xzf "$cache/$node_tar" -C "$stage/node" --strip-components=1 "$node_dir/bin/node" "$node_dir/LICENSE"

# 4. lanceur et version
mkdir -p "$stage/bin"
cp scripts/server-launcher.sh "$stage/bin/aid"
chmod 755 "$stage/bin/aid"
printf '%s\n' "$version" > "$stage/VERSION"

# 5. l'archive (racine = contenu, pas de dossier englobant) et sa somme
archive="$out/$name.tar.gz"
tar czf "$archive" -C "$stage" .
rm -rf "$stage"
sum=$(sha256 "$archive")
touch "$out/SHA256SUMS"
{ grep -v " $name.tar.gz\$" "$out/SHA256SUMS" || true; printf '%s  %s\n' "$sum" "$name.tar.gz"; } > "$out/SHA256SUMS.new"
mv "$out/SHA256SUMS.new" "$out/SHA256SUMS"
echo "$archive"

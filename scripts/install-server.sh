#!/bin/sh
# Installe AID Server (chantier 13.6, DR9) : la dernière release GitHub, ou AID_SERVER_VERSION,
# sous ~/.aid/server/<version>/ avec un lien `current`. Pour les humains et pour AID Board.
#
#   curl -fsSL https://github.com/morzu117/aidboard/releases/latest/download/install-server.sh | sh
#
# Variables :
#   AID_SERVER_VERSION   une version précise (défaut : la dernière release)
#   AID_SERVER_BASE_URL  d'où télécharger (défaut : les assets de la release GitHub) — tests
#   AID_HOME             dossier d'A-I-D (défaut : ~/.aid)
#
# Jamais de sudo, jamais /usr/local : tout est sous AID_HOME. Une archive dont la somme
# SHA-256 ne correspond pas à SHA256SUMS n'est jamais extraite.
set -eu

repo="morzu117/aidboard"
home="${AID_HOME:-$HOME/.aid}"
server="$home/server"

os=$(uname -s)
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *)
    echo "AID Server : $os n'est pas pris en charge (darwin et linux ; Windows : dans WSL2)" >&2
    exit 1
    ;;
esac
arch=$(uname -m)
case "$arch" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *)
    echo "AID Server : architecture $arch non prise en charge (arm64 et x64)" >&2
    exit 1
    ;;
esac

version="${AID_SERVER_VERSION:-}"
if [ -n "${AID_SERVER_BASE_URL:-}" ]; then
  base="$AID_SERVER_BASE_URL"
  [ -n "$version" ] || version=$(curl -fsSL "$base/VERSION")
elif [ -n "$version" ]; then
  base="https://github.com/$repo/releases/download/v$version"
else
  # releases/latest redirige vers le tag de la dernière release : la version est dans l'URL finale
  final=$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest")
  version=${final##*/v}
  case "$version" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *)
      echo "AID Server : impossible de lire la dernière version depuis $final" >&2
      exit 1
      ;;
  esac
  base="https://github.com/$repo/releases/download/v$version"
fi

name="aid-server-$version-$os-$arch.tar.gz"
dir="$server/$version"
if [ -x "$dir/bin/aid" ]; then
  echo "AID Server $version déjà installé dans $dir"
else
  partial="$server/$version.partial"
  rm -rf "$partial"
  mkdir -p "$partial"
  chmod 700 "$home" "$server" 2> /dev/null || true
  echo "téléchargement de ${name}…"
  curl -fsSL -o "$partial/$name" "$base/$name"
  curl -fsSL -o "$partial/SHA256SUMS" "$base/SHA256SUMS"
  expected=$(awk -v f="$name" '$2 == f { print $1 }' "$partial/SHA256SUMS")
  if command -v sha256sum > /dev/null 2>&1; then
    actual=$(sha256sum "$partial/$name" | cut -d' ' -f1)
  else
    actual=$(shasum -a 256 "$partial/$name" | cut -d' ' -f1)
  fi
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    rm -rf "$partial"
    echo "AID Server : somme SHA-256 de $name incorrecte (attendu ${expected:-?}, obtenu $actual) — rien d'installé" >&2
    exit 1
  fi
  mkdir "$partial/x"
  tar xzf "$partial/$name" -C "$partial/x"
  for must in bin/aid node/bin/node dist/cli/aid.js; do
    if [ ! -e "$partial/x/$must" ]; then
      rm -rf "$partial"
      echo "AID Server : $must absent de l'archive — rien d'installé" >&2
      exit 1
    fi
  done
  rm -rf "$dir"
  mv "$partial/x" "$dir"
  rm -rf "$partial"
fi

# bascule atomique de current (un rename, jamais un current absent ou incomplet)
tmp="$server/.current-$$"
rm -f "$tmp"
ln -s "$version" "$tmp"
mv -f "$tmp" "$server/current"

echo "AID Server $version installé : $server/current → $version"
echo "Ajoute $server/current/bin à ton PATH, ou lance AID Board."

#!/usr/bin/env bash
# Met à jour l'app installée (aidboard, toujours sur main) et la reconstruit.
# Ne lance rien : juste pull + build. `aid` reste la commande pour démarrer.
set -euo pipefail

real_source="${BASH_SOURCE[0]}"
while [ -L "$real_source" ]; do
  link_target="$(readlink "$real_source")"
  case "$link_target" in
    /*) real_source="$link_target" ;;
    *) real_source="$(dirname "$real_source")/$link_target" ;;
  esac
done
cd "$(dirname "$real_source")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "aidboard a des modifications locales non commitées : abandon." >&2
  git status --short >&2
  exit 1
fi

branch="$(git branch --show-current)"
if [ "$branch" != "main" ]; then
  echo "aidboard n'est pas sur main (actuellement : $branch) : abandon." >&2
  exit 1
fi

echo "→ pull origin/main"
git pull --ff-only origin main

echo "→ mise install"
mise install

echo "→ npm install"
npm install

echo "→ npm run build"
npm run build

if [ -d "app/src-tauri" ]; then
  echo "→ build et installation de l'app"
  # Lu par daemon_bridge.rs au runtime (bundlé comme resource Tauri, voir tauri.conf.json) :
  # sur une machine avec plusieurs clones aidboard liés sous des versions mise différentes,
  # sans ce fichier un autre peut répondre à la place de celui-ci sur le PATH.
  pwd > "app/src-tauri/repo-path.txt"
  npm run tauri -- build
  rm -rf "/Applications/AID.app"
  cp -R "app/src-tauri/target/release/bundle/macos/AID.app" "/Applications/AID.app"
fi

echo "✓ aidboard à jour et reconstruit ($(git log -1 --oneline))"
if pgrep -f "dist/cli/aid.js daemon" > /dev/null; then
  echo "! le daemon tourne encore sur l'ancien build — relance-le pour prendre la mise à jour (aid stop puis aid)"
fi

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

echo "→ npm install"
npm install

echo "→ npm run build"
npm run build

if [ -f "macapp/AID.applescript" ]; then
  echo "→ compilation et installation de AID.app dans /Applications"
  rm -rf "/Applications/AID.app"
  osacompile -o "/Applications/AID.app" "macapp/AID.applescript"
  plist="/Applications/AID.app/Contents/Info.plist"
  # osacompile nomme toujours son binaire "applet" ; renommé pour que CFBundleExecutable (posé
  # juste après) reste cohérent avec le nom affiché par l'app.
  mv "/Applications/AID.app/Contents/MacOS/applet" "/Applications/AID.app/Contents/MacOS/AID"
  # On MODIFIE le plist généré par osacompile, on ne le remplace jamais en entier : il porte des
  # clés propres aux applets (CFBundleSignature=aplt, LSRequiresCarbon, OSAAppletShowStartupScreen,
  # NSAppleEventsUsageDescription…) sans lesquelles macOS lance bien le process au clic sur un lien
  # aid://, mais ne lui délivre jamais l'événement Apple Event « open location » — silencieusement,
  # ni erreur ni log (constaté le 2026-10-19, en remplaçant le plist en entier).
  plutil -replace CFBundleExecutable -string "AID" "$plist"
  plutil -replace CFBundleName -string "AID" "$plist"
  plutil -replace CFBundleDisplayName -string "AID" "$plist"
  plutil -replace CFBundleIdentifier -string "dev.aidboard.app" "$plist"
  plutil -replace CFBundleIconFile -string "AppIcon" "$plist"
  plutil -remove CFBundleIconName "$plist" 2>/dev/null || true
  plutil -insert CFBundleURLTypes -xml \
    '<array><dict><key>CFBundleURLName</key><string>dev.aidboard.app</string><key>CFBundleURLSchemes</key><array><string>aid</string></array></dict></array>' \
    "$plist"
  cp "macapp/AppIcon.icns" "/Applications/AID.app/Contents/Resources/AppIcon.icns"
  # Ce dépôt-ci peut ne pas être le seul aidboard lié globalement sur la machine (un autre
  # checkout, lié sous une autre version de node, peut passer devant sur le PATH). L'applet se
  # place dans ce chemin avant d'appeler `aid`, pour que ce soit toujours CE dépôt qui réponde.
  pwd > "/Applications/AID.app/Contents/Resources/repo-path.txt"
  # Tout ce qui précède a changé des fichiers scellés par la signature ad-hoc d'osacompile : sans
  # ce resign, `codesign -v` rend « Info.plist a été modifié » et macOS refuse d'établir la
  # connexion Apple Event vers l'app — elle se lance (simple process), mais open location n'arrive
  # jamais non plus, silencieusement. Le réenregistrement LaunchServices derrière tient compte du
  # resign.
  codesign --force --sign - "/Applications/AID.app"
  /System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -f "/Applications/AID.app"
fi

echo "✓ aidboard à jour et reconstruit ($(git log -1 --oneline))"
if pgrep -f "dist/cli/aid.js daemon" > /dev/null; then
  echo "! le daemon tourne encore sur l'ancien build — relance-le pour prendre la mise à jour (aid stop puis aid)"
fi

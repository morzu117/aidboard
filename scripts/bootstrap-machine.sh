#!/usr/bin/env bash
# bootstrap-machine.sh — le niveau machine de SETUP.md, en une commande.
#
# Monte sur un poste neuf (macOS, Debian/Ubuntu, WSL2) l'outillage que la
# chaîne attend, aux mêmes versions partout, puis dit ce qui manque encore.
# Idempotent : on le relance pour réaligner une machine qui a dérivé.
#
#   bash scripts/bootstrap-machine.sh           installer / réaligner
#   bash scripts/bootstrap-machine.sh --check   diagnostic seul, n'installe rien
#
# Windows : sous WSL2 uniquement, jamais en natif — toute la chaîne est en
# bash.
#
# Rien ici n'est propre à un projet : le niveau projet (base, .env, index)
# appartient au script de setup du projet.
#
# Chantier 09 (fusion agent-kernel → aidboard) : ce script installait jadis
# aidboard lui-même comme une dépendance machine (clone + SHA épinglé), puis
# symlinkait ~/.agent-kernel sur ce clone. Depuis la fusion, aidboard est le
# centre : il s'installe par npm comme Node ou Ollama, et matérialise le
# noyau par `aid kernel install` — plus de second dépôt à cloner.
set -euo pipefail

# --- Versions épinglées ------------------------------------------------------
# La même version sur chaque machine, sinon un écart de comportement devient
# inexplicable. Monter une version = la changer ici, commiter, relancer
# partout. Claude Code n'est pas épinglé : il se met à jour tout seul.
NODE_VERSION="24.21.0"
CODEGRAPH_VERSION="1.6.0"
AIDBOARD_VERSION="0.1.0"
OLLAMA_EMBED_MODEL="bge-m3"
OLLAMA_MAINTENANCE_MODEL="qwen3:8b"

SECRETS="$HOME/.config/agent-kernel/secrets.env"

CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "argument inconnu : $arg" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then
  VERT=$'\e[32m'; JAUNE=$'\e[33m'; ROUGE=$'\e[31m'; GRIS=$'\e[90m'; GRAS=$'\e[1m'; FIN=$'\e[0m'
else
  VERT=""; JAUNE=""; ROUGE=""; GRIS=""; GRAS=""; FIN=""
fi
titre() { printf '\n%s==> %s%s\n' "$GRAS" "$1" "$FIN"; }
info()  { printf '    %s%s%s\n' "$GRIS" "$1" "$FIN"; }
ok()    { printf '    %s✓%s %s\n' "$VERT" "$FIN" "$1"; }
warn()  { printf '    %s⚠%s %s\n' "$JAUNE" "$FIN" "$1"; }
ko()    { printf '    %s✗%s %s\n' "$ROUGE" "$FIN" "$1"; }
a() { command -v "$1" > /dev/null 2>&1; }

# --- Système -----------------------------------------------------------------
case "$(uname -s)" in
  Darwin) OS=macos ;;
  Linux)
    OS=linux
    if ! a apt-get; then
      echo "Linux sans apt : non pris en charge (Debian, Ubuntu, WSL2 attendus)." >&2
      exit 1
    fi
    ;;
  *) echo "Système non pris en charge : $(uname -s). Sous Windows, passer par WSL2." >&2; exit 1 ;;
esac
WSL=0
grep -qi microsoft /proc/version 2> /dev/null && WSL=1

case "${SHELL##*/}" in
  zsh) RC="$HOME/.zshrc"; SH=zsh ;;
  *)   RC="$HOME/.bashrc"; SH=bash ;;
esac

printf '%sbootstrap machine%s — %s%s, shell %s\n' "$GRAS" "$FIN" \
  "$OS" "$([ "$WSL" = 1 ] && echo ' (WSL2)')" "$SH"

# --- Bloc géré dans le fichier rc ---------------------------------------------
# Un seul bloc entre marqueurs, réécrit à chaque passage : relancer le script
# ne l'empile pas. Ce qui est déjà ailleurs dans le rc (mise) n'est pas
# redéclaré. Marqueurs conservés tels quels (pas renommés en « aidboard »)
# pour rester idempotent avec les postes déjà réglés par l'ancien script
# d'agent-kernel — un renommage y laisserait un bloc fantôme en plus du
# nouveau.
bloc_rc() {
  local debut="# >>> agent-kernel >>>" fin="# <<< agent-kernel <<<"
  local contenu hors_bloc
  touch "$RC"
  hors_bloc="$(awk -v d="$debut" -v f="$fin" '$0==d{skip=1} !skip{print} $0==f{skip=0}' "$RC")"
  contenu="$debut
# Géré par aidboard/scripts/bootstrap-machine.sh — ne pas éditer à la main."
  if ! printf '%s' "$hors_bloc" | grep -q "mise activate"; then
    contenu="$contenu
export PATH=\"\$HOME/.local/bin:\$PATH\"
eval \"\$(mise activate $SH)\""
  fi
  if [ "$OS" = linux ] && ! printf '%s' "$hors_bloc" | grep -q 'LANG=C.UTF-8'; then
    # Sans locale, tmux croit le terminal non-UTF-8 et remplace les accents
    # par « _ ». À placer avant tout rattachement tmux automatique du rc.
    contenu="$contenu
export LANG=C.UTF-8
export LC_CTYPE=C.UTF-8"
  fi
  contenu="$contenu
# Secrets machine (clé d'embeddings, URL du cerveau) — jamais dans un dépôt.
[ -f \"$SECRETS\" ] && set -a && . \"$SECRETS\" && set +a
$fin"
  local tmp; tmp="$(mktemp)"
  printf '%s\n\n%s\n' "$hors_bloc" "$contenu" > "$tmp"
  # Pas de lignes vides qui s'accumulent en fin de fichier à chaque passage.
  awk 'NF{for(;n>0;n--)print ""; print; next} {n++}' "$tmp" > "$RC"
  rm -f "$tmp"
}

# aidboard est le centre : il s'installe par le registre npm, à la version
# épinglée ci-dessus, comme n'importe quelle autre dépendance machine. Plus
# de clone git ni de SHA à suivre (ça, c'était l'ancien sens — agent-kernel
# clonant aidboard comme une de ses dépendances).
installer_aid() {
  npm install -g --no-audit --no-fund "aidboard@$AIDBOARD_VERSION"
}

if [ "$CHECK_ONLY" = 0 ]; then
  # --- Paquets de base --------------------------------------------------------
  titre "Paquets de base"
  if [ "$OS" = macos ]; then
    if ! a brew; then
      info "installation de Homebrew (demande le mot de passe de session)"
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      eval "$(/opt/homebrew/bin/brew shellenv 2> /dev/null || /usr/local/bin/brew shellenv)"
    fi
    brew install git gh jq tmux
  else
    sudo apt-get update -qq
    sudo apt-get install -y -qq git curl jq unzip ca-certificates build-essential tmux locales lsof
    if ! a gh; then
      # Le dépôt officiel de GitHub : la version de Debian a des mois de retard.
      curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg status=none
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
      sudo apt-get update -qq && sudo apt-get install -y -qq gh
    fi
  fi
  ok "git, gh, jq, tmux"

  # --- Node, via mise --------------------------------------------------------
  titre "Node $NODE_VERSION (mise)"
  if ! a mise; then
    curl -fsSL https://mise.run | sh
    export PATH="$HOME/.local/bin:$PATH"
  fi
  mise use -g "node@$NODE_VERSION"
  eval "$(mise activate bash --shims)"
  corepack enable
  ok "node $(node --version), corepack actif (pnpm suit le packageManager de chaque projet)"

  # --- Agents et index ---------------------------------------------------------
  titre "Claude Code, codegraph"
  a claude || npm install -g @anthropic-ai/claude-code
  if [ "$(codegraph --version 2> /dev/null)" != "$CODEGRAPH_VERSION" ]; then
    npm install -g "@colbymchenry/codegraph@$CODEGRAPH_VERSION"
  fi
  codegraph telemetry off > /dev/null 2>&1 || warn "codegraph telemetry off a échoué — à couper à la main"
  mise reshim
  ok "claude $(claude --version 2> /dev/null | awk '{print $1}'), codegraph $(codegraph --version)"

  # --- Mémoire -----------------------------------------------------------------
  titre "A-I-D $AIDBOARD_VERSION (capacité memory, noyau multi-agents)"
  if ! aid --version 2> /dev/null | grep -q "$AIDBOARD_VERSION"; then
    installer_aid
    mise reshim
  fi
  aid --version 2> /dev/null | grep -q "$AIDBOARD_VERSION" || {
    ko "aid est en « $(aid --version 2> /dev/null | head -1) » au lieu de $AIDBOARD_VERSION"
    exit 1; }
  ok "aid $(aid --version 2> /dev/null | head -1)"

  titre "Ollama et modèles locaux"
  if ! a ollama; then
    if [ "$OS" = macos ]; then brew install ollama; else curl -fsSL https://ollama.com/install.sh | sh; fi
  fi
  if a ollama; then
    # `ollama list | grep -q` : grep -q ferme le tube dès le 1er match, ollama
    # reçoit SIGPIPE en écrivant la suite, et sous `pipefail` ce SIGPIPE fait
    # échouer le pipeline malgré le match — ré-tire le modèle à chaque passage.
    ollama_installes="$(ollama list 2> /dev/null)"
    for m in "$OLLAMA_EMBED_MODEL" "$OLLAMA_MAINTENANCE_MODEL"; do
      grep -q "^${m%%:*}" <<< "$ollama_installes" || ollama pull "$m" || warn "ollama pull $m a échoué — la mémoire tournera en FTS5 seul"
    done
    ok "ollama, $OLLAMA_EMBED_MODEL, $OLLAMA_MAINTENANCE_MODEL"
  else
    warn "ollama absent : recherche vectorielle et entretien désactivés (FTS5 seul, déclaré par aid doctor)"
  fi

  titre "Serveur MCP mémoire et index"
  if a claude && ! claude mcp list 2> /dev/null | grep -q "^aid:"; then
    claude mcp add --scope user aid -- aid mcp && ok "aid déclaré auprès de claude"
  fi

  # --- Le noyau ----------------------------------------------------------------
  # Plus de symlink vers un clone agent-kernel : `aid kernel install`
  # matérialise kernel/ (embarqué dans le package aidboard) vers
  # ~/.agent-kernel et installe /sync dans ~/.claude/commands/ — DS1/DS3.
  titre "Noyau"
  aid kernel install
  ok "noyau matérialisé dans ~/.agent-kernel, /sync installé"

  # --- Secrets -----------------------------------------------------------------
  titre "Secrets machine"
  if [ ! -f "$SECRETS" ]; then
    mkdir -p "$(dirname "$SECRETS")"
    cat > "$SECRETS" << 'EOF'
# Secrets machine de la chaîne agent — chmod 600, jamais commité.
#
# ⚠️ N'ajoute PAS ANTHROPIC_API_KEY ici : ce fichier est chargé dans le shell,
# et `claude` basculerait de l'abonnement vers la facturation à l'API.
#
# Depuis agent-kernel 0.9.0, la chaîne ne demande aucun secret : la mémoire
# est locale (A-I-D, Ollama). Le fichier reste pour ce que TU y mets.
EOF
    warn "créé vide : $SECRETS — à remplir, ou à remplacer par la copie d'une autre machine"
  fi
  chmod 600 "$SECRETS"
  for k in VOYAGE_API_KEY GBRAIN_DATABASE_URL; do
    grep -q "^$k=" "$SECRETS" && warn "$k dans $SECRETS n'est plus utilisé depuis 0.9.0 — à retirer après la migration des données"
  done
  bloc_rc
  ok "bloc agent-kernel à jour dans $RC"
  set -a; . "$SECRETS"; set +a
else
  [ -f "$SECRETS" ] && { set -a; . "$SECRETS"; set +a; }
  export PATH="$HOME/.local/bin:$PATH"
  a mise && eval "$(mise activate bash --shims)"
fi

# --- Diagnostic ----------------------------------------------------------------
# Ce que la machine sait faire, capacité par capacité. C'est la sortie à
# comparer d'une machine à l'autre.
titre "Diagnostic"
MANQUE=0
# Le `|| true` n'est pas cosmétique : sous `set -o pipefail`, un outil ABSENT
# fait échouer le tube, l'affectation `v="$(version_de …)"` échoue à son tour,
# et `set -e` tue le diagnostic AVANT sa première ligne. Sur un poste neuf,
# `--check` rendait donc un écran vide au lieu de la liste de ce qui manque.
version_de() { "$1" --version 2> /dev/null | grep -viE 'upgrade|available' | head -1 || true; }
controle() {
  local nom="$1" attendu="$2" v
  v="$(version_de "$nom")"
  if [ -z "$v" ]; then ko "$nom absent"; MANQUE=1
  elif [ -n "$attendu" ] && ! printf '%s' "$v" | grep -q "$attendu"; then warn "$nom : $v (attendu $attendu)"
  else ok "$nom : $v"; fi
}
controle node "v$NODE_VERSION"
controle pnpm ""
controle git ""
controle gh ""
controle claude ""
controle codegraph "$CODEGRAPH_VERSION"

# aid n'est pas un outil comme les autres : la mémoire est un dépôt git
# partagé entre postes, et un poste en retard peut écrire un format que
# l'autre ne lit pas. L'écart est donc BLOQUANT ici, là où `controle` se
# contente d'un ⚠ pour les autres.
if version_de aid | grep -q "$AIDBOARD_VERSION"; then
  ok "aid $(version_de aid)"
else
  ko "aid est en « $(version_de aid) » au lieu de $AIDBOARD_VERSION — voir SETUP.md"; MANQUE=1
fi
aid doctor 2>&1 | sed 's/^/    /' || true

if a ollama && grep -q "^${OLLAMA_EMBED_MODEL%%:*}" <<< "$(ollama list 2> /dev/null)"; then
  ok "ollama, $OLLAMA_EMBED_MODEL"
else
  warn "ollama absent ou $OLLAMA_EMBED_MODEL non tiré — recherche vectorielle désactivée (FTS5 seul)"
fi
if a claude && claude mcp list 2> /dev/null | grep -q "^aid:"; then
  ok "aid déclaré auprès de claude"
else
  warn "aid absent de claude mcp list — bash scripts/bootstrap-machine.sh"
fi

if a aid; then
  noyau_check="$(aid kernel install --check 2>&1)" || true
  if printf '%s' "$noyau_check" | grep -q 'déjà à jour'; then
    ok "noyau : ~/.agent-kernel à jour"
  else
    ko "noyau désynchronisé — aid kernel install"; MANQUE=1
    printf '%s\n' "$noyau_check" | sed 's/^/    /'
  fi
else
  ko "aid absent : noyau non vérifiable"; MANQUE=1
fi

if gh auth status > /dev/null 2>&1; then ok "gh authentifié"; else warn "gh non authentifié — gh auth login"; fi
if [ -f "$HOME/.claude/.credentials.json" ] || [ "$OS" = macos ]; then
  info "claude : vérifier la connexion avec « claude » puis /status"
else
  warn "claude : aucune session locale — lancer « claude » une fois pour se connecter"
fi
if [ "$OS" = linux ] && ! locale 2> /dev/null | grep -q 'LC_CTYPE=.*UTF-8'; then
  warn "locale non UTF-8 dans ce shell — ouvrir un nouveau terminal (accents en « _ » sinon)"
fi

echo
if [ "$MANQUE" = 0 ]; then
  printf '%sMachine prête.%s Niveau projet : le script de setup de chaque dépôt.\n' "$VERT" "$FIN"
else
  printf '%sMachine incomplète%s — voir les ✗ ci-dessus. Relancer le script après correction.\n' "$ROUGE" "$FIN"
  exit 1
fi

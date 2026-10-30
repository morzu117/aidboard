import { createHash } from 'node:crypto';
import { killGroup, remoteSpawn, shQuote, type TransportOptions } from './transport.js';

/**
 * Chantier 17 (R.2, D73) : relais d'un agent sur le serveur. L'agent tourne dans une session tmux
 * détachée ; son entrée est un FIFO, sa sortie un fichier que `attach` relit à partir d'un octet donné.
 * Une coupure ne tue que le `ssh` : l'agent continue, le rattachement reprend sans perte ni doublon.
 *
 * Le script est embarqué ici plutôt que dans un fichier d'assets : il part avec le bundle, sans toucher à la
 * liste `files` du manifeste. Écrit sans accent grave ni `${` littéral (le gabarit `String.raw` les interpréterait),
 * en sh POSIX plus `head -c`, `tail -c` et `sleep` fractionnaire (GNU et BSD).
 */
export const RELAY_VERSION = 1;

/** Emplacement sur le serveur ; `~` hors guillemets pour être développé par le shell distant. */
export const RELAY_PATH = '~/.aid-remote/aid-relay';

/** Le `${` du shell, que le gabarit `String.raw` interpréterait : écrit `${PE}` dans le script. */
const PE = '${';

export const RELAY_SCRIPT = String.raw`#!/bin/sh
# aid-relay — relais d'un agent A-I-D sur ce serveur (chantier 17, D73). Déposé et versionné par le
# daemon A-I-D : une modification à la main est écrasée au prochain dépôt.
#
#   aid-relay start <id> <cwd> -- <commande> [arguments…]   lance l'agent dans tmux (session aid-<id>)
#   aid-relay attach <id> <offset>   entrée standard → agent ; sortie de l'agent à partir de l'octet <offset>
#   aid-relay alive <id>             vivant | fini <code> | perdu | inconnu
#   aid-relay stop <id>              arrête l'agent et efface ses fichiers
#   aid-relay err <id>               fin de la sortie d'erreur de l'agent (4 000 octets)
#   aid-relay version
#
# Fichiers d'un agent : ~/.aid-remote/agents/<id>/ — in (FIFO), out, err, exit, env, pid, apid, attach.
# Sorties d'attach : 0 agent fini (« aid-relay: fini <code> » sur stderr), 3 inconnu, 4 perdu,
# 5 entrée fermée par le daemon, 8 offset au-delà de la sortie.
umask 077
VERSION=1
base="$HOME/.aid-remote/agents"

die() { printf 'aid-relay: %s\n' "$1" >&2; exit "$2"; }
# entre guillemets simples ; le x protège les retours à la ligne finaux, que $(…) retirerait
q() { r=$(printf '%sx' "$1" | sed "s/'/'\\\\''/g"); printf "'%s'" "${PE}r%x}"; }
vivant() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
# serveur tmux à part, sans la configuration de l'utilisateur (destroy-unattached, default-command…)
tm() { tmux -L aid-relay -f /dev/null "$@"; }

[ $# -ge 1 ] || die 'usage : aid-relay start|attach|alive|stop|version' 2
cmd=$1
shift
if [ "$cmd" = version ]; then
  echo "$VERSION"
  exit 0
fi
[ $# -ge 1 ] || die "usage : aid-relay $cmd <id>" 2
id=$1
shift
case "$id" in '' | *[!A-Za-z0-9_-]*) die "identifiant invalide : $id" 2 ;; esac
d="$base/$id"
session="aid-$id"

# l'agent tourne encore : son shell (pid) et sa session tmux existent. Cible exacte (=) : sans elle, tmux
# accepte un préfixe, et aid-d-1 disparu désignerait aid-d-12.
en_vie() { vivant "$d/pid" && tm has-session -t "=$session" 2>/dev/null; }
# perdu : ni vivant, ni fini. exit est écrit avant que le shell de l'agent sorte : relu après en_vie,
# un agent qui finit entre les deux contrôles n'est pas pris pour perdu.
perdu() { ! en_vie && [ ! -f "$d/exit" ]; }

# Un pid lu dans un fichier a pu être réattribué (redémarrage du serveur) : on ne tue qu'après l'avoir reconnu.
# Le rattachement précédent est attendu, pour que son cat n'écrive plus dans le FIFO après le nôtre.
arreter_attach() {
  old=$(cat "$d/attach" 2>/dev/null)
  [ -n "$old" ] && ps -p "$old" -o args= 2>/dev/null | grep -q "aid-relay attach $id " || return 0
  kill "$old" 2>/dev/null
  i=0
  while kill -0 "$old" 2>/dev/null && [ "$i" -lt 20 ]; do
    i=$((i + 1))
    sleep 0.05
  done
  # bloqué en écriture vers une connexion muette, il diffère son trap : son cat ne doit pas lui survivre
  if kill -0 "$old" 2>/dev/null; then
    pkill -9 -P "$old" 2>/dev/null
    kill -9 "$old" 2>/dev/null
  fi
}
# L'agent n'est tué que s'il est encore l'enfant du shell run ; SIGKILL si SIGTERM n'a pas suffi en 3 s.
arreter() {
  ap=$(cat "$d/apid" 2>/dev/null)
  if [ -n "$ap" ] && vivant "$d/pid" && [ "$(ps -o ppid= -p "$ap" 2>/dev/null | tr -d ' ')" = "$(cat "$d/pid")" ]; then
    kill "$ap" 2>/dev/null
  else
    ap=
  fi
  tm kill-session -t "=$session" 2>/dev/null
  i=0
  while [ -n "$ap" ] && kill -0 "$ap" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -gt 30 ]; then
      kill -9 "$ap" 2>/dev/null
      break
    fi
    sleep 0.1
  done
}

case "$cmd" in
start)
  { [ $# -ge 3 ] && [ "$2" = -- ]; } || die 'usage : aid-relay start <id> <cwd> -- <commande> [arguments…]' 2
  cwd=$1
  shift 2
  mkdir -p "$base" || die "impossible de créer $base" 6
  # mkdir sans -p : verrou atomique, deux start du même id ne passent pas tous les deux
  mkdir "$d" 2>/dev/null || die "agent $id déjà présent" 5
  # un échec en cours de route ne laisse rien (ni dossier, ni session créée ici) : une relance repart de zéro
  cree=
  trap '[ -z "$cree" ] || arreter; rm -rf "$d"' EXIT
  { mkfifo "$d/in" && : >"$d/out" && : >"$d/err"; } || die "impossible de préparer $d" 6
  printf '%s\n' "$cwd" >"$d/cwd"
  # l'environnement du shell de connexion : celui du serveur tmux date de sa création (autre session)
  unset TMUX TMUX_PANE
  export -p >"$d/env"
  for a in "$@"; do printf '%s ' "$(q "$a")"; done >"$d/argv"
  self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  tm new-session -d -s "$session" "sh $(q "$self") run $(q "$id")" || die 'tmux new-session a échoué' 7
  cree=1
  i=0
  while [ ! -f "$d/apid" ] && [ ! -f "$d/exit" ]; do
    i=$((i + 1))
    [ "$i" -le 50 ] || die "l'agent n'a pas démarré" 7
    sleep 0.1
  done
  trap - EXIT
  echo 'aid-relay: démarré'
  ;;
run)
  # lancé par tmux : l'agent lit le FIFO ouvert en lecture-écriture (jamais de fin de fichier entre deux
  # rattachements) et ajoute sa sortie à out, qu'attach relit à partir de l'octet demandé
  echo $$ >"$d/pid"
  # essayé d'abord dans un sous-shell : une variable en lecture seule ferait sortir sh
  if (. "$d/env") 2>/dev/null; then . "$d/env"; fi
  cwd=$(cat "$d/cwd")
  case "$cwd" in
  '~') cwd=$HOME ;;
  '~/'*) cwd="$HOME/$(printf '%s' "$cwd" | cut -c3-)" ;;
  esac
  if cd "$cwd" 2>>"$d/err"; then
    eval "set -- $(cat "$d/argv")"
    "$@" 0<>"$d/in" >>"$d/out" 2>>"$d/err" &
    echo $! >"$d/apid"
    wait $!
    code=$?
  else
    code=126
  fi
  echo "$code" >"$d/exit.tmp" && mv -f "$d/exit.tmp" "$d/exit"
  ;;
attach)
  [ $# -eq 1 ] || die 'usage : aid-relay attach <id> <offset>' 2
  off=$1
  case "$off" in '' | *[!0-9]*) die "offset invalide : $off" 2 ;; esac
  [ -d "$d" ] || die "agent $id inconnu" 3
  # un seul rattachement : le précédent (connexion à moitié morte) est arrêté
  arreter_attach
  echo $$ >"$d/attach"
  # le rattachement est en place : le daemon le lit pour savoir la connexion rétablie (R.3)
  printf 'aid-relay: attaché\n' >&2
  # redirection explicite : sans elle, une commande en arrière-plan lit /dev/null
  exec 3<&0
  cat <&3 >"$d/in" &
  fwd=$!
  fin_attach() {
    kill $fwd 2>/dev/null
    [ "$(cat "$d/attach" 2>/dev/null)" != $$ ] || rm -f "$d/attach"
  }
  trap fin_attach EXIT
  trap 'exit 143' HUP INT TERM
  envoyer() {
    taille=$(wc -c <"$d/out" 2>/dev/null | tr -d ' ')
    case "$taille" in '' | *[!0-9]*) [ -d "$d" ] && die 'sortie illisible' 8 || die "agent $id inconnu" 3 ;; esac
    [ "$taille" -ge "$off" ] || die "offset $off au-delà de la sortie ($taille octets)" 8
    [ "$taille" -gt "$off" ] || return 1
    # sortie fermée (connexion perdue) : head meurt, le rattachement aussi
    tail -c +$((off + 1)) "$d/out" | head -c $((taille - off)) || exit 141
    off=$taille
  }
  while :; do
    envoyer && continue
    if [ -f "$d/exit" ]; then
      # l'agent a fini d'écrire avant que exit existe : une dernière lecture suffit
      envoyer
      printf 'aid-relay: fini %s\n' "$(cat "$d/exit")" >&2
      exit 0
    fi
    if perdu; then
      envoyer
      die perdu 4
    fi
    kill -0 $fwd 2>/dev/null || exit 5
    sleep 0.2
  done
  ;;
alive)
  if [ ! -d "$d" ]; then
    echo inconnu
  elif [ -f "$d/exit" ]; then
    echo "fini $(cat "$d/exit")"
  elif perdu; then
    echo perdu
  elif [ -f "$d/exit" ]; then
    echo "fini $(cat "$d/exit")"
  else
    echo vivant
  fi
  ;;
stop)
  [ -d "$d" ] || exit 0
  arreter_attach
  arreter
  rm -rf "$d"
  echo 'aid-relay: arrêté'
  ;;
err)
  [ ! -f "$d/err" ] || tail -c 4000 "$d/err"
  ;;
*) die "commande inconnue : $cmd" 2 ;;
esac
`;

export const RELAY_SHA256 = createHash('sha256').update(RELAY_SCRIPT).digest('hex');

type RelayServer = Parameters<typeof remoteSpawn>[0];

/** Identifiant d'agent accepté par le relais (nom de dossier et de session tmux). */
const RELAY_ID_RE = /^[A-Za-z0-9_-]+$/;

function relayId(id: string): string {
  if (!RELAY_ID_RE.test(id)) throw new Error(`identifiant de relais invalide : ${id}`);
  return shQuote(id);
}

/** Toujours sous `sh` : un `$HOME` monté `noexec` n'empêche pas le relais de tourner. */
const relay = (sub: string) => `sh ${RELAY_PATH} ${sub}`;

export function relayStart(id: string, cwd: string, argv: readonly string[]): string {
  if (argv.length === 0) throw new Error('commande d’agent vide');
  return relay(`start ${relayId(id)} ${shQuote(cwd)} -- ${argv.map(shQuote).join(' ')}`);
}

export function relayAttach(id: string, offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`offset invalide : ${offset}`);
  return relay(`attach ${relayId(id)} ${offset}`);
}

export const relayAlive = (id: string) => relay(`alive ${relayId(id)}`);
export const relayStop = (id: string) => relay(`stop ${relayId(id)}`);
export const relayErr = (id: string) => relay(`err ${relayId(id)}`);

export type RelayAlive =
  | { state: 'vivant' }
  | { state: 'fini'; code: number | null }
  | { state: 'perdu' }
  | { state: 'inconnu' };

/** Réponse d'`alive` ; toute autre sortie est une erreur (relais absent, shell distant cassé). */
export function parseAlive(stdout: string): RelayAlive {
  const line = stdout.trim().split('\n').at(-1)?.trim() ?? '';
  if (line === 'vivant' || line === 'perdu' || line === 'inconnu') return { state: line };
  const fini = /^fini (\d+)?$/.exec(line);
  if (fini) return { state: 'fini', code: fini[1] === undefined ? null : Number(fini[1]) };
  throw new Error(`réponse du relais illisible : ${line || '(vide)'}`);
}

/** Code de fin de l'agent, lu sur la sortie d'erreur d'un `attach` terminé en 0. */
export function parseFini(stderr: string): number | null {
  const m = /aid-relay: fini (\d+)/.exec(stderr);
  return m ? Number(m[1]) : null;
}

const DEPOSIT_TIMEOUT_MS = 15_000;

/**
 * Dépose le relais s'il manque ou diffère (somme SHA-256), en un seul aller-retour : le script part sur
 * l'entrée standard et n'est écrit que si la somme distante ne correspond pas. Écriture atomique (`mv`), après
 * contrôle de la somme du fichier reçu.
 */
export function ensureRelay(
  server: RelayServer,
  opts: TransportOptions & { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<'present' | 'depose'> {
  const cmd = [
    'umask 077',
    `f=${RELAY_PATH}`,
    'somme() { (sha256sum "$1" || shasum -a 256 "$1") 2>/dev/null | cut -d" " -f1; }',
    `if [ "$(somme "$f")" = ${RELAY_SHA256} ]; then cat >/dev/null; echo aid-relay:present; exit 0; fi`,
    'mkdir -p "$(dirname "$f")"',
    // fichier propre à ce dépôt, vérifié avant publication : un envoi coupé ou concurrent ne publie rien de tronqué
    't="$f.$$"',
    `cat >"$t" && [ "$(somme "$t")" = ${RELAY_SHA256} ] && chmod 700 "$t" && mv -f "$t" "$f" && echo aid-relay:depose && exit 0`,
    'rm -f "$t"; echo "aid-relay: dépôt incomplet (envoi coupé, ou ni sha256sum ni shasum)" >&2; exit 1',
  ].join('\n');
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error('interrompu'));
    const child = remoteSpawn(server, cmd, opts);
    let out = '';
    let err = '';
    let settled = false;
    const done = (e: Error | null, r?: 'present' | 'depose') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (e) reject(e);
      else resolve(r!);
    };
    const timer = setTimeout(() => {
      killGroup(child, 'SIGKILL');
      done(new Error(`délai dépassé (${(opts.timeoutMs ?? DEPOSIT_TIMEOUT_MS) / 1000} s)`));
    }, opts.timeoutMs ?? DEPOSIT_TIMEOUT_MS);
    const onAbort = () => {
      killGroup(child, 'SIGKILL');
      done(new Error('interrompu'));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
    child.on('error', (e) => done(e));
    child.on('close', (code) => {
      if (code === 0 && out.includes('aid-relay:present')) return done(null, 'present');
      if (code === 0 && out.includes('aid-relay:depose')) return done(null, 'depose');
      const last = err.trim().split('\n').at(-1)?.trim();
      done(new Error(last || `dépôt du relais en échec (code ${code ?? '—'})`));
    });
    child.stdin.end(RELAY_SCRIPT);
  });
}

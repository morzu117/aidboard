import type {
  GitCommitDetail,
  GitFileChange,
  ServerGitLog,
  ServerGitRepo,
  ServerGitStatus,
} from '../../shared/git.js';
import type { Server } from '../../shared/model.js';
import { AidHttpError } from '../errors.js';
import { LOG_FORMAT, parseLog } from '../git/inspect.js';
import { command, records, visibleUnder } from './files.js';
import type { ExecResult } from './transport.js';
import { shQuote } from './transport.js';

export const LOG_MAX = 200;
/** Commits des autres branches absents de HEAD relus pour atténuer la fenêtre ; au-delà, supposés dans HEAD. */
const OUTSIDE_HEAD_MAX = 2000;
export const REPOS_MAX = 50;
const REPOS_DEPTH = 4;
const GIT_TIMEOUT_S = 8;
/** Chaque étape réseau ou rebase ; trois au plus dans Synchroniser, sous le délai de l'aller-retour. */
const NET_TIMEOUT_S = 45;
/** fetch / push / sync : le réseau du serveur, pas un aller-retour de lecture ; au-delà des `timeout` distants. */
export const GIT_WRITE_TIMEOUT_MS = 180_000;
const HASH_RE = /^[0-9a-f]{4,64}$/i;

/**
 * Après le préambule de F.1 (chemin résolu `$r` dans le dossier autorisé `$b`) : le dossier doit être dans un
 * dépôt dont la racine reste dans `$b` — `GIT_CEILING_DIRECTORIES` empêche git de remonter au-dessus, la
 * racine est revérifiée. Aucune variable `GIT_*` du profil n'est suivie ; jamais de prompt ni d'éditeur.
 * Lectures sans verrou optionnel, sans fsmonitor ni cache des non-suivis, comme les badges de F.1.
 * Enregistrements : `ok`, `$r`, `$b`, puis `depot` + racine, puis l'état de l'opération (`fait` ou un refus).
 */
const HEAD = `[ -d "$r" ] || { printf 'pasdossier\\000'; exit 0; }
cd "$r" 2>/dev/null || { printf 'illisible\\000'; exit 0; }
printf 'ok\\000%s\\000%s\\000' "$r" "$b"
command -v git >/dev/null 2>&1 || { printf 'nogit\\000'; exit 0; }
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_NAMESPACE
# traces et réglages du profil : une trace HTTP porte l'en-tête d'authentification jusqu'au message (review complète)
unset GIT_TRACE GIT_TRACE2 GIT_TRACE2_EVENT GIT_TRACE2_PERF GIT_TRACE_CURL GIT_TRACE_PACKET GIT_TRACE_PACK_ACCESS GIT_TRACE_PERFORMANCE GIT_TRACE_SETUP GIT_TRACE_SHALLOW GIT_CURL_VERBOSE GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT
export GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat GIT_EDITOR=true
[ -z "$b" ] || { GIT_CEILING_DIRECTORIES=$(dirname "$b"); export GIT_CEILING_DIRECTORIES; }
to=; tn=; command -v timeout >/dev/null 2>&1 && { to="timeout ${GIT_TIMEOUT_S}"; tn="timeout ${NET_TIMEOUT_S}"; }
g() { $to git --no-optional-locks -c core.fsmonitor=false -c core.untrackedCache=false -c color.ui=false -c log.showSignature=false "$@"; }
gn() { $tn git -c core.fsmonitor=false -c color.ui=false -c gc.auto=0 -c maintenance.auto=false -c push.followTags=false "$@"; }
if ! top=$(g rev-parse --show-toplevel 2>/dev/null) || [ -z "$top" ]; then
  case "$(g rev-parse --show-toplevel 2>&1 >/dev/null)" in *dubious*) printf 'proprio\\000'; exit 0 ;; esac
  printf 'pasgit\\000'
  [ -n "\${REPOS:-}" ] || exit 0
  for a in "$@"; do
    a=$(realpath "$(x "$a")" 2>/dev/null) || continue
    [ "$a" = / ] && a=
    $to find "\${a:-/}" -maxdepth ${REPOS_DEPTH} \\( -name node_modules -o -name .venv -o -name dist -o -name target \\) -prune \\
      -o -name .git -print -prune 2>/dev/null | head -n 500 | while IFS= read -r d; do
      printf 'cand\\t%s\\t%s\\000' "$a" "\${d%/.git}"
    done
  done
  exit 0
fi
case "$top" in "$b" | "$b"/*) ;; *) printf 'pasgit\\000'; exit 0 ;; esac
printf 'depot\\000%s\\000' "$top"
st() {
  br=$(g symbolic-ref --quiet HEAD 2>/dev/null) && br=\${br#refs/heads/} || br=
  hd=$(g rev-parse --verify --quiet HEAD 2>/dev/null) || hd=
  og=; g remote get-url origin >/dev/null 2>&1 && og=1
  up=; ab=
  if [ -n "$og" ] && [ -n "$hd" ]; then
    if [ -n "$br" ] && g rev-parse --verify --quiet "refs/remotes/origin/$br" >/dev/null 2>&1; then
      up=origin/$br
      ab=$(g rev-list --left-right --count "refs/remotes/origin/$br...HEAD" 2>/dev/null) || ab=
    else
      n=$(g rev-list --count HEAD --not --remotes=origin 2>/dev/null) && ab="0\t$n"
    fi
  fi
  gd=$(g rev-parse --git-dir 2>/dev/null); op=
  if [ -d "$gd/rebase-merge" ] || [ -d "$gd/rebase-apply" ]; then op=rebase
  elif [ -f "$gd/MERGE_HEAD" ]; then op=merge
  elif [ -f "$gd/CHERRY_PICK_HEAD" ]; then op=cherry-pick
  elif [ -f "$gd/REVERT_HEAD" ]; then op=revert
  elif [ -f "$gd/BISECT_LOG" ]; then op=bisect
  fi
  ch=$(g status --porcelain --untracked-files=normal 2>/dev/null | wc -l | tr -d ' ')
}
pr() {
  printf 'fait\\000br\\t%s\\000hd\\t%s\\000og\\t%s\\000up\\t%s\\000ab\\t%s\\000op\\t%s\\000ch\\t%s\\000' \\
    "$br" "$hd" "$og" "$up" "$ab" "$op" "$ch"
}
`;

const STATUS = `st; pr
`;

const LOG = `st; pr
printf 'log\\000'
[ -n "$hd" ] || exit 0
if [ "$sc" = all ]; then
  g log --topo-order --max-count=${LOG_MAX} --format=${shQuote(`format:${LOG_FORMAT}`)} HEAD --branches --remotes 2>/dev/null
  printf 'horshead\\000'
  g rev-list --max-count=${OUTSIDE_HEAD_MAX} --branches --remotes --not HEAD 2>/dev/null | tr '\\n' '\\000'
else
  g log --topo-order --max-count=${LOG_MAX} --format=${shQuote(`format:${LOG_FORMAT}`)} HEAD 2>/dev/null
fi
`;

/**
 * Pas de détection des renommages, comme le détail d'un commit local (11.3) ; `--root` : le premier commit aussi.
 * Sections marquées par `/…` : jamais un chemin de `diff-tree`, toujours relatif (review F.2).
 */
const COMMIT = `c=$(g rev-parse --verify --quiet "$h^{commit}" 2>/dev/null) || { printf 'pascommit\\000'; exit 0; }
printf 'fait\\000'
g show -s --format='format:%H%x01%P%x01%an%x01%aI%x01%s%x01%b%x01%D' "$c" 2>/dev/null
printf '\\000/numstat\\000'
g diff-tree -z --root --no-commit-id -r --numstat --no-renames --no-textconv --no-ext-diff "$c" 2>/dev/null
printf '/statut\\000'
g diff-tree -z --root --no-commit-id -r --name-status --no-renames "$c" 2>/dev/null
printf '/fin\\000'
g merge-base --is-ancestor "$c" HEAD 2>/dev/null && printf '/inhead\\000'
exit 0
`;

const FETCH = `st
[ -n "$og" ] || { printf 'pasorigin\\000'; exit 0; }
e=$(gn fetch --quiet origin 2>&1 >/dev/null) || { printf 'echec\\000fetch\\000%s\\000' "$e"; exit 0; }
st; pr
`;

/**
 * D33 : rien n'est poussé sans avance — vérifiée par le script même qui pousse, dans le même aller-retour.
 * Toujours `origin/<branche>` du même nom, jamais de force ni de `-u` (la configuration du dépôt ne change pas).
 */
const PUSHABLE = `st
[ -n "$hd" ] || { printf 'vide\\000'; exit 0; }
[ -n "$br" ] || { printf 'detache\\000'; exit 0; }
[ -n "$og" ] || { printf 'pasorigin\\000'; exit 0; }
[ -z "$op" ] || { printf 'operation\\000%s\\000' "$op"; exit 0; }
[ -n "$ab" ] && [ "\${ab#*\t}" != 0 ] || { printf 'rien\\000%s\\000' "$br"; exit 0; }
[ "$hd" = "$eh" ] || { printf 'perime\\000'; exit 0; }
ps=push
# le commit confirmé, pas ce que HEAD est devenu entre-temps (un agent commite pendant le fetch, review complète)
pc=$eh
`;

const PUSH_STEP = `o=$(gn push --porcelain origin "$pc:refs/heads/$br" 2>&1) || {
  case "$o" in *'[rejected]'*) printf 'rejete\\000%s\\000' "$br" ;; *) printf 'echec\\000%s\\000%s\\000' "$ps" "$o" ;; esac
  exit 0
}
st; pr
`;

const PUSH = PUSHABLE + PUSH_STEP;

/**
 * Synchroniser : fetch, rebase sur `origin/<branche>` s'il a avancé, puis pousser. Un rebase qui échoue est
 * annulé aussitôt — le dépôt du serveur revient où il était ; des modifications suivies non commitées le
 * refusent avant tout (jamais d'autostash : A-I-D ne range pas les fichiers de l'utilisateur).
 */
const SYNC = `${PUSHABLE}e=$(gn fetch --quiet origin 2>&1 >/dev/null) || { printf 'echec\\000fetch\\000%s\\000' "$e"; exit 0; }
bh=0
if g rev-parse --verify --quiet "refs/remotes/origin/$br" >/dev/null 2>&1; then
  bh=$(g rev-list --count "HEAD..refs/remotes/origin/$br" 2>/dev/null) || bh=0
fi
if [ "$bh" != 0 ]; then
  g diff --quiet HEAD -- 2>/dev/null || { printf 'modifie\\000'; exit 0; }
  # le rebase porte sur la branche courante : elle et son commit sont encore ceux confirmés (review complète)
  [ "$(g rev-parse --verify --quiet HEAD 2>/dev/null)" = "$eh" ] && [ "$(g symbolic-ref --quiet HEAD 2>/dev/null)" = "refs/heads/$br" ] || { printf 'perime\\000'; exit 0; }
  # connexion coupée ou délai dépassé en plein rebase : annulé quand même, jamais laissé à moitié
  trap 'git rebase --abort >/dev/null 2>&1; exit 1' HUP INT TERM PIPE
  if ! e=$($tn git -c core.fsmonitor=false -c rebase.autoStash=false rebase --quiet "refs/remotes/origin/$br" 2>&1); then
    u=$(git diff --name-only --diff-filter=U 2>/dev/null | head -n 20)
    git rebase --abort >/dev/null 2>&1
    # annulation elle-même en échec (verrou de l'index…) : le dépôt n'est pas revenu, le dire (review complète)
    if [ -d "$gd/rebase-merge" ] || [ -d "$gd/rebase-apply" ]; then printf 'rebaselaisse\\000'; exit 0; fi
    if [ -n "$u" ]; then printf 'conflit\\000%s\\000%s\\000' "$br" "$u"; else printf 'echec\\000rebase\\000%s\\000' "$e"; fi
    exit 0
  fi
  trap - HUP INT TERM PIPE
  ps=pushrebase
  pc=$(g rev-parse --verify --quiet HEAD 2>/dev/null) || { printf 'echec\\000rebase\\000HEAD illisible après le rebase\\000'; exit 0; }
fi
${PUSH_STEP}`;

/** Aucun identifiant d'URL (`https://user:jeton@…`) ne sort dans un message (§11.3.1). */
export function stripUserinfo(s: string): string {
  // jusqu'au dernier `@` avant l'hôte : un mot de passe peut en contenir un (review F.2)
  return s.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, '$1');
}

const lastLine = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1) ?? '';

/** `push --porcelain` finit par `Done` : la dernière ligne d'erreur de git dit plus. */
const gitMessage = (s: string) =>
  lastLine(
    s
      .split('\n')
      .filter((l) => /^\s*(fatal|error|remote|!)/.test(l))
      .join('\n'),
  ) || lastLine(s);

const STEPS: Record<string, string> = {
  fetch: 'fetch',
  push: 'poussée',
  pushrebase: 'poussée (le rebase sur origin est fait sur le serveur)',
  rebase: 'rebase',
};

const REFUSALS: Record<string, [number, (d: string[]) => string]> = {
  nogit: [502, () => 'git introuvable sur le serveur'],
  proprio: [409, () => 'dépôt d’un autre utilisateur sur le serveur (safe.directory) : non lu'],
  pasgit: [409, () => 'ce dossier n’est pas un dépôt Git'],
  pascommit: [404, () => 'commit introuvable dans ce dépôt'],
  vide: [409, () => 'dépôt sans commit : rien à pousser'],
  detache: [409, () => 'HEAD détachée sur le serveur : aucune branche à pousser'],
  pasorigin: [409, () => 'pas de remote origin dans ce dépôt'],
  operation: [409, ([op]) => `${op} en cours sur le serveur : à terminer sur place`],
  rien: [422, ([br]) => `rien à pousser : pas d’avance sur origin/${br}`],
  modifie: [
    409,
    () =>
      'modifications suivies non commitées sur le serveur : synchronisation refusée, rien n’a changé',
  ],
  conflit: [
    409,
    ([br, files]) =>
      `conflit avec origin/${br} (${(files ?? '').split('\n').filter(Boolean).join(', ')}) : rebase annulé, rien n’a changé sur le serveur`,
  ],
  rebaselaisse: [409, () => 'rebase en échec et non annulé sur le serveur : à terminer sur place'],
  rejete: [409, ([br]) => `origin/${br} a avancé : Synchroniser d’abord`],
  perime: [409, () => 'le dépôt du serveur a changé depuis l’affichage : relire avant de pousser'],
  echec: [
    502,
    ([step, out]) =>
      `${STEPS[step ?? ''] ?? 'git'} impossible : ${stripUserinfo(gitMessage(out ?? '')) || 'erreur inconnue'}`,
  ],
};

interface Parsed {
  resolved: string;
  /** null : pas un dépôt (`pasgit`) ; `recs` porte alors les dépôts candidats. */
  root: string | null;
  /** Enregistrements après l'état `fait`. */
  recs: string[];
}

function parse(r: ExecResult, allowNoRepo = false): Parsed {
  const recs = records(r);
  const resolved = recs[1]!;
  const base = recs[2]!;
  const state = recs[3] ?? '';
  if (state === 'pasgit' && allowNoRepo) return { resolved, root: null, recs: recs.slice(4) };
  if (state !== 'depot') return refuse(state, recs.slice(4), r);
  const root = recs[4] ?? '';
  // défense en profondeur : le script a déjà borné la racine au dossier autorisé
  if (!visibleUnder(root, base) || !(resolved === root || resolved.startsWith(`${root}/`)))
    throw new AidHttpError(403, 'dépôt hors des dossiers autorisés du serveur');
  if (recs[5] !== 'fait') return refuse(recs[5] ?? '', recs.slice(6), r);
  return { resolved, root, recs: recs.slice(6) };
}

function refuse(state: string, details: string[], r: ExecResult): never {
  const refusal = REFUSALS[state];
  if (refusal) throw new AidHttpError(refusal[0], refusal[1](details));
  const why = stripUserinfo(lastLine(r.stderr)) || `code de sortie ${r.code}`;
  throw new AidHttpError(502, `lecture Git impossible sur le serveur : ${why}`);
}

const OPERATIONS = ['rebase', 'merge', 'cherry-pick', 'revert', 'bisect'] as const;

/** Les sept enregistrements `clé\tvaleur` de `pr`, en tête de `recs`. */
function repoOf(root: string, recs: string[]): ServerGitRepo {
  const kv = new Map(recs.slice(0, 7).map((x) => [x.slice(0, 2), x.slice(3)]));
  const [behind, ahead] = (kv.get('ab') ?? '').split('\t').map(Number);
  const op = kv.get('op') ?? '';
  return {
    root,
    branch: kv.get('br') || null,
    head: kv.get('hd') || null,
    changes: Number(kv.get('ch') || 0),
    origin: kv.get('og') === '1',
    upstream: kv.get('up') || null,
    aheadBehind:
      Number.isInteger(ahead) && Number.isInteger(behind)
        ? { ahead: ahead!, behind: behind! }
        : null,
    operation: (OPERATIONS as readonly string[]).includes(op)
      ? (op as ServerGitRepo['operation'])
      : null,
  };
}

function scriptCommand(script: string, server: Server, path: string, vars = ''): string {
  return command(vars + HEAD + script, server, path);
}

export const gitStatusCommand = (server: Server, path: string) =>
  scriptCommand(STATUS, server, path, 'REPOS=1\n');
export const gitLogCommand = (server: Server, path: string, scope: 'all' | 'branch') =>
  scriptCommand(LOG, server, path, `sc=${scope === 'all' ? 'all' : 'branch'}\n`);
export const gitFetchCommand = (server: Server, path: string) => scriptCommand(FETCH, server, path);
const FULL_HASH_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * La confirmation porte sur un état : `head` = le commit affiché sur la carte. Un commit arrivé entre
 * l'affichage et le clic fait refuser la poussée (review F.2).
 */
function confirmedHead(head: string | undefined): string {
  if (head === undefined || !FULL_HASH_RE.test(head))
    throw new AidHttpError(
      400,
      'confirmation requise : commit affiché (`head`) manquant ou invalide',
    );
  return head;
}

export const gitPushCommand = (server: Server, path: string, head?: string) =>
  scriptCommand(PUSH, server, path, `eh=${shQuote(confirmedHead(head))}\n`);
export const gitSyncCommand = (server: Server, path: string, head?: string) =>
  scriptCommand(SYNC, server, path, `eh=${shQuote(confirmedHead(head))}\n`);

export function checkHash(hash: string): string {
  if (!HASH_RE.test(hash)) throw new AidHttpError(400, 'hash de commit invalide');
  return hash;
}

export const gitCommitCommand = (server: Server, path: string, hash: string) =>
  scriptCommand(COMMIT, server, path, `h=${shQuote(checkHash(hash))}\n`);

/** `allowNoRepo` : faux pour une écriture — hors dépôt, refus net plutôt que la liste des dépôts. */
export function parseGitStatus(
  server: Server,
  path: string,
  r: ExecResult,
  allowNoRepo = true,
): ServerGitStatus {
  const p = parse(r, allowNoRepo);
  const readAt = new Date().toISOString();
  if (p.root !== null)
    return {
      serverId: server.id,
      path,
      resolved: p.resolved,
      repo: repoOf(p.root, p.recs),
      repos: [],
      readAt,
    };
  const repos = new Set<string>();
  for (const rec of p.recs) {
    if (!rec.startsWith('cand\t')) continue;
    const [, base = '', ...dir] = rec.split('\t');
    // un dépôt sous un dossier masqué (`.password-store`, `.gnupg`…) n'est pas proposé
    const repo = dir.join('\t');
    if (repo && visibleUnder(repo, base)) repos.add(repo);
  }
  return {
    serverId: server.id,
    path,
    resolved: p.resolved,
    repo: null,
    repos: [...repos].sort().slice(0, REPOS_MAX),
    readAt,
  };
}

export function parseGitLog(
  server: Server,
  path: string,
  scope: 'all' | 'branch',
  r: ExecResult,
): ServerGitLog {
  const p = parse(r);
  const repo = repoOf(p.root!, p.recs);
  const rest = p.recs.slice(8);
  const at = rest.indexOf('horshead');
  const outside = new Set(at < 0 ? [] : rest.slice(at + 1).filter(Boolean));
  const raw = (at < 0 ? rest : rest.slice(0, at)).join('\0');
  // parseLog marque dans HEAD ce qui est dans l'ensemble donné : ici, tout ce qui n'est pas hors de HEAD
  const hashes = raw
    .split('\0')
    .map((x) => x.replace(/^\n/, '').split('\x01')[0] ?? '')
    .filter((h) => h && !outside.has(h));
  const commits = parseLog(raw, new Set(hashes));
  return {
    serverId: server.id,
    path,
    scope,
    repo,
    commits,
    dirty: repo.changes > 0,
    live: {
      aheadBehind: repo.aheadBehind,
      rebaseInProgress: repo.operation === 'rebase',
      onTopicBranch: true,
      headBranch: repo.branch,
    },
    truncated: commits.length >= LOG_MAX || r.truncated,
    readAt: new Date().toISOString(),
  };
}

export function parseGitCommit(hash: string, r: ExecResult): GitCommitDetail {
  const { recs } = parse(r);
  const [h, parents, author, date, message, body, refs] = (recs[0] ?? '').split('\x01');
  const ns = recs.indexOf('/numstat');
  const st = recs.indexOf('/statut');
  const fin = recs.indexOf('/fin');
  const counts = new Map<string, { additions: number | null; deletions: number | null }>();
  for (const rec of recs.slice(ns + 1, st)) {
    const [a, d, ...rest] = rec.split('\t');
    if (!rest.length) continue;
    counts.set(rest.join('\t'), {
      additions: a === '-' ? null : Number(a),
      deletions: d === '-' ? null : Number(d),
    });
  }
  const statusByPath = new Map<string, GitFileChange['status']>();
  const named = recs.slice(st + 1, fin);
  for (let i = 0; i + 1 < named.length; i += 2) {
    const letter = named[i]![0] as GitFileChange['status'] | undefined;
    statusByPath.set(named[i + 1]!, letter && ['A', 'M', 'D', 'R'].includes(letter) ? letter : '?');
  }
  return {
    hash: h || hash,
    parents: (parents ?? '').split(' ').filter(Boolean),
    author: author ?? '',
    date: date ?? '',
    message: message ?? '',
    body: (body ?? '').trim(),
    refs: (refs ?? '').split(', ').filter(Boolean),
    inHead: recs[fin + 1] === '/inhead',
    files: [...counts.entries()].map(([file, c]) => ({
      path: file,
      status: statusByPath.get(file) ?? '?',
      additions: c.additions,
      deletions: c.deletions,
    })),
  };
}

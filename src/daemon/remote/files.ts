import type {
  Server,
  ServerFilePreview,
  ServerFsEntry,
  ServerFsListing,
} from '../../shared/model.js';
import { AidHttpError } from '../errors.js';
import type { ExecResult } from './transport.js';
import { shQuote } from './transport.js';

/**
 * Règle immuable (décision opérateur du 2026-10-30) : un secret est masqué — signalé « masqué », contenu
 * jamais lu, dossier jamais listé ; aucun réglage ne l'ouvre. D78 l'a posée ; la liste couvre aussi les
 * clés, coffres, jetons et identifiants courants. Un motif `dossier/nom` vise un nom dans un dossier précis.
 */
const KEYS = [
  // D78
  '.env*',
  '*.pem',
  '*.key',
  'id_*',
  '.ssh',
  '*.p12',
  // clés privées et coffres
  'ssh_host_*',
  '*_rsa',
  '*_dsa',
  '*_ecdsa',
  '*_ed25519',
  '*.ppk',
  '*.pfx',
  '*.p8',
  '*.pkcs12',
  '*.jks',
  '*.keystore',
  '*.kdb',
  '*.kdbx',
  '*.gpg',
  '*.asc',
  '*.ovpn',
  '.gnupg',
  '.password-store',
  'shadow',
  'shadow-',
  'gshadow',
  'gshadow-',
  'environ',
];
const TOOLS = [
  '.git-credentials',
  '.gitconfig',
  '.netrc',
  '_netrc',
  '.npmrc',
  '.yarnrc*',
  '.pypirc',
  '.pgpass',
  '.my.cnf',
  '.mylogin.cnf',
  '.msmtprc',
  '.vault-token',
  '.vault_pass*',
  '.htpasswd',
  '.s3cfg',
  '.boto',
  '.databrickscfg',
  '.dockercfg',
  'rclone.conf',
  'gradle.properties',
  'kubeconfig*',
  'service-account*.json',
  'auth.json',
  'wp-config.php',
  '*.tfstate*',
  '*.tfvars',
  '*.env',
  '.aws',
  '.azure',
  '.docker',
  '.kube',
  '.vnc',
  // historiques de shell : des secrets y sont tapés
  '*_history',
  '.*history',
  '.histfile',
  // dossier/nom : URL de remote avec jeton (dépôts nus et sous-modules compris), jetons d'outils
  '*.git/config',
  '*.git/config.worktree',
  '*.git/modules',
  '.config/gcloud',
  'gh/hosts.yml',
  'github-copilot/hosts.json',
  'github-copilot/apps.json',
  '.bundle/config',
  '.m2/settings.xml',
];
/**
 * Mots de secret : masqués sur les fichiers de données et les noms nus (`github_token`, `.secrets`), pas
 * sur le code — `PasswordInput.tsx` ou `credentials.ts` restent lisibles (décision prise pour
 * l'opérateur à la review de F.1 bis : un secret vit dans une donnée, pas dans un nom de composant).
 */
const WORDS = ['secret', 'credential', 'password', 'passwd', 'apikey', 'api_key', 'api-key'];
const DATA = [
  'json',
  'yml',
  'yaml',
  'toml',
  'ini',
  'env',
  'txt',
  'conf',
  'cfg',
  'properties',
  'xml',
];
const WORD_PATTERNS = [
  ...WORDS.flatMap((w) => [
    w,
    `${w}s`,
    `.${w}`,
    `.${w}s`,
    `*_${w}`,
    `*-${w}`,
    `*.${w}`,
    `*_${w}s`,
    ...DATA.map((ext) => `*${w}*.${ext}`),
  ]),
  // `token` plus serré : `tokens.json` (jetons de design) et `tokenizer.py` sont des fichiers ordinaires
  'token',
  'token.json',
  '.token',
  '*_token',
  '*-token',
  '*.token',
  '*_token.json',
  '*-token.json',
  'access_token*',
  'refresh_token*',
];
export const HIDDEN_PATTERNS: readonly string[] = [...KEYS, ...TOOLS, ...WORD_PATTERNS];
/**
 * Review complète : dossiers de secrets — jamais un dossier autorisé ni l'un de ses composants, même atteint par
 * un symlink. Sous un dossier autorisé, le masquage par nom les couvre déjà ; c'est le dossier autorisé lui-même
 * (`~/.kube` autorisé ouvrait `config`) qu'il fallait fermer. Les motifs de fichiers (`id_*`…) n'en sont pas :
 * `/srv/id_app/proj` autorisé reste lisible (review F.1).
 */
export const SECRET_DIRS: readonly string[] = [
  '.ssh',
  '.gnupg',
  '.password-store',
  '.aws',
  '.azure',
  '.docker',
  '.kube',
  '.vnc',
  '.config/gcloud',
  '*.git/modules',
];
/** D78 : dossiers lourds, grisés et non dépliés par défaut (le daemon les liste si on le lui demande). */
export const HEAVY_DIRS = ['node_modules', '.git', 'dist', '.venv', 'target'] as const;
/** D78 : aperçu tronqué à 256 Kio ; binaire = octet nul dans les 8 premiers Kio. */
export const PREVIEW_MAX = 256 * 1024;
const BINARY_SNIFF = 8 * 1024;
/** Un dossier de 50 000 entrées ne remonte pas en entier : le panneau en affiche une partie. */
export const ENTRIES_MAX = 2000;
const PATH_MAX = 4096;
/** Délai propre au `git status` (s) : un gros dépôt perd ses badges, pas son listing (review F.1). */
const GIT_TIMEOUT_S = 8;
/** Marque le début de la réponse : ce qu'un profil de connexion écrit avant est ignoré (review F.1). */
const MARK = 'aid-fs';

const NAMES: string[] = HIDDEN_PATTERNS.filter((p) => !p.includes('/'));
const PAIRS: string[] = HIDDEN_PATTERNS.filter((p) => p.includes('/'));
// sans casse (review F.1) : sur un système de fichiers insensible, `.ENV` est le même fichier que `.env`
const glob = (p: string) =>
  new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'is');
const NAME_RE = NAMES.map(glob);
const PAIR_RE = PAIRS.map(glob);
// mêmes listes côté `sh` : chaque lettre en classe `[eE]`
const shCase = (ps: string[]) =>
  ps
    .map((p) => p.replace(/[a-zA-Z]/g, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`))
    .join(' | ');
/** Exportés pour le test de parité `case` / regex. */
export const HIDDEN_CASE = shCase(NAMES);
export const HIDDEN_PAIR_CASE = shCase(PAIRS);
const SECRET_NAMES = SECRET_DIRS.filter((p) => !p.includes('/'));
const SECRET_PAIRS = SECRET_DIRS.filter((p) => p.includes('/'));
const SECRET_NAME_RE = SECRET_NAMES.map(glob);
const SECRET_PAIR_RE = SECRET_PAIRS.map(glob);
export const SECRET_CASE = shCase(SECRET_NAMES);
export const SECRET_PAIR_CASE = shCase(SECRET_PAIRS);

/** Un composant de `dir` (dossier autorisé, lexical ou résolu) est un dossier de secrets. */
export function secretDirIn(dir: string): boolean {
  let prev = '';
  for (const c of dir.split('/')) {
    if (c === '' || c === '.') continue;
    if (SECRET_NAME_RE.some((re) => re.test(c))) return true;
    if (SECRET_PAIR_RE.some((re) => re.test(`${prev}/${c}`))) return true;
    prev = c;
  }
  return false;
}

/** `parent` : nom du dossier qui contient `name`, pour les motifs `dossier/nom`. */
export function isHidden(name: string, parent = ''): boolean {
  return NAME_RE.some((re) => re.test(name)) || PAIR_RE.some((re) => re.test(`${parent}/${name}`));
}

const lastOf = (p: string) => p.split('/').filter(Boolean).at(-1) ?? '';

/** Composants de `rest`, chemin pris sous un dossier dont le dernier composant est `parent`. */
function hiddenIn(rest: string, parent: string): boolean {
  let prev = parent;
  for (const c of rest.split('/')) {
    // `.` ne change pas de dossier : `.git/./config` reste `.git/config` (review F.1 bis)
    if (c === '' || c === '.') continue;
    if (isHidden(c, prev)) return true;
    prev = c;
  }
  return false;
}

const trimSlash = (d: string) => (d.length > 1 && d.endsWith('/') ? d.slice(0, -1) : d);

/** Plus long dossier autorisé qui contient le chemin (lexicalement) et la partie du chemin dessous. */
function underAllowed(path: string, allowed: string[]): { base: string; rest: string } | null {
  let best: string | null = null;
  for (const d of allowed.map(trimSlash)) {
    const inside = path === d || path.startsWith(d === '/' ? '/' : `${d}/`);
    if (inside && (best === null || d.length > best.length)) best = d;
  }
  return best === null ? null : { base: best, rest: path.slice(best.length) };
}

/**
 * `~`, `~/…` ou absolu ; le reste (relatif, octet nul, saut de ligne) est refusé avant tout aller-retour,
 * comme un nom masqué sous un dossier autorisé. Les composants au-dessus du dossier autorisé ne comptent
 * pas (review F.1) : `/srv/id_app/proj` autorisé reste lisible.
 */
export function checkRemotePath(server: Server, path: string): string {
  if (path.length === 0 || path.length > PATH_MAX || /[\0\n\r]/.test(path))
    throw new AidHttpError(400, 'chemin invalide');
  if (!(path === '~' || path.startsWith('~/') || path.startsWith('/')))
    throw new AidHttpError(400, 'chemin attendu : ~, ~/… ou absolu');
  const u = underAllowed(path, server.allowedDirs);
  if (u !== null && hiddenIn(u.rest, lastOf(u.base)))
    throw new AidHttpError(403, REFUSALS.masque![1]);
  return path;
}

/**
 * Préambule commun (POSIX `sh`, lancé par le shell de connexion) : `$1` = chemin demandé, la suite =
 * dossiers autorisés. Résout le chemin par `realpath` sur le serveur — symlinks compris —, vérifie qu'il
 * tombe dans un dossier autorisé résolu de même, puis qu'aucun composant sous ce dossier n'est masqué.
 * Un chemin absent est jugé sur son plus proche parent existant : hors périmètre, la réponse est 403
 * qu'il existe ou non — pas de sondage du disque par 403 / 404 (review F.1).
 * Réponse : la marque, puis des enregistrements terminés par un octet nul, l'état en premier.
 */
const PRELUDE = `export LC_ALL=C
printf '\\000${MARK}\\000'
command -v realpath >/dev/null 2>&1 || { printf 'norealpath\\000'; exit 0; }
x() { case "$1" in "~") printf '%s\\n' "$HOME" ;; "~/"*) printf '%s/%s\\n' "$HOME" "\${1#"~/"}" ;; *) printf '%s\\n' "$1" ;; esac; }
p=$(x "$1"); shift
if r=$(realpath "$p" 2>/dev/null) && [ -e "$r" ]; then e=1; else
  e=; r=$p
  while [ "$r" != / ]; do
    r=$(dirname "$r")
    q=$(realpath "$r" 2>/dev/null) && [ -e "$q" ] && { r=$q; break; }
  done
fi
ok=; b=
for a in "$@"; do
  a=$(realpath "$(x "$a")" 2>/dev/null) || continue
  [ "$a" = / ] && a=
  case "$r" in "$a" | "$a"/*) ok=1; [ \${#a} -ge \${#b} ] && b=$a ;; esac
done
[ -n "$ok" ] || { printf 'refus\\000'; exit 0; }
set -f; IFS=/; prev=
for c in $b; do
  case "$c" in '' | .) continue ;; esac
  case "$c" in ${SECRET_CASE}) printf 'masque\\000'; exit 0 ;; esac
  case "$prev/$c" in ${SECRET_PAIR_CASE}) printf 'masque\\000'; exit 0 ;; esac
  prev=$c
done
unset IFS; set +f
[ -n "$e" ] || { printf 'absent\\000'; exit 0; }
set -f; IFS=/; prev=\${b##*/}
for c in \${r#"$b"}; do
  case "$c" in '' | .) continue ;; esac
  case "$c" in ${HIDDEN_CASE}) printf 'masque\\000'; exit 0 ;; esac
  case "$prev/$c" in ${HIDDEN_PAIR_CASE}) printf 'masque\\000'; exit 0 ;; esac
  prev=$c
done
unset IFS; set +f
`;

/**
 * Un niveau, jamais l'arbre ; badges `git status` du dossier sans écrire dans le dépôt : ni verrou ni
 * rafraîchissement de l'index, ni fsmonitor ni cache des non-suivis (review F.1).
 */
const LIST = `[ -d "$r" ] || { printf 'pasdossier\\000'; exit 0; }
cd "$r" 2>/dev/null || { printf 'illisible\\000'; exit 0; }
printf 'ok\\000%s\\000%s\\000' "$r" "$b"
n=0
for e in * .[!.]* ..?*; do
  [ -e "$e" ] || [ -L "$e" ] || continue
  n=$((n + 1)); [ "$n" -gt ${ENTRIES_MAX} ] && { printf 'plus\\000'; break; }
  if [ -d "$e" ]; then t=d; elif [ -f "$e" ]; then t=f; else t=o; fi
  [ -L "$e" ] && t="$t"l
  printf 'e\\t%s\\t%s\\000' "$t" "$e"
done
if command -v git >/dev/null 2>&1 && [ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true ]; then
  printf 'git\\t%s\\000' "$(git rev-parse --show-prefix)"
  to=; command -v timeout >/dev/null 2>&1 && to="timeout ${GIT_TIMEOUT_S}"
  GIT_OPTIONAL_LOCKS=0 $to git --no-optional-locks -c core.fsmonitor=false -c core.untrackedCache=false \\
    status --porcelain -z --untracked-files=normal -- . 2>/dev/null
  # toujours le dernier enregistrement : absent (sortie coupée) ou non nul, les badges sont incomplets (chantier 19, S.3)
  printf 'gitrc\\t%s\\000' "$?"
fi
`;

/** Taille, nombre d'octets nuls en tête, puis le début du fichier s'il n'est pas binaire. */
const READ = `[ -f "$r" ] || { printf 'pasfichier\\000'; exit 0; }
[ -r "$r" ] || { printf 'illisible\\000'; exit 0; }
s=$(wc -c < "$r" | tr -d ' ')
z=$(head -c ${BINARY_SNIFF} "$r" | tr -dc '\\000' | wc -c | tr -d ' ')
printf 'ok\\000%s\\000%s\\000%s\\000%s\\000' "$r" "$b" "$s" "$z"
[ "$z" = 0 ] && head -c ${PREVIEW_MAX} "$r"
exit 0
`;

function command(script: string, server: Server, path: string): string {
  const args = [path, ...server.allowedDirs].map(shQuote).join(' ');
  return `sh -c ${shQuote(PRELUDE + script)} sh ${args}`;
}

export const listCommand = (server: Server, path: string) => command(LIST, server, path);
export const readCommand = (server: Server, path: string) => command(READ, server, path);

const REFUSALS: Record<string, [number, string]> = {
  absent: [404, 'chemin introuvable sur le serveur'],
  refus: [403, 'chemin hors des dossiers autorisés du serveur'],
  masque: [403, 'fichier masqué : contenu jamais lu (D78)'],
  pasdossier: [400, 'ce chemin n’est pas un dossier'],
  pasfichier: [400, 'ce chemin n’est pas un fichier'],
  illisible: [403, 'lecture refusée par le serveur (permissions)'],
  norealpath: [502, 'realpath introuvable sur le serveur : lecture des fichiers impossible'],
};

/**
 * Enregistrements après la marque : `ok`, chemin résolu, dossier autorisé qui l'a validé, puis la suite.
 * Un refus connu devient son code ; une sortie sans marque ni état, l'échec de la commande.
 */
function records(r: ExecResult): string[] {
  const all = r.stdout.split('\0');
  const at = all.indexOf(MARK);
  const recs = at < 0 ? [] : all.slice(at + 1);
  const state = recs[0] ?? '';
  const refusal = REFUSALS[state];
  if (refusal) throw new AidHttpError(refusal[0], refusal[1]);
  if (state !== 'ok') {
    const why = r.stderr.trim().split('\n').at(-1) || `code de sortie ${r.code}`;
    throw new AidHttpError(502, `lecture impossible sur le serveur : ${why}`);
  }
  // défense en profondeur : le script a déjà vérifié périmètre et masqués, le daemon le revérifie
  const [, resolved = '', base = ''] = recs;
  const inside = resolved === base || resolved.startsWith(`${base}/`) || base === '';
  if (!resolved.startsWith('/') || !inside) throw new AidHttpError(403, REFUSALS.refus![1]);
  if (secretDirIn(base)) throw new AidHttpError(403, REFUSALS.masque![1]);
  if (hiddenIn(resolved.slice(base.length), lastOf(base)))
    throw new AidHttpError(403, REFUSALS.masque![1]);
  return recs;
}

/** F.2 : chemin résolu du serveur sous `base` (résolu aussi, `''` pour `/`), sans composant masqué dessous. */
export function visibleUnder(path: string, base: string): boolean {
  const inside = path === base || path.startsWith(`${base}/`) || base === '';
  if (secretDirIn(base)) return false;
  return path.startsWith('/') && inside && !hiddenIn(path.slice(base.length), lastOf(base));
}

// F.2 : l'onglet Git passe par le même préambule et la même relecture que les fichiers
export { command, records };

function badges(recs: string[], at: number): Map<string, 'M' | '?'> | null {
  if (at < 0) return null;
  const prefix = recs[at]!.slice(4);
  const out = new Map<string, 'M' | '?'>();
  const set = (name: string, b: 'M' | '?') => {
    if (out.get(name) !== 'M') out.set(name, b);
  };
  for (let i = at + 1; i < recs.length; i++) {
    const rec = recs[i]!;
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    // `-z` : un renommage ou une copie (index ou arbre de travail) est suivi de son chemin d'origine
    if (/[RC]/.test(xy)) i++;
    if (xy === '!!') continue;
    const path = rec.slice(3);
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const b = xy === '??' ? '?' : 'M';
    // dossier courant entièrement non suivi : git le rend d'un bloc (`?? sous/`)
    if (rest === '') out.set('', b);
    else set(rest.split('/')[0]!, b);
  }
  return out;
}

export function parseListing(server: Server, path: string, r: ExecResult): ServerFsListing {
  const recs = records(r);
  const at = recs.findIndex((x) => x.startsWith('git\t'));
  // S.3 : le code de sortie de `git status`, dernier enregistrement non vide quand la sortie est entière
  const last = recs.findLastIndex((x) => x !== '');
  const rc = at >= 0 && last > at && /^gitrc\t\d+$/.test(recs[last]!) ? last : -1;
  const git = badges(rc < 0 ? recs : recs.slice(0, rc), at);
  const whole = git?.get('') ?? null;
  const entries: ServerFsEntry[] = [];
  // les entrées s'arrêtent à la section git : un chemin de `git status` n'en est jamais une
  const listed = at < 0 ? recs : recs.slice(0, at);
  for (const rec of listed) {
    if (!rec.startsWith('e\t')) continue;
    const tab = rec.indexOf('\t', 2);
    const t = rec.slice(2, tab);
    const name = rec.slice(tab + 1);
    const kind = t[0] === 'd' ? 'dir' : t[0] === 'f' ? 'file' : 'other';
    entries.push({
      name,
      kind,
      symlink: t.endsWith('l'),
      hidden: isHidden(name, lastOf(recs[1]!)),
      heavy: kind === 'dir' && (HEAVY_DIRS as readonly string[]).includes(name),
      git: whole ?? git?.get(name) ?? null,
    });
  }
  entries.sort((a, b) =>
    a.kind === 'dir' && b.kind !== 'dir'
      ? -1
      : b.kind === 'dir' && a.kind !== 'dir'
        ? 1
        : a.name.localeCompare(b.name),
  );
  return {
    serverId: server.id,
    path,
    resolved: recs[1]!,
    entries,
    // `plus` : le plafond d'entrées ; `r.truncated` : la sortie elle-même coupée (git status d'un gros dépôt)
    truncated: listed.includes('plus') || r.truncated,
    git: git !== null,
    gitPartial: git !== null && (rc < 0 || recs[rc] !== 'gitrc\t0'),
    readAt: new Date().toISOString(),
  };
}

export function parsePreview(server: Server, path: string, r: ExecResult): ServerFilePreview {
  const recs = records(r);
  const size = Number(recs[3] ?? 0);
  const binary = (recs[4] ?? '0') !== '0';
  return {
    serverId: server.id,
    path,
    resolved: recs[1]!,
    size,
    binary,
    truncated: !binary && (size > PREVIEW_MAX || r.truncated),
    // le contenu peut lui-même porter des octets nuls au-delà des 8 premiers Kio : on les rend tels quels
    content: binary ? null : recs.slice(5).join('\0'),
    readAt: new Date().toISOString(),
  };
}

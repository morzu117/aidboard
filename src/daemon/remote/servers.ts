import type { PermissionMode } from '../../shared/agentSettings.js';
import type { Server, ServerMode, ServerRule, ServerSshOptions } from '../../shared/model.js';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';

export interface ServerRow {
  id: string;
  name: string;
  mode: ServerMode;
  target: string;
  ssh_options: string | null;
  load_profile: number;
  workdir: string;
  shell: string;
  keep_session: number;
  permission_mode: PermissionMode;
  confirm_destructive: number;
  allowed_dirs: string;
  group_name: string;
  color: string;
  detected_agents: string | null;
  last_test_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RuleRow {
  id: string;
  server_id: string;
  pattern: string;
  created_at: string;
}

export const SERVER_MODES: readonly ServerMode[] = ['ssh_alias', 'ssh_host', 'command'];
export const SERVER_PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'auto',
  'plan',
];
export const DEFAULT_SERVER_COLOR = '#5de0a1';

// Tout ce qui finit en argument d'une commande `ssh` (D72) : jamais d'espace, jamais de tiret en tête
// (sinon `ssh` le lirait comme une option : `-oProxyCommand=…` exécuterait une commande locale).
const SSH_NAME_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.@:-]*$/;
const SSH_USER_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
const SHELL_RE = /^[A-Za-z0-9_./-]+$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
// Caractères de contrôle (saut de ligne, NUL…) : interdits partout, ils casseraient la commande distante.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function serverFromRow(r: ServerRow, rules: ServerRule[]): Server {
  return {
    id: r.id,
    name: r.name,
    mode: r.mode,
    target: r.target,
    sshOptions: parseJson<ServerSshOptions | null>(r.ssh_options, null),
    loadProfile: !!r.load_profile,
    workdir: r.workdir,
    shell: r.shell,
    keepSession: !!r.keep_session,
    permissionMode: r.permission_mode,
    confirmDestructive: !!r.confirm_destructive,
    allowedDirs: parseJson<string[]>(r.allowed_dirs, []),
    groupName: r.group_name,
    color: r.color,
    detectedAgents: parseJson<string[] | null>(r.detected_agents, null),
    lastTestAt: r.last_test_at,
    rules,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rulesOf(db: Db, serverId: string): ServerRule[] {
  return (
    db
      .prepare('SELECT * FROM server_rules WHERE server_id = ? ORDER BY created_at, id')
      .all(serverId) as RuleRow[]
  ).map((r) => ({ id: r.id, pattern: r.pattern, createdAt: r.created_at }));
}

export function listServers(db: Db): Server[] {
  const rows = db.prepare('SELECT * FROM servers ORDER BY created_at, id').all() as ServerRow[];
  return rows.map((r) => serverFromRow(r, rulesOf(db, r.id)));
}

export function getServer(db: Db, id: string): Server | null {
  const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as ServerRow | undefined;
  return row ? serverFromRow(row, rulesOf(db, row.id)) : null;
}

/** Ce qu'un client peut écrire : tout `Server` sauf l'identité, les dates, le résultat du test et les règles. */
export type ServerInput = Pick<Server, 'name' | 'mode' | 'target'> &
  Partial<
    Pick<
      Server,
      | 'sshOptions'
      | 'loadProfile'
      | 'workdir'
      | 'shell'
      | 'keepSession'
      | 'permissionMode'
      | 'confirmDestructive'
      | 'allowedDirs'
      | 'groupName'
      | 'color'
    >
  >;

function invalid(message: string): never {
  throw new AidHttpError(400, message);
}

function text(field: string, value: string): string {
  const v = value.trim();
  if (v.length === 0) invalid(`${field} ne peut pas être vide`);
  if (CONTROL_RE.test(v)) invalid(`${field} contient un caractère de contrôle`);
  return v;
}

function remotePath(field: string, value: string): string {
  const v = text(field, value);
  if (!(v === '~' || v.startsWith('~/') || v.startsWith('/')))
    invalid(`${field} doit être absolu ou commencer par ~`);
  return v;
}

function sshOptions(o: ServerSshOptions | null | undefined): ServerSshOptions | null {
  if (!o) return null;
  if (o.port !== null && (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535))
    invalid('port doit être un entier entre 1 et 65535');
  if (o.user !== null && !SSH_USER_RE.test(o.user)) invalid('utilisateur SSH invalide');
  if (o.jump !== null && !SSH_NAME_RE.test(o.jump)) invalid('hôte de saut invalide');
  if (o.identityFile !== null) {
    const f = text('chemin de clé', o.identityFile);
    if (f.startsWith('-')) invalid('chemin de clé invalide');
  }
  return {
    port: o.port,
    user: o.user,
    identityFile: o.identityFile === null ? null : o.identityFile.trim(),
    jump: o.jump,
  };
}

/** Valide et normalise une saisie complète (création, ou serveur existant fusionné avec un PATCH). */
export function validateServer(input: ServerInput): Required<ServerInput> {
  const name = text('name', input.name);
  if (!SERVER_MODES.includes(input.mode)) invalid('mode inconnu');
  const target = text('target', input.target);
  if (input.mode !== 'command' && !SSH_NAME_RE.test(target))
    invalid(
      input.mode === 'ssh_alias'
        ? 'alias SSH invalide (lettres, chiffres, . _ - @ :, pas de tiret en tête)'
        : 'hôte SSH invalide (lettres, chiffres, . _ - @ :, pas de tiret en tête)',
    );
  const shell = input.shell === undefined ? 'bash' : text('shell', input.shell);
  if (!SHELL_RE.test(shell)) invalid('shell distant invalide');
  const permissionMode = input.permissionMode ?? 'default';
  if (!SERVER_PERMISSION_MODES.includes(permissionMode)) invalid('mode d’exécution inconnu');
  const color = input.color ?? DEFAULT_SERVER_COLOR;
  if (!COLOR_RE.test(color)) invalid('color doit être un hex #rrggbb');
  const allowedDirs = (input.allowedDirs ?? ['~']).map((d) => remotePath('dossier autorisé', d));
  return {
    name,
    mode: input.mode,
    target,
    sshOptions: input.mode === 'ssh_host' ? sshOptions(input.sshOptions) : null,
    loadProfile: input.loadProfile ?? true,
    workdir: input.workdir === undefined ? '~' : remotePath('workdir', input.workdir),
    shell,
    keepSession: input.keepSession ?? true,
    permissionMode,
    confirmDestructive: input.confirmDestructive ?? true,
    allowedDirs: [...new Set(allowedDirs)],
    groupName: input.groupName === undefined ? 'Serveurs' : text('groupName', input.groupName),
    color,
  };
}

/** Nom affiché unique (§11.2), comparé sans casse : deux « vps-ovh » ne se distinguent pas dans la barre. */
export function assertNameFree(db: Db, name: string, exceptId?: string): void {
  const other = db
    .prepare('SELECT id FROM servers WHERE lower(name) = lower(?) AND id IS NOT ?')
    .get(name, exceptId ?? null) as { id: string } | undefined;
  if (other) throw new AidHttpError(409, `un serveur s’appelle déjà « ${name} »`);
}

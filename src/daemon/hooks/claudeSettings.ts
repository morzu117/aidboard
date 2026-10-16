import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Les entrées qu'A-I-D ajoute à la configuration de Claude Code, reconnues à la sous-chaîne AID_HOOK.
export const HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Notification',
  'Stop',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

const MARK = 'AID_HOOK';
// UserPromptSubmit et Stop ignorent le matcher ; celui de Notification porte sur notification_type
const MATCHER: Partial<Record<HookEvent, string>> = {
  PreToolUse: '*',
  PostToolUse: '*',
  PermissionRequest: '*',
  Notification: 'elicitation_dialog',
};

// `|| true` : un code 2 bloquerait l'outil dans Claude Code ; le hook ne doit jamais rien empêcher
export const hookCommand = (event: HookEvent) =>
  `[ -z "$${MARK}" ] || sh "$${MARK}" ${event} || true`;

interface HookEntry {
  type?: string;
  command?: string;
  [k: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
  [k: string]: unknown;
}
type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> };

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), '.claude'), 'settings.json');
}

const ours = (h: HookEntry) => typeof h.command === 'string' && h.command.includes(MARK);

function read(path: string): { settings: Settings; existed: boolean; raw: string } {
  if (!existsSync(path)) return { settings: {}, existed: false, raw: '' };
  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    // jamais réécrire un fichier qu'on ne comprend pas : on perdrait la configuration de l'utilisateur
    throw new Error(`${path} n'est pas du JSON valide : rien n'est modifié`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`${path} n'est pas un objet JSON : rien n'est modifié`);
  return { settings: parsed as Settings, existed: true, raw };
}

export interface HooksStatus {
  path: string;
  installed: boolean;
  missing: HookEvent[];
}

export function hooksStatus(path = settingsPath()): HooksStatus {
  let settings: Settings = {};
  try {
    settings = read(path).settings;
  } catch {
    settings = {};
  }
  const missing = HOOK_EVENTS.filter(
    (ev) =>
      !(settings.hooks?.[ev] ?? []).some((g) =>
        (g.hooks ?? []).some((h) => ours(h) && h.command === hookCommand(ev)),
      ),
  );
  return { path, installed: missing.length === 0, missing };
}

/** Retire nos entrées ; un groupe ou un événement que cela vide disparaît, le reste est intact. */
function strip(settings: Settings): Settings {
  if (!settings.hooks || typeof settings.hooks !== 'object') return settings;
  const hooks: Record<string, HookGroup[]> = {};
  for (const [ev, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) {
      hooks[ev] = groups;
      continue;
    }
    const kept = groups
      .map((g) => (Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !ours(h)) } : g))
      .filter((g) => !Array.isArray(g.hooks) || g.hooks.length > 0);
    if (kept.length > 0) hooks[ev] = kept;
  }
  const out: Settings = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete out.hooks;
  return out;
}

function write(path: string, before: { existed: boolean; raw: string }, next: Settings, now: Date) {
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (before.existed && text === before.raw) return { changed: false as const };
  let backup: string | undefined;
  if (before.existed) {
    backup = `${path}.aid-${now.toISOString().replace(/[:.]/g, '-')}.bak`;
    copyFileSync(path, backup);
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }
  writeFileSync(path, text);
  return { changed: true as const, backup };
}

export function installHooks(path = settingsPath(), now = new Date()) {
  const before = read(path);
  if (before.existed && hooksStatus(path).installed) return { changed: false as const };
  const next = strip(before.settings);
  const hooks = { ...(next.hooks ?? {}) };
  for (const ev of HOOK_EVENTS) {
    const group: HookGroup = {
      ...(MATCHER[ev] && { matcher: MATCHER[ev] }),
      hooks: [{ type: 'command', command: hookCommand(ev), timeout: 5 }],
    };
    hooks[ev] = [...(hooks[ev] ?? []), group];
  }
  return write(path, before, { ...next, hooks }, now);
}

export function uninstallHooks(path = settingsPath(), now = new Date()) {
  const before = read(path);
  if (!before.existed) return { changed: false as const };
  return write(path, before, strip(before.settings), now);
}

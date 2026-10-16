import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { statSync } from 'node:fs';
import { onPath } from '../../daemon/actions/editor.js';
import { readProcVersion } from '../../daemon/routes/workspaces.js';
import { loadConfig } from '../../daemon/config.js';
import type { MemoryHealth } from '../../daemon/memory/service.js';
import type { AidPaths } from '../../daemon/paths.js';
import { isWsl } from '../browser.js';
import { hooksStatus } from '../../daemon/hooks/claudeSettings.js';
import { daemonFetch, runningDaemon } from '../daemonInfo.js';
import { readVersion } from '../version.js';

export type Level = 'ok' | 'warn' | 'ko';
export interface Check {
  level: Level;
  label: string;
  detail?: string;
}

export interface Probes {
  nodeVersion: string;
  platform: NodeJS.Platform;
  procVersion: string | null;
  has(bin: string): boolean;
  version(bin: string, args: string[]): Promise<string | null>;
  loadPty(): Promise<string | null>; // null = chargé, sinon le message d'erreur
  loadSqlite(): Promise<string | null>;
  homeMode(): number | null; // null = ~/.aid absent
  port(): Promise<{ port: number; state: 'aid' | 'libre' | 'occupe' }>;
  claudeHooks(): boolean; // les hooks d'A-I-D sont-ils dans la configuration de Claude Code ?
  memoryHealth(): Promise<MemoryHealth | null>; // null = daemon arrêté ou injoignable
}

export function nodeSupported(v: string): boolean {
  const [major = 0, minor = 0] = v.replace(/^v/, '').split('.').map(Number);
  return (major === 22 && minor >= 12) || major === 23 || major === 24;
}

export function gitAtLeast(output: string, major: number, minor: number): boolean {
  const m = /(\d+)\.(\d+)/.exec(output);
  if (!m) return true;
  return Number(m[1]) > major || (Number(m[1]) === major && Number(m[2]) >= minor);
}

export async function runChecks(p: Probes): Promise<Check[]> {
  const c: Check[] = [];
  const add = (level: Level, label: string, detail?: string) =>
    c.push({ level, label, ...(detail && { detail }) });
  // une condition, deux issues : ok ou le niveau d'échec voulu
  const verify = (
    ok: boolean,
    label: string,
    fail: { level: Level; label?: string; detail: string },
  ) => (ok ? add('ok', label) : add(fail.level, fail.label ?? label, fail.detail));

  verify(nodeSupported(p.nodeVersion), `node ${p.nodeVersion}`, {
    level: 'ko',
    detail: 'version prise en charge : 22.12 à 24 (mise install node@22)',
  });

  const pty = await p.loadPty();
  const ptyHelp =
    p.platform === 'linux'
      ? 'Linux et WSL2 : sudo apt install build-essential python3, puis npm rebuild node-pty'
      : 'réinstaller : npm rebuild node-pty';
  verify(pty === null, 'node-pty : un terminal se lance', {
    level: 'ko',
    label: 'node-pty',
    detail: `${pty}. ${ptyHelp}`,
  });

  const sqlite = await p.loadSqlite();
  verify(sqlite === null, 'better-sqlite3', {
    level: 'ko',
    detail: `${sqlite}. npm rebuild better-sqlite3`,
  });

  const git = await p.version('git', ['--version']);
  if (!git) add('ko', 'git', 'introuvable');
  else
    verify(gitAtLeast(git, 2, 38), git, {
      level: 'warn',
      detail: 'git 2.38 ou plus recommandé pour les worktrees',
    });

  verify(p.has('bash'), 'bash', {
    level: 'ko',
    detail: 'introuvable : les scripts d’action sont en bash',
  });

  for (const [bin, effet] of [
    ['claude', 'l’agent claude sera refusé'],
    ['codex', 'l’agent codex sera refusé'],
    ['codegraph', 'les sujets seront sans index : lecture directe'],
    ['gh', 'requis à partir de la v0.3 (PR et fusion)'],
    ['ollama', 'la recherche sera FTS5 seule'],
  ] as const) {
    verify(p.has(bin), bin, { level: 'warn', label: `${bin} introuvable`, detail: effet });
  }

  const mode = p.homeMode();
  if (mode !== null) {
    const perms = mode & 0o777;
    verify(perms === 0o700, '~/.aid en 0700', {
      level: 'ko',
      label: `~/.aid en ${perms.toString(8)}`,
      detail: 'les journaux de terminaux peuvent contenir des secrets : chmod 700 ~/.aid',
    });
  }

  const port = await p.port();
  verify(
    port.state !== 'occupe',
    port.state === 'aid' ? `port ${port.port} : le daemon A-I-D tourne` : `port ${port.port} libre`,
    {
      level: 'ko',
      label: `port ${port.port} occupé`,
      detail: 'par autre chose qu’A-I-D : changer `port` dans ~/.aid/config.yaml',
    },
  );

  if (p.has('claude')) {
    verify(p.claudeHooks(), 'hooks Claude Code installés', {
      level: 'warn',
      label: 'hooks Claude Code absents',
      detail: 'les statuts de claude seront seulement estimés : aid hooks install',
    });
  }

  if (isWsl(p.procVersion)) {
    verify(p.has('wslview'), 'wslview', {
      level: 'warn',
      label: 'wslview introuvable',
      detail: 'le navigateur Windows ne s’ouvrira pas tout seul : sudo apt install wslu',
    });
  }

  const mem = await p.memoryHealth();
  if (mem) {
    const total = Object.values(mem.pages).reduce((a, b) => a + b, 0);
    const detail = Object.entries(mem.pages)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ns, n]) => `${ns} ${n}`)
      .join(', ');
    const label = `mémoire : ${total} page${total === 1 ? '' : 's'}${detail ? ` (${detail})` : ''}`;
    const reasons: string[] = [];
    if (mem.mirrorDirty) reasons.push('miroir non commité : aid mem reindex');
    if (mem.failedJobs > 0) {
      reasons.push(
        `${mem.failedJobs} job${mem.failedJobs === 1 ? '' : 's'} d’embedding en échec : voir le journal du daemon`,
      );
    }
    verify(reasons.length === 0, label, { level: 'warn', label, detail: reasons.join(' ; ') });
  }
  return c;
}

const run = (bin: string, args: string[]) =>
  new Promise<string | null>((resolve) => {
    execFile(bin, args, { timeout: 5000 }, (err, stdout) =>
      resolve(err ? null : (stdout.trim().split('\n')[0] ?? '')),
    );
  });

export function realProbes(paths: AidPaths): Probes {
  const require = createRequire(import.meta.url);
  return {
    nodeVersion: process.version,
    platform: process.platform,
    procVersion: readProcVersion(),
    has: (b) => onPath(b),
    version: run,
    async loadPty() {
      try {
        const { ptyPreflight } = await import('../../daemon/pty/native.js');
        await ptyPreflight();
        return null;
      } catch (err) {
        return (err as Error).message;
      }
    },
    async loadSqlite() {
      try {
        const Database = require('better-sqlite3') as new (path: string) => { close(): void };
        new Database(':memory:').close();
        return null;
      } catch (err) {
        return (err as Error).message;
      }
    },
    homeMode() {
      try {
        return statSync(paths.home).mode;
      } catch {
        return null;
      }
    },
    claudeHooks: () => hooksStatus().installed,
    async port() {
      const { port } = loadConfig(paths);
      if (await runningDaemon(paths)) return { port, state: 'aid' };
      return new Promise((resolve) => {
        const s = createServer();
        s.once('error', () => resolve({ port, state: 'occupe' }));
        s.listen(port, '127.0.0.1', () => s.close(() => resolve({ port, state: 'libre' })));
      });
    },
    async memoryHealth() {
      const info = await runningDaemon(paths);
      if (!info) return null;
      try {
        const { status, json } = await daemonFetch(info, 'GET', '/api/memory/health');
        return status === 200 ? (json as unknown as MemoryHealth) : null;
      } catch {
        return null;
      }
    },
  };
}

const MARK: Record<Level, string> = { ok: '✓', warn: '⚠', ko: '✗' };

export async function runDoctor(
  paths: AidPaths,
  probes: Probes = realProbes(paths),
  out: (s: string) => void = console.log,
): Promise<number> {
  out(`aidboard ${readVersion()}`);
  const checks = await runChecks(probes);
  for (const k of checks) out(`  ${MARK[k.level]} ${k.label}${k.detail ? ` : ${k.detail}` : ''}`);
  return checks.some((k) => k.level === 'ko') ? 1 : 0;
}

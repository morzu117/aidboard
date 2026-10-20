import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, statSync } from 'node:fs';
import { onPath } from '../../daemon/actions/editor.js';
import { readProcVersion } from '../../daemon/routes/workspaces.js';
import { loadConfig } from '../../daemon/config.js';
import type { MemoryHealth } from '../../daemon/memory/service.js';
import type { AidPaths } from '../../daemon/paths.js';
import type { IndexStatus } from '../../shared/structural.js';
import { isWsl } from '../browser.js';
import { hooksStatus } from '../../daemon/hooks/claudeSettings.js';
import { daemonFetch, runningDaemon } from '../daemonInfo.js';
import { readVersion } from '../version.js';
import { currentServer, installMode } from '../../daemon/install.js';
import type { InstallMode } from '../../shared/model.js';

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
  mcpRegistration(): boolean; // true si `aid-memory` (06.5) est encore enregistré dans ~/.claude.json (DS10)
  structural(): Promise<IndexStatus | null>; // état du premier workspace ; null = daemon arrêté, aucun workspace, ou index indisponible
  install(): { mode: InstallMode; version: string | null }; // 13.2 : comment cette CLI est installée ; version = celle de ~/.aid/server/current (mode release)
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

// Pas une erreur (pièges du chantier 08 : builtWith peut dépasser la CLI), juste à afficher.
export function versionDecalage(cliLine: string, builtWith: string | null): string | undefined {
  if (!builtWith || cliLine.includes(builtWith)) return undefined;
  const cli = /(\d+\.\d+\.\d+)/.exec(cliLine)?.[1] ?? cliLine;
  return `CLI ${cli}, index bâti par ${builtWith} : reindex conseillé`;
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

  // 13.2 (DR5) : le mode gouverne la mise à jour ; `inconnu` = aucune (tarball installé à la main).
  const inst = p.install();
  if (inst.mode === 'repo')
    add('ok', 'installation : mode repo (clone git, mise à jour par pull et build)');
  else if (inst.mode === 'release')
    add(
      'ok',
      `installation : release ${inst.version ?? '?'} (~/.aid/server, mise à jour par les releases GitHub)`,
    );
  else
    add(
      'warn',
      'installation : mode inconnu',
      'ni clone git ni ~/.aid/server au-dessus du build : la mise à jour est désactivée (install-server.sh)',
    );

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

  // La seule présence du binaire ne dit rien de la session : topic.pr/topic.merge
  // appellent `gh` en tant qu'utilisateur courant, pas en tant que simple exécutable.
  if (p.has('gh')) {
    const authed = await p.version('gh', ['auth', 'status']);
    verify(authed !== null, 'gh : authentifié', {
      level: 'warn',
      label: 'gh non authentifié',
      detail: 'gh auth login requis pour ouvrir ou fusionner des PR (v0.3)',
    });
  }

  // Présence seule déjà couverte par la boucle ci-dessus (warn si absent) : ici, la version,
  // pour repérer d'un coup d'œil un décalage avec l'index déjà bâti sur un dépôt (chantier 08).
  if (p.has('codegraph')) {
    const v = await p.version('codegraph', ['--version']);
    if (v === null) {
      add(
        'warn',
        'codegraph : version illisible',
        '`codegraph --version` a échoué : impossible de repérer un décalage avec un index déjà bâti',
      );
    } else {
      const idx = await p.structural();
      add('ok', `codegraph ${v}`, versionDecalage(v, idx?.builtWith ?? null));
    }
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
    // DS10 (chantier 08) : l'ancien nom casse une fois, puis les agents doivent se réenregistrer.
    if (p.mcpRegistration()) {
      add(
        'warn',
        'serveur MCP enregistré sous `aid-memory`',
        'ré-enregistrer sous `aid` : claude mcp remove --scope user aid-memory && claude mcp add --scope user aid -- aid mcp',
      );
    }
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
    mcpRegistration: () => mcpServerNames(claudeJsonPath()).includes('aid-memory'),
    install() {
      const mode = installMode(dirname(fileURLToPath(import.meta.url)), paths.home);
      return {
        mode,
        version: mode === 'release' ? (currentServer(paths.home)?.version ?? null) : null,
      };
    },
    async structural() {
      const info = await runningDaemon(paths);
      if (!info) return null;
      try {
        const state = await daemonFetch(info, 'GET', '/api/state');
        const workspaces = (state.json as { workspaces?: Array<{ id: string }> }).workspaces;
        if (state.status !== 200 || !workspaces?.length) return null;
        const { status, json } = await daemonFetch(
          info,
          'GET',
          `/api/structural/status?workspace=${workspaces[0]!.id}`,
        );
        return status === 200 ? (json as unknown as IndexStatus) : null;
      } catch {
        return null;
      }
    },
  };
}

function claudeJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME ?? homedir(), '.claude.json');
}

// Jamais d'écriture ici (contrairement à claudeSettings.ts) : doctor ne fait que lire et
// conseiller. Un fichier absent ou illisible n'est pas une erreur, juste « rien d'enregistré ».
function mcpServerNames(path: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    return Object.keys(parsed.mcpServers ?? {});
  } catch {
    return [];
  }
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

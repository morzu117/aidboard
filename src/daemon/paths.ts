import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AidPaths {
  home: string;
  config: string;
  db: string;
  daemonJson: string;
  repriseJson: string;
  sessionSecret: string;
  lock: string;
  logs: string;
  actionLogs: string;
  worktrees: string;
  spool: string;
  memory: string;
}

export function resolvePaths(home = process.env.AID_HOME ?? join(homedir(), '.aid')): AidPaths {
  return {
    home,
    config: join(home, 'config.yaml'),
    db: join(home, 'state.db'),
    daemonJson: join(home, 'daemon.json'),
    repriseJson: join(home, 'reprise.json'),
    sessionSecret: join(home, 'session.secret'),
    lock: join(home, 'daemon.lock'),
    logs: join(home, 'logs'),
    actionLogs: join(home, 'logs', 'actions'),
    worktrees: join(home, 'worktrees'),
    spool: join(home, 'spool'),
    memory: join(home, 'memory'),
  };
}

export function ensureHome(p: AidPaths): void {
  for (const dir of [p.home, p.logs, p.actionLogs, p.worktrees, p.spool]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir ne change pas le mode d'un dossier déjà là
    chmodSync(dir, 0o700);
  }
}

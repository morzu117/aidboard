import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parseConfig } from '../src/daemon/config.js';
import { ensureHome, resolvePaths } from '../src/daemon/paths.js';
import { purgeOldLogs } from '../src/daemon/pty/retention.js';

const DAY = 86_400_000;

function touch(file: string, ageDays: number, now: number) {
  writeFileSync(file, 'x');
  const t = (now - ageDays * DAY) / 1000;
  utimesSync(file, t, t);
}

test('les journaux plus vieux que la rétention sont supprimés, les récents et les autres fichiers restent', () => {
  const p = resolvePaths(mkdtempSync(join(tmpdir(), 'aid-ret-')));
  ensureHome(p);
  const now = Date.now();
  touch(join(p.logs, 'ag_vieux.log'), 40, now);
  touch(join(p.logs, 'ag_vieux.log.1'), 40, now);
  touch(join(p.logs, 'ag_recent.log'), 5, now);
  touch(join(p.logs, 'notes.txt'), 400, now);
  touch(join(p.actionLogs, 'ac_vieux.log'), 31, now);
  touch(join(p.actionLogs, 'ac_recent.log'), 1, now);
  expect(purgeOldLogs(p, 30, now)).toBe(3);
  expect(existsSync(join(p.logs, 'ag_vieux.log'))).toBe(false);
  expect(existsSync(join(p.logs, 'ag_vieux.log.1'))).toBe(false);
  expect(existsSync(join(p.actionLogs, 'ac_vieux.log'))).toBe(false);
  expect(existsSync(join(p.logs, 'ag_recent.log'))).toBe(true);
  expect(existsSync(join(p.logs, 'notes.txt'))).toBe(true);
  expect(existsSync(join(p.actionLogs, 'ac_recent.log'))).toBe(true);
});

test('la rétention se règle dans config.yaml et vaut 30 jours par défaut', () => {
  expect(parseConfig('').terminal.logRetentionDays).toBe(30);
  expect(parseConfig('terminal:\n  logRetentionDays: 7\n').terminal.logRetentionDays).toBe(7);
  expect(() => parseConfig('terminal:\n  logRetentionDays: 0\n')).toThrow();
});

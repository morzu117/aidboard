import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { AidAlreadyRunning, acquireLock } from '../src/daemon/lock.js';
import { ensureHome, resolvePaths } from '../src/daemon/paths.js';

function home() {
  const p = resolvePaths(mkdtempSync(join(tmpdir(), 'aid-lock-')));
  ensureHome(p);
  return p;
}

test('un second verrou pendant que le premier tient est refusé', () => {
  const p = home();
  const first = acquireLock(p);
  expect(() => acquireLock(p)).toThrow(AidAlreadyRunning);
  first.release();
  acquireLock(p).release();
});

test("un verrou d'un pid mort est repris", () => {
  const p = home();
  writeFileSync(p.lock, '2147483646');
  const lock = acquireLock(p);
  expect(readFileSync(p.lock, 'utf8')).toBe(String(process.pid));
  lock.release();
});

test('release ne retire pas le verrou d’un autre', () => {
  const p = home();
  const lock = acquireLock(p);
  writeFileSync(p.lock, '1');
  lock.release();
  expect(readFileSync(p.lock, 'utf8')).toBe('1');
});

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { expect, test } from 'vitest';
import { pullAndBuild, spawnRespawnWatcher } from '../src/daemon/selfUpdate.js';
import { commitFile, makeOriginAndClone, sh } from './helpers/git.js';
import { waitFor } from './helpers/daemon.js';

test('pullAndBuild : avance en fast-forward puis appelle build avec le dossier du dépôt', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aid-su-'));
  const { origin, clone } = makeOriginAndClone(tmp);
  const second = join(tmp, 'autre-clone');
  sh(tmp, 'clone', '-q', origin, second);
  commitFile(second, 'suite.md', 'plus loin\n');
  sh(second, 'push', '-q', 'origin', 'main');

  let builtDir = '';
  const result = await pullAndBuild(clone, 'main', async (dir) => {
    builtDir = dir;
  });
  expect(result).toEqual({ ok: true });
  expect(builtDir).toBe(clone);
  expect(sh(clone, 'log', '-1', '--pretty=%s')).toBe('ajout suite.md');
});

test('pullAndBuild : historique divergent, pull refusé (step "pull"), build jamais appelé', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aid-su-'));
  const { origin, clone } = makeOriginAndClone(tmp);
  commitFile(clone, 'local.md', 'local seulement\n');
  const second = join(tmp, 'autre-clone');
  sh(tmp, 'clone', '-q', origin, second);
  commitFile(second, 'suite.md', 'plus loin\n');
  sh(second, 'push', '-q', 'origin', 'main');

  let buildCalled = false;
  const result = await pullAndBuild(clone, 'main', async () => {
    buildCalled = true;
  });
  expect(result.ok).toBe(false);
  expect(result.step).toBe('pull');
  expect(buildCalled).toBe(false);
});

test('pullAndBuild : build en échec rapporté avec step "build"', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aid-su-'));
  const { clone } = makeOriginAndClone(tmp);
  const result = await pullAndBuild(clone, 'main', async () => {
    throw new Error('build cassé');
  });
  expect(result).toEqual({ ok: false, step: 'build', error: 'build cassé' });
});

test('spawnRespawnWatcher : attend la mort du pid donné puis relance "entry daemon"', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aid-watch-'));
  const marker = join(tmp, 'marker.txt');
  const entry = join(tmp, 'entry.cjs');
  writeFileSync(
    entry,
    "require('node:fs').writeFileSync(process.env.AID_TEST_MARKER, 'ok:' + process.argv.slice(2).join(','));",
  );
  process.env.AID_TEST_MARKER = marker;
  try {
    const dying = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)']);
    spawnRespawnWatcher(dying.pid!, entry, tmp);
    await waitFor(() => existsSync(marker) || undefined, 5000, 'respawn');
    expect(readFileSync(marker, 'utf8')).toBe('ok:daemon');
    dying.kill();
  } finally {
    delete process.env.AID_TEST_MARKER;
  }
}, 10_000);

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { checkForUpdate, repoRootFrom } from '../src/daemon/updateCheck.js';
import { UpdateWatcher } from '../src/daemon/updateWatcher.js';
import { commitFile, makeOriginAndClone, sh } from './helpers/git.js';

test('repoRootFrom : remonte jusqu’au .git, null hors d’un dépôt', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aid-upd-'));
  const { clone } = makeOriginAndClone(tmp);
  expect(repoRootFrom(join(clone, 'sous', 'dossier'))).toBe(clone);
  expect(repoRootFrom(tmp)).toBeNull();
});

test('checkForUpdate : à jour, puis en retard une fois origin avancé par un autre clone', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aid-upd-'));
  const { origin, clone } = makeOriginAndClone(tmp);
  const localSha = sh(clone, 'rev-parse', 'HEAD');

  const up1 = await checkForUpdate(clone, 'main');
  expect(up1).toEqual({ available: false, localSha, remoteSha: localSha });

  const second = join(tmp, 'autre-clone');
  sh(tmp, 'clone', '-q', origin, second);
  commitFile(second, 'suite.md', 'plus loin\n');
  sh(second, 'push', '-q', 'origin', 'main');
  const remoteSha = sh(second, 'rev-parse', 'HEAD');

  const up2 = await checkForUpdate(clone, 'main');
  expect(up2).toEqual({ available: true, localSha, remoteSha });
});

test('checkForUpdate : null sans remote origin (dépôt purement local)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aid-upd-'));
  const { clone } = makeOriginAndClone(tmp, { local: true });
  expect(await checkForUpdate(clone, 'main')).toBeNull();
});

test('UpdateWatcher (13.4) : mode repo = origin/main, latest = son sha', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aid-upd-'));
  const { origin, clone } = makeOriginAndClone(tmp);
  const second = join(tmp, 'autre-clone');
  sh(tmp, 'clone', '-q', origin, second);
  commitFile(second, 'suite.md', 'plus loin\n');
  sh(second, 'push', '-q', 'origin', 'main');
  const w = new UpdateWatcher({ mode: 'repo', from: join(clone, 'dist', 'cli'), version: '0.1.0' });
  try {
    expect(await w.tick()).toEqual({ available: true, latest: sh(second, 'rev-parse', 'HEAD') });
  } finally {
    w.dispose();
  }
});

test('UpdateWatcher (13.4) : mode release = releases GitHub, disponible si plus récente ; inconnu = rien', async () => {
  const github = (tag: string) =>
    (async () =>
      new Response(JSON.stringify({ tag_name: tag, assets: [] }), {
        status: 200,
      })) as unknown as typeof fetch;
  const plusRecente = new UpdateWatcher({
    mode: 'release',
    from: '/nulle/part',
    version: '0.2.0',
    fetchFn: github('v0.3.0'),
  });
  const aJour = new UpdateWatcher({
    mode: 'release',
    from: '/nulle/part',
    version: '0.3.0',
    fetchFn: github('v0.3.0'),
  });
  const inconnu = new UpdateWatcher({
    mode: 'inconnu',
    from: '/nulle/part',
    version: '0.2.0',
    fetchFn: github('v9.0.0'),
  });
  try {
    expect(await plusRecente.tick()).toEqual({
      available: true,
      latest: '0.3.0',
      release: { version: '0.3.0', assets: {} },
    });
    expect(await aJour.tick()).toMatchObject({ available: false, latest: '0.3.0' });
    expect(await inconnu.tick()).toBeNull();
    expect(inconnu.status()).toBeNull();
  } finally {
    for (const w of [plusRecente, aJour, inconnu]) w.dispose();
  }
});

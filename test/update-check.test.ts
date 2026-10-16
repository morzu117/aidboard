import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { checkForUpdate, repoRootFrom } from '../src/daemon/updateCheck.js';
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

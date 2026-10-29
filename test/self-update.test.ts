import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { expect, test } from 'vitest';
import {
  installedServers,
  installRelease,
  pruneServers,
  pullAndBuild,
  DAEMON_LOG_MAX,
  rotateDaemonLog,
  spawnRespawnWatcher,
  switchCurrent,
} from '../src/daemon/selfUpdate.js';
import { currentServer } from '../src/daemon/install.js';
import { fakeInstalled, fakeReleaseServer } from './helpers/release.js';
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
    spawnRespawnWatcher(dying.pid!, { execPath: process.execPath, entry }, tmp);
    await waitFor(() => existsSync(marker) || undefined, 5000, 'respawn');
    expect(readFileSync(marker, 'utf8')).toBe('ok:daemon');
    dying.kill();
  } finally {
    delete process.env.AID_TEST_MARKER;
  }
}, 10_000);

test('spawnRespawnWatcher (13.5, DR8) : relance avec l’execPath donné, pas celui du process courant', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aid-watch-'));
  const marker = join(tmp, 'marker.txt');
  const fakeNode = join(tmp, 'node');
  writeFileSync(fakeNode, `#!/bin/sh\necho "node:$*" > "${marker}"\n`);
  chmodSync(fakeNode, 0o755);
  const dying = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)']);
  spawnRespawnWatcher(dying.pid!, { execPath: fakeNode, entry: '/x/dist/cli/aid.js' }, tmp);
  await waitFor(() => existsSync(marker) || undefined, 5000, 'respawn');
  expect(readFileSync(marker, 'utf8').trim()).toBe('node:/x/dist/cli/aid.js daemon');
  dying.kill();
}, 10_000);

test('rotateDaemonLog : au-delà du seuil, daemon.log devient daemon.log.1 ; en deçà ou absent, rien ne bouge', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aid-log-'));
  const log = join(tmp, 'daemon.log');
  rotateDaemonLog(tmp, 10);
  expect(existsSync(log)).toBe(false);

  writeFileSync(log, 'court');
  rotateDaemonLog(tmp, 10);
  expect(readFileSync(log, 'utf8')).toBe('court');

  writeFileSync(log, 'nettement trop long');
  rotateDaemonLog(tmp, 10);
  expect(existsSync(log)).toBe(false);
  expect(readFileSync(`${log}.1`, 'utf8')).toBe('nettement trop long');
});

test('spawnRespawnWatcher : un daemon.log trop gros est mis de côté avant la relance', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aid-watch-'));
  const log = join(tmp, 'daemon.log');
  writeFileSync(log, '');
  // fichier creux : la taille dépasse le seuil sans écrire 10 Mo
  truncateSync(log, DAEMON_LOG_MAX + 1);
  const marker = join(tmp, 'marker.txt');
  const fakeNode = join(tmp, 'node');
  writeFileSync(fakeNode, `#!/bin/sh\necho relance > "${marker}"\n`);
  chmodSync(fakeNode, 0o755);
  const dying = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)']);
  spawnRespawnWatcher(dying.pid!, { execPath: fakeNode, entry: '/x/dist/cli/aid.js' }, tmp);
  await waitFor(() => existsSync(marker) || undefined, 5000, 'respawn');
  expect(existsSync(`${log}.1`)).toBe(true);
  expect(readFileSync(log, 'utf8')).toBe('');
  dying.kill();
}, 10_000);

test('installRelease : télécharge, vérifie, extrait sous ~/.aid/server/<version>, bascule current, rend le Launch de la nouvelle version', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aid-inst-'));
  const srv = await fakeReleaseServer('0.2.0');
  try {
    const log: string[] = [];
    const r = await installRelease(srv.release, home, { log: (l) => log.push(l) });
    const dir = join(home, 'server', '0.2.0');
    expect(r).toEqual({
      ok: true,
      dir,
      launch: {
        execPath: join(dir, 'node', 'bin', 'node'),
        entry: join(dir, 'dist', 'cli', 'aid.js'),
      },
    });
    expect(existsSync(join(dir, 'bin', 'aid'))).toBe(true);
    expect(readlinkSync(join(home, 'server', 'current'))).toBe('0.2.0');
    expect(currentServer(home)).toEqual({ version: '0.2.0', dir });
    expect(existsSync(join(home, 'server', '0.2.0.partial'))).toBe(false);
    expect(log.at(-1)).toContain('current → 0.2.0');
  } finally {
    await srv.close();
  }
});

test('installRelease : somme fausse → step verify, current intact, rien d’installé ni de partiel', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aid-inst-'));
  fakeInstalled(home, '0.1.0');
  switchCurrent(home, '0.1.0');
  const srv = await fakeReleaseServer('0.2.0', { corrupt: true });
  try {
    const r = await installRelease(srv.release, home);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.step).toBe('verify');
      expect(r.error).toContain('SHA-256');
    }
    expect(readlinkSync(join(home, 'server', 'current'))).toBe('0.1.0');
    expect(existsSync(join(home, 'server', '0.2.0'))).toBe(false);
    expect(existsSync(join(home, 'server', '0.2.0.partial'))).toBe(false);
  } finally {
    await srv.close();
  }
});

test('installRelease : pas d’asset pour cette plateforme, ou serveur injoignable → step download', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aid-inst-'));
  const srv = await fakeReleaseServer('0.2.0', { withoutAsset: true });
  try {
    const r = await installRelease(srv.release, home);
    expect(r).toMatchObject({ ok: false, step: 'download' });
    if (!r.ok) expect(r.error).toContain('aucun asset');
    const win = await installRelease(srv.release, home, { platform: 'win32' });
    if (!win.ok) expect(win.error).toContain('WSL2');
  } finally {
    await srv.close();
  }
  const down = await installRelease(
    {
      version: '0.2.0',
      assets: {
        [`aid-server-0.2.0-${process.platform}-${process.arch}.tar.gz`]: 'http://127.0.0.1:1/x',
        SHA256SUMS: 'http://127.0.0.1:1/s',
      },
    },
    home,
  );
  expect(down).toMatchObject({ ok: false, step: 'download' });
  expect(existsSync(join(home, 'server', '0.2.0.partial'))).toBe(false);
});

test('installedServers, switchCurrent, pruneServers : la plus récente d’abord, current jamais supprimé, deux versions gardées', () => {
  const home = mkdtempSync(join(tmpdir(), 'aid-inst-'));
  expect(installedServers(home)).toEqual([]);
  for (const v of ['0.1.0', '0.3.0', '0.2.0', '0.10.0']) fakeInstalled(home, v);
  expect(installedServers(home)).toEqual(['0.10.0', '0.3.0', '0.2.0', '0.1.0']);
  expect(() => switchCurrent(home, '9.9.9')).toThrow(/absente/);
  switchCurrent(home, '0.2.0');
  expect(pruneServers(home)).toEqual(['0.3.0', '0.1.0']);
  expect(installedServers(home)).toEqual(['0.10.0', '0.2.0']);
  expect(readlinkSync(join(home, 'server', 'current'))).toBe('0.2.0');
  switchCurrent(home, '0.10.0');
  expect(readlinkSync(join(home, 'server', 'current'))).toBe('0.10.0');
  expect(pruneServers(home, 1)).toEqual(['0.2.0']);
});

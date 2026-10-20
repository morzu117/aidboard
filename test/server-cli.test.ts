import { mkdtempSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { runServer } from '../src/cli/commands/server.js';
import { resolvePaths } from '../src/daemon/paths.js';
import { makeOriginAndClone } from './helpers/git.js';
import { fakeInstalled, fakeReleaseServer } from './helpers/release.js';

const setup = () => {
  const home = mkdtempSync(join(tmpdir(), 'aid-srvcli-'));
  const out: string[] = [];
  return { home, paths: resolvePaths(home), out, print: (s: string) => out.push(s) };
};

test('aid server status : mode release, versions installées avec current marquée', async () => {
  const { home, paths, out, print } = setup();
  const entry = join(fakeInstalled(home, '0.1.0'), 'dist', 'cli', 'aid.js');
  fakeInstalled(home, '0.2.0');
  expect(await runServer([], paths, { entry, out: print })).toBe(0);
  expect(out.join('\n')).toContain(`installation : release (${join(home, 'server')})`);
  expect(out.join('\n')).toContain('versions installées : 0.2.0, 0.1.0');
  await runServer(['use', '0.2.0'], paths, { entry, out: print });
  out.length = 0;
  await runServer(['status'], paths, { entry, out: print });
  expect(out.join('\n')).toContain('versions installées : 0.2.0 (current), 0.1.0');
});

test('aid server install : depuis les releases (latest ou une version), bascule current, demande un redémarrage', async () => {
  const { home, paths, out, print } = setup();
  const entry = join(fakeInstalled(home, '0.1.0'), 'dist', 'cli', 'aid.js');
  const srv = await fakeReleaseServer('0.2.0');
  try {
    const deps = { entry, out: print, apiBase: srv.apiBase };
    expect(await runServer(['install'], paths, deps)).toBe(0);
    expect(readlinkSync(join(home, 'server', 'current'))).toBe('0.2.0');
    expect(out.at(-1)).toContain('AID Server 0.2.0 installé');
    expect(out.at(-1)).toContain('Redémarre le daemon');
    out.length = 0;
    expect(await runServer(['install', '0.2.0'], paths, deps)).toBe(0);
    expect(out.at(-1)).toBe('0.2.0 est déjà la version courante');
    expect(await runServer(['install', '0.9.0'], paths, deps)).toBe(1);
    expect(out.at(-1)).toContain('release 0.9.0 introuvable');
  } finally {
    await srv.close();
  }
});

test('aid server install : refusé hors mode release (le clone fait foi) ; use : version absente → 1', async () => {
  const { home, paths, out, print } = setup();
  const { clone } = makeOriginAndClone(home);
  const entry = join(clone, 'dist', 'cli', 'aid.js');
  expect(await runServer(['install'], paths, { entry, out: print })).toBe(1);
  expect(out.at(-1)).toContain('mode repo');
  expect(out.at(-1)).toContain('install-server.sh');
  expect(await runServer(['use', '0.5.0'], paths, { entry, out: print })).toBe(1);
  expect(out.at(-1)).toContain('absente');
  expect(await runServer(['use'], paths, { entry, out: print })).toBe(1);
  expect(await runServer(['boum'], paths, { entry, out: print })).toBe(1);
  await runServer(['status'], paths, { entry, out: print });
  expect(out.at(-2)).toContain('mode repo (clone');
  expect(out.at(-1)).toContain('aucune version');
});

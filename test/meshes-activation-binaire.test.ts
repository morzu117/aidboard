import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import { openDb } from '../src/daemon/db.js';
import { EventStore } from '../src/daemon/events/store.js';
import { MeshRegistry } from '../src/daemon/mesh/registre.js';
import { meshExec, type MeshExec } from '../src/daemon/mesh/exec.js';

const nettoyages: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of nettoyages.splice(0).reverse()) await f();
});
function contexte(exec?: MeshExec) {
  const home = mkdtempSync(join(tmpdir(), 'aid-46-activation-'));
  const bin = join(home, 'swarph');
  writeFileSync(
    bin,
    '#!/bin/sh\nif [ ! -f "$HOME/temoin" ]; then echo "interpréteur indisponible" >&2; exit 127; fi\nif [ "$1" = "--version" ]; then echo "exemple"; else echo \'{"running":false}\'; fi\n',
    { mode: 0o755 },
  );
  for (const nom of ['principal', 'perso']) mkdirSync(join(home, nom));
  writeFileSync(join(home, 'principal', 'temoin'), '');
  const db = openDb(join(home, 'state.db'));
  const log = vi.fn();
  const registre = new MeshRegistry({
    config: {
      ...DEFAULT_CONFIG,
      mesh: { ...DEFAULT_CONFIG.mesh, bin },
      meshes: Object.fromEntries(
        ['principal', 'perso'].map((nom) => [
          nom,
          {
            ...DEFAULT_CONFIG.mesh,
            cell: 'peer-a',
            home: join(home, nom),
            gateway: `https://${nom}.example.com`,
          },
        ]),
      ),
    },
    db,
    store: new EventStore(db),
    log,
    exec,
    tailscale: async () => 'running',
  });
  nettoyages.push(async () => {
    await registre.arreter();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { home, bin, registre, log };
}
test('binaire résolu : échec sous un home isolé, autre mesh actif ; délai et environnement transmis', async () => {
  const exec = vi.fn(meshExec);
  const c = contexte(exec);
  await c.registre.init();
  expect(c.registre.liste()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ nom: 'principal', actif: true, erreur: null }),
      expect.objectContaining({ nom: 'perso', actif: false, erreur: 'binaire' }),
    ]),
  );
  expect(c.log).toHaveBeenCalledWith('mesh perso : binaire : interpréteur indisponible\n');
  for (const nom of ['principal', 'perso'])
    expect(exec).toHaveBeenCalledWith(c.bin, ['--version'], {
      timeoutMs: 10_000,
      env: expect.objectContaining({ HOME: join(c.home, nom), SWARPH_SELF: 'peer-a' }),
    });
});
test('même binaire : témoin présent sous chaque home, deux meshes actifs', async () => {
  const c = contexte();
  writeFileSync(join(c.home, 'perso', 'temoin'), '');
  await c.registre.init();
  expect(c.registre.liste().every((e) => e.actif && e.erreur === null)).toBe(true);
});
test.each(['ENOENT', 'delai', 'exception'])(
  'échec %s : inactif et journal tronqué à 200 caractères',
  async (cas) => {
    const exec: MeshExec = async () => {
      if (cas === 'exception') throw new Error('x'.repeat(300));
      return {
        ok: false,
        timedOut: cas === 'delai',
        stderr: 'x'.repeat(300),
        stdout: '',
        ...(cas === 'ENOENT' ? { spawnErrorCode: 'ENOENT' } : {}),
      };
    };
    const c = contexte(exec);
    await c.registre.init();
    expect(c.registre.liste().every((e) => !e.actif && e.erreur === 'binaire')).toBe(true);
    expect(c.log).toHaveBeenCalledWith(`mesh perso : binaire : ${'x'.repeat(200)}`);
  },
);

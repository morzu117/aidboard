import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import { openDb } from '../src/daemon/db.js';
import { EventStore } from '../src/daemon/events/store.js';
import { MeshRegistry } from '../src/daemon/mesh/registre.js';

const nettoyages: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const nettoyer of nettoyages.splice(0).reverse()) await nettoyer();
  vi.unstubAllEnvs();
});
function registre(bin: string) {
  const home = mkdtempSync(join(tmpdir(), 'aid-46-bin-db-'));
  const db = openDb(join(home, 'state.db'));
  const meshes = new MeshRegistry({
    config: {
      ...DEFAULT_CONFIG,
      mesh: { ...DEFAULT_CONFIG.mesh, bin },
      meshes: Object.fromEntries(
        ['principal', 'perso'].map((nom) => [
          nom,
          {
            ...DEFAULT_CONFIG.mesh,
            cell: 'principal',
            home: join(home, nom),
            gateway: `https://${nom}.example.com`,
          },
        ]),
      ),
    },
    db,
    store: new EventStore(db),
    log: () => undefined,
    tailscale: async () => 'running',
  });
  nettoyages.push(async () => {
    await meshes.arreter();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  return meshes;
}
function dossier() {
  const chemin = mkdtempSync(join(tmpdir(), 'aid-46-bin-'));
  nettoyages.push(() => rmSync(chemin, { recursive: true, force: true }));
  return chemin;
}
function binaire(dossier: string, nom: string) {
  const chemin = join(dossier, 'swarph');
  writeFileSync(
    chemin,
    `#!/bin/sh\nif [ "$1" = monitor ]; then echo '{"running":false}'; else echo '${nom}'; fi\n`,
    { mode: 0o755 },
  );
  return chemin;
}

test('PATH modifié après démarrage : le même chemin absolu est appelé pour les deux meshes', async () => {
  const principal = dossier();
  const perso = dossier();
  const chemin = binaire(principal, 'principal');
  binaire(perso, 'perso');
  vi.stubEnv('PATH', principal);
  const meshes = registre('swarph');
  await meshes.init();
  vi.stubEnv('PATH', perso);
  expect(meshes.binaire).toBe(chemin);
  for (const nom of ['principal', 'perso']) {
    expect(meshes.configuration(nom).bin).toBe(chemin);
    expect((await meshes.obtenir(nom).mesh.read(['exemple'])).stdout.trim()).toBe('principal');
  }
});

test('chemin absolu configuré : aucun choix par PATH', async () => {
  const chemin = binaire(dossier(), 'principal');
  vi.stubEnv('PATH', dossier());
  const meshes = registre(chemin);
  expect(meshes.binaire).toBe(chemin);
  await meshes.init();
  expect((await meshes.obtenir().mesh.read(['exemple'])).stdout.trim()).toBe('principal');
});

test('PATH relatif : chemin retenu absolu', () => {
  const repertoire = dossier();
  const chemin = binaire(repertoire, 'principal');
  vi.stubEnv('PATH', relative(process.cwd(), repertoire));
  expect(registre('swarph').binaire).toBe(chemin);
});

test('un dossier ou un fichier non exécutable est ignoré au profit du candidat suivant', () => {
  const premier = dossier();
  const deuxieme = dossier();
  const dernier = dossier();
  mkdirSync(join(premier, 'swarph'));
  writeFileSync(join(deuxieme, 'swarph'), 'exemple', { mode: 0o644 });
  const chemin = binaire(dernier, 'principal');
  vi.stubEnv('PATH', [premier, deuxieme, dernier].join(delimiter));
  expect(registre('swarph').binaire).toBe(chemin);
});

test.each(['swarph', '/exemple/binaire-absent'])(
  'binaire absent %s : monitor absent et lectures ENOENT, sans recherche ultérieure',
  async (bin) => {
    const repertoire = dossier();
    vi.stubEnv('PATH', repertoire);
    const meshes = registre(bin);
    await meshes.init();
    binaire(repertoire, 'perso');
    for (const nom of ['principal', 'perso']) {
      expect(meshes.obtenir(nom).mesh.current().monitor).toBe('absent');
      expect(await meshes.obtenir(nom).mesh.read(['exemple'])).toMatchObject({
        ok: false,
        spawnErrorCode: 'ENOENT',
      });
      expect(await meshes.obtenir(nom).board.projects()).toMatchObject({
        ok: false,
        kind: 'absent',
      });
    }
  },
);

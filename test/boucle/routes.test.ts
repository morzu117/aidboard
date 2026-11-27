import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { creerReglage } from '../../src/daemon/confirmations/reglage.js';
import { commitFile, makeOriginAndClone, sh } from '../helpers/git.js';
import { seedTopic, startTestDaemon, type TestDaemon } from '../helpers/daemon.js';

const route = '/api/topics/tp_1/boucle';
let dossier: string;
let daemon: TestDaemon;

beforeEach(async () => {
  dossier = mkdtempSync(join(tmpdir(), 'aid-boucle-routes-'));
  const home = join(dossier, 'home');
  mkdirSync(home);
  vi.stubEnv('HOME', home);
  const { clone } = makeOriginAndClone(dossier, { name: 'depot-fictif' });
  commitFile(clone, 'agent.yml', 'phases: [plan, dev, review]\n', 'Manifeste');
  sh(clone, 'push', '-q', 'origin', 'main');
  sh(clone, 'switch', '-qc', 'feat/s');
  const bin = join(import.meta.dirname, '../fixtures/bin-stream');
  vi.stubEnv('PATH', [bin, process.env.PATH].filter(Boolean).join(delimiter));
  daemon = await startTestDaemon(join(dossier, 'aid-home'));
  seedTopic(daemon.db);
  daemon.db.prepare('DELETE FROM agents').run();
  daemon.db.prepare('DELETE FROM runs').run();
  daemon.db.prepare('UPDATE workspaces SET root = ?, worktrees_dir = ?').run(clone, dossier);
  daemon.db.prepare('UPDATE topics SET worktree = ?').run(clone);
});

afterEach(async () => {
  try {
    await daemon?.d.stop();
  } finally {
    vi.unstubAllEnvs();
    if (dossier) rmSync(dossier, { recursive: true, force: true });
  }
});

test('GET boucle rend la projection vide pour un sujet connu', async () => {
  const resultat = await fetch(`http://127.0.0.1:${daemon.d.port}${route}`, {
    headers: daemon.headers,
  });
  expect(resultat.status).toBe(200);
  expect(await resultat.json()).toEqual({
    phase: null,
    etapeCourante: null,
    historique: [],
    plan: null,
    escalade: null,
    mesures: { tempsParEtapeMs: {}, interventionsHumaines: 0, redevs: 0 },
  });
});

test.each(['', '/go', '/reponse', '/arreter'])(
  'POST boucle%s est refusé quand la porte est armée et le PDA indisponible',
  async (suffixe) => {
    creerReglage(daemon.db).armer();
    const resultat = await fetch(`http://127.0.0.1:${daemon.d.port}${route}${suffixe}`, {
      method: 'POST',
      headers: { ...daemon.headers, 'content-type': 'application/json' },
      body: JSON.stringify(suffixe === '/reponse' ? { reponse: 'Texte' } : {}),
    });
    expect(resultat.status).toBe(409);
    if (suffixe === '') {
      expect(await resultat.json()).toMatchObject({ error: 'confirmation_impossible' });
    }
    expect(daemon.db.prepare('SELECT count(*) AS nombre FROM boucles').get()).toEqual({
      nombre: 0,
    });
  },
);

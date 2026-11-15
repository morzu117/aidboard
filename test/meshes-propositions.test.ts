import { afterEach, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { migrate } from '../src/daemon/db.js';
import { BoardReader } from '../src/daemon/mesh/board.js';
import { registerAidRoutes } from '../src/daemon/routes/aid.js';
import { registerSwairmRoutes } from '../src/daemon/routes/swairm.js';
import { SwairmAsk } from '../src/daemon/swairm/ask.js';
import { parseCard } from '../src/shared/board.js';

const nettoyages: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of nettoyages.splice(0).reverse()) await f();
});

test('les routes des propositions A-I-D et Swairm rendent la colonne mesh ; l’aperçu aussi', async () => {
  const db = new Database(':memory:');
  migrate(db);
  nettoyages.push(() => db.close());
  db.prepare(
    "INSERT INTO aid_propositions (mesh, sujet, carte, etape, cree_a) VALUES ('principal', 'exemple', 12, 'review', '2026-11-12')",
  ).run();
  db.prepare(
    "INSERT INTO swairm_propositions (mesh, projet, sujet, etat, titre, carte, cree_a) VALUES ('principal', 'exemple', 'sujet', 'merged', 'Exemple', 12, '2026-11-12')",
  ).run();
  const board = new BoardReader({ mesh: { read: vi.fn() }, cell: 'peer-a', log: vi.fn() });
  vi.spyOn(board, 'card').mockResolvedValue({
    card: {
      ok: true,
      data: parseCard({ id: 12, assignee: 'peer-a', stage: 'build', stage_version: 1 })!.value,
      readAt: '',
      schemaVersion: null,
    },
    graph: { ok: false, kind: 'unknown', readAt: '' },
    thread: { ok: false, kind: 'unknown', readAt: '' },
    obligations: { ok: false, kind: 'unknown', readAt: '' },
  });
  const app = Fastify();
  nettoyages.push(() => app.close());
  registerAidRoutes(app, db, board, 'peer-a');
  registerSwairmRoutes(app, new SwairmAsk(), board, undefined, db);
  expect((await app.inject('/api/aid/propositions')).json()).toMatchObject([
    { mesh: 'principal', carte: 12 },
  ]);
  expect((await app.inject('/api/swairm/propositions')).json()).toMatchObject([
    { mesh: 'principal', carte: 12 },
  ]);
  const apercu = await app.inject('/api/aid/propositions/1/apercu');
  expect(apercu.statusCode).toBe(200);
  expect(apercu.json()).toMatchObject({ mesh: 'principal', params: { carte: 12 } });
});

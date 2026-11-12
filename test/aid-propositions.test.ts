import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { migrate } from '../src/daemon/db.js';
import { creerReleveAid, propositionsAid } from '../src/daemon/aid/propositions.js';
import type { lireBoardAid } from '../src/daemon/aid/board.js';
import { parseCard } from '../src/shared/board.js';
import { BoardReader } from '../src/daemon/mesh/board.js';
import { preparerPropositionAid } from '../src/daemon/aid/envoi.js';
import { registerAidRoutes } from '../src/daemon/routes/aid.js';
import { registerEcrituresRoutes } from '../src/daemon/routes/ecritures.js';
import type { Porte } from '../src/daemon/confirmations/porte.js';

const nettoyages: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of nettoyages.splice(0).reverse()) await f();
});
function base() {
  const dossier = mkdtempSync(join(tmpdir(), 'aid-propositions-'));
  const chemin = join(dossier, 'etat.db');
  const db = new Database(chemin);
  migrate(db);
  nettoyages.push(() => {
    if (db.open) db.close();
    rmSync(dossier, { recursive: true, force: true });
  });
  return { db, chemin };
}
function lecture(
  champs: Record<string, unknown> = {},
  carte: Record<string, unknown> = {},
): Awaited<ReturnType<typeof lireBoardAid>> {
  return {
    board: { ok: true, data: { cards: [], searched: 0 }, readAt: '', schemaVersion: null },
    erreurs: [],
    cartes: [
      {
        ...parseCard({ id: 42, assignee: 'peer-a', stage: 'build', stage_version: 1, ...carte })!
          .value,
        sujets: [{ lien: 'exemple/depot#s', sujet: 's' }],
      },
    ],
    sujets: [
      {
        sujetId: 's',
        workspace: 'w',
        slug: 's',
        titre: 'Sujet',
        state: 'active',
        phase: 'dev',
        branch: 'feat/s',
        prNumber: null,
        prUrl: null,
        lien: 'exemple/depot#s',
        carte: 42,
        conflit: [],
        agents: { enMarche: 0, enAttente: 0, termine: 0 },
        ...champs,
      },
    ],
  };
}
test('028 : migration idempotente', () => {
  const { db } = base();
  migrate(db);
  expect(db.pragma('user_version', { simple: true })).toBe(31);
});
test.each([{ phase: 'review' }, { prNumber: 7 }, { state: 'merged' as const }])(
  'D293 : premier relevé silencieux puis transition %j, unicité, D268',
  (champs) => {
    const { db } = base();
    const relever = creerReleveAid(db, 'peer-a');
    relever(lecture(champs));
    expect(propositionsAid(db)).toEqual([]);
    relever(lecture());
    relever(lecture(champs));
    relever(lecture());
    relever(lecture(champs));
    expect(propositionsAid(db)).toMatchObject([
      { carte: 42, etape: 'state' in champs ? 'ready' : 'review' },
    ]);
    expect(propositionsAid(db)).toHaveLength(1);
    expect(db.prepare('SELECT * FROM pda_demandes').all()).toEqual([]);
    expect(db.prepare('SELECT confirmation FROM aid_propositions').get()).toEqual({
      confirmation: null,
    });
  },
);
test.each([
  { assignee: 'peer-b' },
  { assignee: null },
  { stage: 'spec' },
  { stage: 'done' },
  { stage_version: undefined },
  { stage_version: '1' },
  { stage_version: -1 },
  { stage_version: 0.5 },
  { stage: 'review' },
  { stage: 'ready' },
])('D293 : pas de proposition si garde refusée %j', (carte) => {
  const { db } = base();
  const relever = creerReleveAid(db, 'peer-a');
  relever(lecture({}, carte));
  relever(lecture({ phase: 'review' }, carte));
  expect(propositionsAid(db)).toEqual([]);
});
test('redémarrage : aucune transition durant l’arrêt rejouée, propositions existantes conservées', () => {
  const { db, chemin } = base();
  let relever = creerReleveAid(db, 'peer-a');
  relever(lecture());
  relever(lecture({ phase: 'review' }));
  db.close();
  const reprise = new Database(chemin);
  nettoyages.push(() => reprise.close());
  relever = creerReleveAid(reprise, 'peer-a');
  relever(lecture({ state: 'merged' }));
  expect(propositionsAid(reprise).map((p) => p.etape)).toEqual(['review']);
  relever(lecture());
  relever(lecture({ state: 'merged' }));
  expect(propositionsAid(reprise).map((p) => p.etape)).toEqual(['review', 'ready']);
});
test('Ignorer ferme sans demande ; une transition ultérieure peut reproposer', async () => {
  const { db } = base();
  const relever = creerReleveAid(db, 'peer-a');
  relever(lecture());
  relever(lecture({ phase: 'review' }));
  const app = Fastify();
  nettoyages.push(() => app.close());
  registerAidRoutes(app, db, null, 'peer-a');
  expect((await app.inject({ method: 'DELETE', url: '/api/aid/propositions/1' })).statusCode).toBe(
    200,
  );
  expect(propositionsAid(db)).toEqual([]);
  expect(db.prepare('SELECT * FROM pda_demandes').all()).toEqual([]);
  relever(lecture());
  relever(lecture({ phase: 'review' }));
  expect(propositionsAid(db)).toHaveLength(1);
});
test('aperçu puis envoi : attendu relu à chaque fois, jamais la version de la proposition', async () => {
  const { db } = base();
  const relever = creerReleveAid(db, 'peer-a');
  relever(lecture());
  relever(lecture({ state: 'merged' }));
  const board = new BoardReader({ mesh: { read: vi.fn() }, cell: 'peer-a', log: vi.fn() });
  const fiche = {
    card: {
      ok: true as const,
      data: parseCard({ id: 42, assignee: 'peer-a', stage: 'build', stage_version: 8 })!.value,
      readAt: '',
      schemaVersion: null,
    },
    graph: { ok: false as const, kind: 'unknown' as const, readAt: '' },
    thread: { ok: false as const, kind: 'unknown' as const, readAt: '' },
    obligations: { ok: false as const, kind: 'unknown' as const, readAt: '' },
  };
  vi.spyOn(board, 'card').mockImplementation(async () => structuredClone(fiche));
  const apercu = await preparerPropositionAid(db, board, 'peer-a', 1);
  expect(apercu.attendu.stageVersion).toBe(8);
  fiche.card.data.stage = 'review';
  fiche.card.data.stageVersion = 9;
  const demander = vi.fn<(...args: unknown[]) => Promise<{ confirmation: string }>>(async () => ({
    confirmation: 'confirmee',
  }));
  const app = Fastify();
  nettoyages.push(() => app.close());
  registerEcrituresRoutes(app, {
    db,
    board,
    cell: 'peer-a',
    porte: { demander } as unknown as Porte,
  });
  const r = await app.inject({
    method: 'POST',
    url: '/api/swarph/etat/envoyer',
    payload: { mesh: 'principal', action: 'carte.deplacer', params: apercu, propositionAid: 1 },
  });
  expect(r.statusCode).toBe(202);
  expect(demander.mock.calls[0]?.slice(0, 2)).toMatchObject([
    'mesh.etat',
    {
      action: 'carte.deplacer',
      params: { carte: 42, etape: 'ready', attendu: { stage: 'review', stageVersion: 9 } },
    },
  ]);
  expect(db.prepare('SELECT confirmation FROM aid_propositions').get()).toEqual({
    confirmation: 'confirmee',
  });
});
test('D283 : proxy lecture seule refuse avant la porte et toute relecture', async () => {
  const { db } = base();
  const app = Fastify();
  nettoyages.push(() => app.close());
  const demander = vi.fn();
  const board = new BoardReader({ mesh: { read: vi.fn() }, cell: 'peer-a', log: vi.fn() });
  registerEcrituresRoutes(app, {
    db,
    board,
    cell: 'peer-a',
    porte: { demander } as unknown as Porte,
    proxySocket: '/tmp/faux.sock',
    proxyLectureSeule: true,
  });
  const r = await app.inject({
    method: 'POST',
    url: '/api/swarph/etat/envoyer',
    payload: { mesh: 'principal', action: 'carte.deplacer', params: { carte: 42 } },
  });
  expect(r.statusCode).toBe(409);
  expect(r.json().error).toBe('proxy_lecture_seule');
  expect(demander).not.toHaveBeenCalled();
});

test.each(['executee', 'echouee', 'perimee'])(
  'fermeture persistante uniquement sur succès confirmé : %s',
  (resultat) => {
    const { db } = base();
    const relever = creerReleveAid(db, 'peer-a');
    relever(lecture());
    relever(lecture({ phase: 'review' }));
    db.prepare(
      `INSERT INTO pda_demandes (id, action, sujet, h_demande, numero, echeance, etat, cree_a, resultat, envoi)
    VALUES ('demande', 'mesh.etat', 'test', 'hash', '1234', 100, 'confirmee', 'date', ?, ?)`,
    ).run(
      resultat,
      JSON.stringify({ code: resultat === 'executee' ? 'succes' : 'upstream_error' }),
    );
    db.prepare("UPDATE aid_propositions SET confirmation = 'demande'").run();
    expect(propositionsAid(db)).toHaveLength(resultat === 'executee' ? 0 : 1);
  },
);

test('review vers ready et version zéro : proposition permise ; lien rompu réamorcé', () => {
  const { db } = base();
  const relever = creerReleveAid(db, 'peer-a');
  relever(lecture({}, { stage: 'review', stage_version: 0 }));
  relever(lecture({ state: 'merged' }, { stage: 'review', stage_version: 0 }));
  expect(propositionsAid(db)).toMatchObject([{ etape: 'ready' }]);
  db.prepare('DELETE FROM aid_propositions').run();
  relever(lecture({ carte: null }));
  relever(lecture({ phase: 'review' }));
  expect(propositionsAid(db)).toEqual([]);
});

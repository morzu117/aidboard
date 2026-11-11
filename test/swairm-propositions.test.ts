import type { BoardCard } from '../src/shared/board.js';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, expect, test, vi } from 'vitest';
import { migrate, openDb } from '../src/daemon/db.js';
import { propositionsSwairm, releverEtatsSwairm } from '../src/daemon/swairm/propositions.js';
import type { lireBoardSwairm } from '../src/daemon/swairm/board.js';
import { registerSwairmRoutes } from '../src/daemon/routes/swairm.js';
import { SwairmAsk } from '../src/daemon/swairm/ask.js';
import { SwairmStatut } from '../src/daemon/swairm/statut.js';
import { BoardReader } from '../src/daemon/mesh/board.js';

const carte = JSON.parse(readFileSync('test/fixtures/board/cards-search.json', 'utf8'))
  .cards[0] as BoardCard;
const nettoyages: (() => unknown)[] = [];
afterEach(() =>
  nettoyages
    .splice(0)
    .reverse()
    .forEach((f) => f()),
);
function base() {
  const dossier = mkdtempSync(join(tmpdir(), 'aid-swairm-propositions-'));
  nettoyages.push(() => rmSync(dossier, { recursive: true, force: true }));
  const chemin = join(dossier, 'state.db');
  const db = openDb(chemin);
  nettoyages.push(() => {
    if (db.open) db.close();
  });
  return { db, chemin };
}
function lecture(
  etat = 'planned',
  carte: number | null = 42,
  conflit: number[] = [],
): Awaited<ReturnType<typeof lireBoardSwairm>> {
  return {
    board: { ok: true, data: { cards: [], searched: 0 }, readAt: '', schemaVersion: null },
    swairm: { etat: 'ok', data: { projets: [], erreurs: [] } },
    cartes: [],
    sujets: [
      {
        projet: 'exemple/depot',
        id: '41',
        titre: 'Un sujet',
        etat,
        carte,
        conflit,
        colonne: 'travail',
        en_pause: false,
        pas: { total: 0, par_etat: {} },
        maj: '',
        vol: null,
      },
    ],
  };
}

test('027 : montée depuis 026, réglages préservés et migration idempotente', () => {
  const db = new Database(':memory:');
  try {
    for (const f of readdirSync('migrations')
      .filter((f) => /^\d{3}_/.test(f) && f < '027')
      .sort())
      db.exec(readFileSync(join('migrations', f), 'utf8'));
    db.pragma('user_version = 26');
    const avant = db.prepare('SELECT * FROM confirmations_reglage').all();
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(28);
    expect(db.prepare('SELECT * FROM confirmations_reglage').all()).toEqual(avant);
    releverEtatsSwairm(db, lecture());
    migrate(db);
    expect(db.prepare('SELECT projet, sujet, etat FROM swairm_etats').all()).toEqual([
      { projet: 'exemple/depot', sujet: '41', etat: 'planned' },
    ]);
  } finally {
    db.close();
  }
});

test.each(['plan_validated', 'merged', 'abandoned'])(
  'premier relevé, transition %s, état identique, unicité ouverte et redémarrage',
  (etat) => {
    const { db, chemin } = base();
    releverEtatsSwairm(db, lecture());
    expect(propositionsSwairm(db)).toEqual([]);
    releverEtatsSwairm(db, lecture(etat));
    releverEtatsSwairm(db, lecture(etat));
    expect(propositionsSwairm(db)).toMatchObject([{ carte: 42, etat, titre: 'Un sujet' }]);
    releverEtatsSwairm(db, lecture('in_progress'));
    releverEtatsSwairm(db, lecture(etat));
    expect(propositionsSwairm(db)).toHaveLength(1);
    db.close();
    const reprise = openDb(chemin);
    try {
      releverEtatsSwairm(reprise, lecture(etat));
      expect(propositionsSwairm(reprise)).toHaveLength(1);
    } finally {
      reprise.close();
    }
  },
);

test('premier relevé déjà terminé et autre changement : enregistrer sans proposer', () => {
  const { db } = base();
  releverEtatsSwairm(db, lecture('merged'));
  releverEtatsSwairm(db, lecture('in_progress'));
  expect(propositionsSwairm(db)).toEqual([]);
  expect(db.prepare('SELECT etat FROM swairm_etats').get()).toEqual({ etat: 'in_progress' });
});

test.each([{ conflit: [] }, { conflit: [42, 43] }])(
  'sans carte ou conflit %j : ne rien enregistrer, lien tardif sans vieille transition',
  ({ conflit }) => {
    const { db } = base();
    releverEtatsSwairm(db, lecture('planned', null, conflit));
    releverEtatsSwairm(db, lecture('merged', null, conflit));
    expect(db.prepare('SELECT * FROM swairm_etats').all()).toEqual([]);
    expect(propositionsSwairm(db)).toEqual([]);
    releverEtatsSwairm(db, lecture('merged'));
    expect(propositionsSwairm(db)).toEqual([]);
  },
);

test('lecture en échec : aucun état enregistré', () => {
  const { db } = base();
  const l = lecture();
  l.board = { ok: false, kind: 'timeout', readAt: '' };
  releverEtatsSwairm(db, l);
  expect(db.prepare('SELECT * FROM swairm_etats').all()).toEqual([]);
});

test('route D286 : une transition ne déclenche aucune écriture mesh ni demande de confirmation ; ignorer persiste', async () => {
  const { db } = base();
  const app = Fastify();
  const read = vi.fn();
  const board = new BoardReader({ mesh: { read }, cell: 'peer-a', log: vi.fn() });
  vi.spyOn(board, 'chercherCartes').mockResolvedValue({
    ok: true,
    readAt: '',
    schemaVersion: null,
    data: { cards: [{ ...carte, id: 42, body: 'Swairm: exemple/depot#41' }], searched: 1 },
  });
  const statut = new SwairmStatut();
  let etat = 'planned';
  vi.spyOn(statut, 'lire').mockImplementation(async () => ({
    etat: 'ok',
    data: {
      projets: [{ projet: 'exemple/depot', sujets: lecture(etat).sujets, vols: [] }],
      erreurs: [],
    },
  }));
  registerSwairmRoutes(app, new SwairmAsk(), board, statut, db);
  try {
    await app.inject('/api/swairm/board');
    etat = 'merged';
    await Promise.all([app.inject('/api/swairm/board'), app.inject('/api/swairm/board')]);
    const propositions = (await app.inject('/api/swairm/propositions')).json();
    expect(propositions).toHaveLength(1);
    expect(read).not.toHaveBeenCalled();
    expect(db.prepare('SELECT * FROM pda_demandes').all()).toEqual([]);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/swairm/propositions/${propositions[0].id}`,
        })
      ).statusCode,
    ).toBe(200);
    await app.inject('/api/swairm/board');
    expect((await app.inject('/api/swairm/propositions')).json()).toEqual([]);
  } finally {
    await app.close();
  }
});

test('lien perdu puis rétabli : aucune ancienne transition réveillée', () => {
  const { db } = base();
  releverEtatsSwairm(db, lecture());
  releverEtatsSwairm(db, lecture('merged', null));
  releverEtatsSwairm(db, lecture('merged'));
  expect(propositionsSwairm(db)).toEqual([]);
});

test('host : ni assemblage, ni propositions, ni détection sur le port des appareils', async () => {
  const { startTestDaemon } = await import('./helpers/daemon.js');
  const { RegistreAppareils } = await import('../src/daemon/host/appareils.js');
  const { COOKIE_APPAREIL } = await import('../src/daemon/host/serveur.js');
  const t = await startTestDaemon(undefined, {
    tailscaleExec: async (_bin, args) => ({
      code: null,
      stdout:
        args[0] === 'status'
          ? JSON.stringify({
              BackendState: 'Running',
              Self: { DNSName: 'aid-e2e.ts.net.', UserID: 1 },
              User: {},
            })
          : '',
    }),
  });
  try {
    await t.d.app.inject({
      method: 'PUT',
      url: '/api/host',
      headers: t.headers,
      payload: { actif: true },
    });
    const { jeton } = new RegistreAppareils(t.db).emettre({ nom: 'Exemple', identite: null });
    for (const url of [
      '/api/swairm/board',
      '/api/swairm/propositions',
      '/api/swairm/propositions/1',
    ]) {
      const r = await t.d.modeHost.instance()!.inject({
        method: url.endsWith('/1') ? 'DELETE' : 'GET',
        url,
        headers: {
          host: 'aid-e2e.ts.net',
          origin: 'https://aid-e2e.ts.net',
          'sec-fetch-site': 'same-origin',
          cookie: `${COOKIE_APPAREIL}=${jeton}`,
        },
      });
      expect(r.statusCode).toBe(404);
    }
    expect(t.db.prepare('SELECT * FROM swairm_etats').all()).toEqual([]);
    expect(propositionsSwairm(t.db)).toEqual([]);
  } finally {
    await t.d.stop();
  }
});

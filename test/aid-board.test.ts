import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { liensAid } from '../src/shared/aid-board.js';
import { IdentitesWorkspaces, lireIdentite } from '../src/daemon/aid/workspace.js';
import { lireBoardAid } from '../src/daemon/aid/board.js';
import { BoardReader } from '../src/daemon/mesh/board.js';
import { issueRunToken } from '../src/daemon/security.js';
import { RegistreAppareils } from '../src/daemon/host/appareils.js';
import { COOKIE_APPAREIL } from '../src/daemon/host/serveur.js';
import { seedTopic, startTestDaemon, type TestDaemon } from './helpers/daemon.js';

let t: TestDaemon | undefined;
const dossiers: string[] = [];
afterEach(async () => {
  await t?.d.stop();
  t = undefined;
  dossiers.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

test('D290 : frontières, caractères, préfixes, espaces et CRLF', () => {
  const ligne = (o: string, d: string, s: string) => `AID: ${o}/${d}#${s}`;
  expect(liensAid(ligne('a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100)))).toHaveLength(1);
  for (const args of [
    ['a'.repeat(101), 'b', 'a'],
    ['a', 'b'.repeat(101), 'a'],
    ['a', 'b', 'a'.repeat(101)],
    ['', 'b', 'a'],
    ['a', '', 'a'],
    ['a', 'b', ''],
    ['a', 'b', 'é'],
    ['a', 'b', 'A'],
    ['a', 'b', '-a'],
    ['a', 'b', 'a/b'],
    ['a', 'b', 'a_b'],
  ])
    expect(liensAid(ligne(args[0]!, args[1]!, args[2]!))).toEqual([]);
  for (const corps of [' AID: a/b#a', 'AID: a/b#a ', 'aid: a/b#a', 'AID:  a/b#a'])
    expect(liensAid(corps)).toEqual([]);
  expect(liensAid('AID: a/b#a\r\ntexte\nAID: a/b#ab\r')).toEqual([
    { projet: 'a/b', slug: 'a' },
    { projet: 'a/b', slug: 'ab' },
  ]);
});

test('remote : trois formes GitHub, absence, autres URL et identifiants sans fuite', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aid-identite-'));
  dossiers.push(root);
  execFileSync('git', ['init', root]);
  expect(await lireIdentite(root, 'origin')).toBeNull();
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/o/d.git'], { cwd: root });
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    for (const [url, attendu] of [
      ['https://github.com/o/d.git', 'o/d'],
      ['https://github.com/o/d', 'o/d'],
      ['ssh://git@github.com/o/d.git', 'o/d'],
      ['git@github.com:o/d.git', 'o/d'],
      ['https://example.com/o/d.git', null],
      ['https://user:secret@github.com/o/d.git', 'o/d'],
      ['https://x-access-token:secret@github.com/o/d', 'o/d'],
      ['https://github.com/o/d/', 'o/d'],
      ['ssh://git@github.com:22/o/d.git', 'o/d'],
      ['https://github.com.example.org/o/d', null],
      ['https://evil.com/github.com/o/d', null],
    ] as const) {
      execFileSync('git', ['remote', 'set-url', 'origin', url], { cwd: root });
      const identites = new IdentitesWorkspaces();
      const resultat = await identites.lireWorkspace({ id: 'w', root, remote: 'origin' });
      expect(resultat).toBe(attendu);
      const cache = [...(Reflect.get(identites, 'cache') as Map<string, unknown>)];
      expect(JSON.stringify({ resultat, logs: log.mock.calls, cache })).not.toContain('secret');
    }
  } finally {
    log.mockRestore();
  }
});

test('cache par workspace, fusion et rafraîchissement après changement', async () => {
  const lire = vi.fn(async () => 'o/d');
  const identites = new IdentitesWorkspaces(lire);
  const workspace = { id: 'w', root: '/tmp/a', remote: 'origin' };
  await Promise.all([identites.lireWorkspace(workspace), identites.lireWorkspace(workspace)]);
  expect(lire).toHaveBeenCalledTimes(1);
  await identites.lireWorkspace({ ...workspace, root: '/tmp/b' });
  expect(lire).toHaveBeenCalledTimes(2);
  expect(await identites.lireWorkspace({ ...workspace, remote: null })).toBeNull();
});

function board(cards: unknown[], echec = false) {
  const read = vi.fn(async (args: string[]) => {
    expect(args[0]).toBe('board');
    return {
      ok: true,
      timedOut: false,
      stdout: JSON.stringify(echec ? {} : { cards, searched: cards.length }),
      stderr: '',
    };
  });
  return {
    read,
    lecteur: new BoardReader({ mesh: { read }, cell: 'peer-a', log: () => undefined }),
  };
}

test('assemblage : lien, sans carte, conflit, absent, PR sûre et D268 sans écriture', async () => {
  t = await startTestDaemon();
  seedTopic(t.db);
  t.db.prepare("UPDATE workspaces SET remote = 'origin'").run();
  const sujet = t.db.prepare('SELECT slug FROM topics').get() as { slug: string };
  const { lecteur, read } = board([{ id: 1, body: `AID: o/d#${sujet.slug}\nAID: o/d#absent` }]);
  const avant = t.db.prepare('SELECT total_changes() AS n').get();
  const identites = new IdentitesWorkspaces(async () => 'o/d');
  const resultat = await lireBoardAid(t.db, lecteur, identites);
  expect(resultat.sujets[0]).toMatchObject({ carte: 1, conflit: [], lien: `o/d#${sujet.slug}` });
  expect(resultat.cartes[0]?.sujets).toContainEqual({ lien: 'o/d#absent', sujet: 'absent' });
  expect(read.mock.calls[0]?.[0]).toEqual([
    'board',
    'cards',
    'list',
    '--search',
    'AID: ',
    '--json',
    '--as',
    'peer-a',
  ]);
  expect(t.db.prepare('SELECT total_changes() AS n').get()).toEqual(avant);
  const conflit = await lireBoardAid(
    t.db,
    board([
      { id: 1, body: `AID: o/d#${sujet.slug}` },
      { id: 2, body: `AID: o/d#${sujet.slug}` },
    ]).lecteur,
    identites,
  );
  expect(conflit.sujets[0]).toMatchObject({ carte: null, conflit: [1, 2] });
  t.db.prepare("UPDATE topics SET pr_url = 'https://example.com/pr'").run();
  const erreur = await lireBoardAid(t.db, board([], true).lecteur, identites);
  expect(erreur.sujets[0]).toMatchObject({ carte: null, prUrl: null });
  expect(erreur.board).toMatchObject({ ok: false, kind: 'format' });
  t.db.prepare('UPDATE workspaces SET remote = NULL').run();
  expect((await lireBoardAid(t.db, lecteur, identites)).sujets[0]?.lien).toBeNull();
  const db = t.db;
  const prepare = vi.spyOn(db, 'prepare').mockImplementation(() => {
    throw new Error('lecture');
  });
  try {
    expect(await lireBoardAid(db, lecteur, identites)).toMatchObject({
      sujets: [],
      cartes: [{ id: 1 }],
      erreurs: ['lecture locale'],
    });
  } finally {
    prepare.mockRestore();
  }
});

test('route réservée à l’admin, sans écriture ni route host', async () => {
  t = await startTestDaemon(undefined, {
    tailscaleExec: async (_bin, args) =>
      args[0] === 'status'
        ? {
            stdout: JSON.stringify({
              BackendState: 'Running',
              Self: { DNSName: 'aid-e2e.ts.net.', UserID: 1 },
              User: {},
            }),
            code: null,
          }
        : { stdout: '', code: null },
  });
  expect(
    (await t.d.app.inject({ url: '/api/aid/board', headers: { host: t.headers.host! } }))
      .statusCode,
  ).toBe(401);
  const jeton = issueRunToken(t.d.auth, 'run-test');
  expect(
    (
      await t.d.app.inject({
        url: '/api/aid/board',
        headers: { host: t.headers.host!, authorization: `Bearer ${jeton}` },
      })
    ).statusCode,
  ).toBe(403);
  expect((await t.d.app.inject({ url: '/api/aid/board', headers: t.headers })).statusCode).toBe(
    200,
  );
  expect(
    (await t.d.app.inject({ method: 'POST', url: '/api/aid/board', headers: t.headers }))
      .statusCode,
  ).toBe(404);
  await t.d.app.inject({
    method: 'PUT',
    url: '/api/host',
    headers: t.headers,
    payload: { actif: true },
  });
  const appareil = new RegistreAppareils(t.db).emettre({ nom: 'Téléphone', identite: null });
  expect(
    (
      await t.d.modeHost.instance()!.inject({
        url: '/api/aid/board',
        headers: {
          host: 'aid-e2e.ts.net',
          'sec-fetch-site': 'same-origin',
          'x-aid-cockpit': '1',
          origin: 'https://aid-e2e.ts.net',
          cookie: `${COOKIE_APPAREIL}=${appareil.jeton}`,
        },
      })
    ).statusCode,
  ).toBe(404);
});

test('D291 : comptes isolés par sujet et tous les statuts, tous les runs', async () => {
  t = await startTestDaemon();
  seedTopic(t.db);
  t.db.prepare("INSERT INTO runs VALUES ('run_2','tp_1','standard','closed','t0')").run();
  const statuts = ['starting', 'working', 'needs_input', 'idle', 'done', 'error', 'stopped'];
  for (const [i, statut] of statuts.entries())
    t.db
      .prepare(
        `INSERT INTO agents
    (id, run_id, kind, role, transport, status, cwd, command, created_at, updated_at)
    VALUES (?, ?, 'shell','free','pty',?,'/tmp','[]','t0','t0')`,
      )
      .run(`agent_${i}`, i % 2 ? 'run_1' : 'run_2', statut);
  t.db
    .prepare(
      `INSERT INTO topics SELECT 'tp_2', workspace_id, 'autre', title, type,
    'feat/autre', base, '/tmp/autre', state, phase, index_state, created_at, updated_at,
    pr_number, pr_url, stash_ref FROM topics WHERE id = 'tp_1'`,
    )
    .run();
  t.db.prepare("INSERT INTO runs VALUES ('run_autre','tp_2','standard','open','t0')").run();
  t.db
    .prepare(
      `INSERT INTO agents (id, run_id, kind, role, transport, status, cwd, command, created_at, updated_at)
    VALUES ('agent_autre','run_autre','shell','free','pty','working','/tmp','[]','t0','t0')`,
    )
    .run();
  const identites = new IdentitesWorkspaces(async () => null);
  const avant = t.db.prepare('SELECT total_changes() AS n').get();
  expect((await lireBoardAid(t.db, null, identites)).sujets[0]?.agents).toEqual({
    enMarche: 3,
    enAttente: 2,
    termine: 2,
    enErreur: 1,
  });
  expect(t.db.prepare('SELECT total_changes() AS n').get()).toEqual(avant);
  t.db.prepare('DELETE FROM agents').run();
  expect((await lireBoardAid(t.db, null, identites)).sujets[0]?.agents).toEqual({
    enMarche: 0,
    enAttente: 0,
    termine: 0,
    enErreur: 0,
  });
});

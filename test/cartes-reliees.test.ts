import cookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createAuthState, registerSecurity } from '../src/daemon/security.js';
import { migrate } from '../src/daemon/db.js';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import { EventStore } from '../src/daemon/events/store.js';
import { MeshRegistry } from '../src/daemon/mesh/registre.js';
import { activerMesh } from '../src/daemon/mesh/identite.js';
import { AidHttpError } from '../src/daemon/errors.js';
import { DepotCartesReliees } from '../src/daemon/cartes-reliees/depot.js';
import { CartesReliees } from '../src/daemon/cartes-reliees/service.js';
import { registerCartesRelieesRoutes } from '../src/daemon/routes/cartes-reliees.js';
import { parseCard, type BoardResult, type BoardCard } from '../src/shared/board.js';
import { empreinteMesh } from '../src/shared/meshes.js';
import { injecterEnvFauxSwarph } from './helpers/env-faux-swarph.js';

injecterEnvFauxSwarph();
const nettoyages: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const nettoyer of nettoyages.splice(0).reverse()) await nettoyer();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const cibles = [
  { mesh: 'principal', carte: 1 },
  { mesh: 'perso', carte: 1 },
];
const carte = (mesh: string, id = 1) => ({
  id,
  thread_uuid: `${mesh}-${id}`,
  created_at: '2026-11-13',
  title: mesh,
  stage: 'build',
  assignee: 'peer-a',
  open_obligations: [{ id: 1 }, { id: 2 }],
  due_at: '2026-11-14',
  updated_at: '2026-11-13',
});
const reponse = (mesh: string, id = 1): BoardResult<BoardCard> => ({
  ok: true,
  data: parseCard(carte(mesh, id))!.value,
  readAt: '',
  schemaVersion: null,
});

async function contexte(reel = false, rebranche = false) {
  const home = mkdtempSync(join(tmpdir(), 'aid-cartes-'));
  const db = new Database(join(home, 'etat.db'));
  db.pragma('foreign_keys = ON');
  migrate(db);
  const bin = join(home, 'swarph');
  const journal = join(home, 'journal');
  const faux = join(import.meta.dirname, 'fixtures/fake-swarph.sh');
  writeFileSync(bin, `#!/bin/sh\nexport FAKE_SWARPH_BOARD="$HOME/board"\nexec '${faux}' "$@"\n`, {
    mode: 0o755,
  });
  vi.stubEnv('FAKE_SWARPH_LOG', journal);
  const config = {
    ...DEFAULT_CONFIG,
    mesh: { ...DEFAULT_CONFIG.mesh, bin: reel ? bin : process.execPath },
    meshes: Object.fromEntries(
      ['principal', 'perso'].map((nom) => [
        nom,
        {
          ...DEFAULT_CONFIG.mesh,
          cell: nom,
          home: join(home, nom),
          gateway: `https://${nom}.example.com`,
        },
      ]),
    ),
  };
  for (const nom of ['principal', 'perso']) {
    mkdirSync(join(home, nom, 'board'), { recursive: true });
    writeFileSync(join(home, nom, 'board/cards-show-1.json'), JSON.stringify(carte(nom)));
  }
  if (rebranche) activerMesh(db, 'perso', empreinteMesh('perso', 'https://example.com'));
  const appels: { mesh: string; args: string[] }[] = [];
  const meshes = new MeshRegistry({
    config,
    db,
    store: new EventStore(db),
    log: () => undefined,
    tailscale: async () => 'running',
    ...(reel
      ? {}
      : {
          exec: async (_bin: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
            const mesh = opts.env.SWARPH_SELF!;
            appels.push({ mesh, args });
            return {
              ok: true,
              timedOut: false,
              stderr: '',
              stdout: args[0] === 'board' ? JSON.stringify(carte(mesh, Number(args[3]))) : '{}',
            };
          },
        }),
  });
  await meshes.init();
  await meshes.arreter();
  appels.length = 0;
  if (reel) writeFileSync(journal, '');
  const depot = new DepotCartesReliees(db);
  let maintenant = 100_000;
  const service = new CartesReliees(depot, meshes, () => maintenant);
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    if (req.headers.authorization === 'admin') req.principal = { kind: 'admin', via: 'bearer' };
  });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AidHttpError) return reply.code(err.status).send({ error: err.message });
    throw err;
  });
  registerCartesRelieesRoutes(app, { db, meshes });
  await app.ready();
  nettoyages.push(async () => {
    await app.close();
    await meshes.arreter();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  return {
    home,
    db,
    meshes,
    depot,
    service,
    app,
    appels,
    journal,
    config,
    tick: (ms: number) => {
      maintenant += ms;
    },
    creer: (payload: unknown = { membres: cibles }) =>
      app.inject({
        method: 'POST',
        url: '/api/cartes-reliees',
        headers: { authorization: 'admin', 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      }),
  };
}

test('032 : version, idempotence, deux unicités et cascade', async () => {
  const c = await contexte();
  expect(c.db.pragma('user_version', { simple: true })).toBe(32);
  migrate(c.db);
  const id = await c.service.creer(cibles, null);
  const membre = c.depot.obtenir(id).membres[0]!;
  const inserer = c.db.prepare(`INSERT INTO membres_groupe
    (groupe, mesh, empreinte, carte, thread_uuid, ajoute_a) VALUES (?, ?, ?, ?, ?, 'date')`);
  const autre = c.db
    .prepare("INSERT INTO groupes_cartes(cree_a) VALUES ('date')")
    .run().lastInsertRowid;
  expect(() => inserer.run(autre, membre.mesh, membre.empreinte, membre.carte, 'autre')).toThrow(
    /UNIQUE/,
  );
  expect(() => inserer.run(id, membre.mesh, membre.empreinte, 2, 'autre')).toThrow(/UNIQUE/);
  c.db.prepare('DELETE FROM groupes_cartes WHERE id = ?').run(id);
  expect(c.db.prepare('SELECT * FROM membres_groupe').all()).toEqual([]);
});

test('parseCard conserve thread_uuid et tolère son absence ou un type incorrect', () => {
  expect(parseCard(carte('principal'))?.value.threadUuid).toBe('principal-1');
  expect(parseCard({ id: 1 })?.value.threadUuid).toBeNull();
  expect(parseCard({ id: 1, thread_uuid: 42 })?.value.threadUuid).toBeNull();
});

test('création et ajout : UUID et date lus par le daemon, corps forgé ignoré ; routes locales', async () => {
  const c = await contexte();
  const r = await c.creer({
    membres: cibles.map((m) => ({
      ...m,
      thread_uuid: 'faux',
      carte_creee_a: 'faux',
      created_at: 'faux',
    })),
    note: '<b>texte</b>',
  });
  expect(r.statusCode).toBe(201);
  const id = r.json().id as number;
  expect(c.depot.obtenir(id).membres.map((m) => [m.thread_uuid, m.carte_creee_a])).toEqual([
    ['principal-1', '2026-11-13'],
    ['perso-1', '2026-11-13'],
  ]);
  const groupe = (await c.app.inject('/api/cartes-reliees?mesh=principal&carte=1')).json();
  expect(groupe.id).toBe(id);
  expect(groupe.note).toBe('<b>texte</b>');
  expect((await c.app.inject('/api/cartes-reliees?mesh=principal&carte=99')).json()).toBeNull();
  expect(
    (
      await c.app.inject({
        method: 'PATCH',
        url: `/api/cartes-reliees/${id}`,
        headers: { authorization: 'admin' },
        payload: { note: 'suite' },
      })
    ).statusCode,
  ).toBe(204);
  expect(c.depot.obtenir(id).note).toBe('suite');
  const membre = c.depot.obtenir(id).membres[0]!.id;
  expect(
    (
      await c.app.inject({
        method: 'DELETE',
        url: `/api/cartes-reliees/${id}/membres/${membre}`,
        headers: { authorization: 'admin' },
      })
    ).statusCode,
  ).toBe(204);
  expect(c.depot.liste()).toEqual([]);
  const seul = c.depot.creer([await c.service.preparer(cibles[0]!)], null);
  expect(
    (
      await c.app.inject({
        method: 'POST',
        url: `/api/cartes-reliees/${seul}/membres`,
        headers: { authorization: 'admin' },
        payload: { ...cibles[1], thread_uuid: 'faux', carte_creee_a: 'faux' },
      })
    ).statusCode,
  ).toBe(204);
  expect(c.depot.obtenir(seul).membres[1]).toMatchObject({
    thread_uuid: 'perso-1',
    carte_creee_a: '2026-11-13',
  });
});

test.each([
  null,
  [],
  {},
  { membres: [] },
  { membres: [{}, {}] },
  { membres: [cibles[0], cibles[0]] },
  { membres: cibles, note: 'a'.repeat(121) },
  { membres: cibles, note: 12 },
  { membres: [{ mesh: 'principal', carte: -1 }, cibles[1]] },
  { membres: [{ mesh: 'absent', carte: 1 }, cibles[1]] },
])('400 : corps, note, doublon de mesh, identifiant ou mesh inactif %j', async (payload) => {
  const c = await contexte();
  expect((await c.creer(payload)).statusCode).toBe(400);
  expect(c.depot.liste()).toEqual([]);
});

test('400 : mesh connu mais inactif ; 404 carte ; 409 UUID absent', async () => {
  const c = await contexte(false, true);
  expect((await c.creer()).statusCode).toBe(400);
  await c.meshes.archiver('perso');
  vi.spyOn(c.meshes.obtenir('perso').board, 'carte').mockResolvedValue({
    ok: false,
    kind: 'not-found',
    readAt: '',
  });
  expect((await c.creer()).statusCode).toBe(404);
  vi.mocked(c.meshes.obtenir('perso').board.carte).mockResolvedValue({
    ...reponse('perso'),
    ok: true,
    data: parseCard({ id: 1 })!.value,
    readAt: '',
    schemaVersion: null,
  });
  expect((await c.creer()).statusCode).toBe(409);
});

test('409 : carte déjà liée, mesh déjà présent, 500 groupes ; échec atomique', async () => {
  const c = await contexte();
  const id = await c.service.creer(cibles, null);
  expect((await c.creer()).statusCode).toBe(409);
  expect(
    (
      await c.app.inject({
        method: 'POST',
        url: `/api/cartes-reliees/${id}/membres`,
        headers: { authorization: 'admin' },
        payload: { mesh: 'perso', carte: 2 },
      })
    ).statusCode,
  ).toBe(409);
  expect(c.depot.liste()).toHaveLength(1);
  const inserer = c.db.prepare("INSERT INTO groupes_cartes(cree_a) VALUES ('date')");
  for (let i = 1; i < 500; i++) inserer.run();
  expect((await c.creer({ membres: cibles.map((m) => ({ ...m, carte: 2 })) })).statusCode).toBe(
    409,
  );
  expect(c.depot.liste()).toHaveLength(500);
});

test.each(['thread', 'date', 'disparue', 'erreur', 'delai', 'exception', 'inactif', 'empreinte'])(
  'statut et aucun champ de carte divulgué : %s',
  async (cas) => {
    const c = await contexte();
    await c.service.creer(cibles, null);
    const lecteur = vi.spyOn(c.meshes.obtenir('perso').board, 'carte');
    if (cas === 'thread' || cas === 'date') {
      const r = reponse('perso');
      if (r.ok) {
        if (cas === 'thread') r.data.threadUuid = 'remplace';
        else r.data.createdAt = 'autre';
      }
      lecteur.mockResolvedValue(r);
    } else if (cas === 'exception') lecteur.mockRejectedValue(new Error('erreur'));
    else if (['disparue', 'erreur', 'delai'].includes(cas))
      lecteur.mockResolvedValue({
        ok: false,
        kind: cas === 'disparue' ? 'not-found' : cas === 'delai' ? 'timeout' : 'unreachable',
        readAt: '',
      });
    else if (cas === 'inactif')
      vi.spyOn(c.meshes, 'liste').mockReturnValue(
        c.meshes.liste().map((m) => ({ ...m, actif: m.nom !== 'perso' })),
      );
    else
      vi.spyOn(c.meshes, 'configuration').mockImplementation((nom) => ({
        ...c.config.meshes[nom!]!,
        gateway: 'https://example.com',
      }));
    const groupes = await c.service.liste();
    expect(Array.isArray(groupes)).toBe(true);
    if (!Array.isArray(groupes)) throw new Error('liste attendue');
    const m = groupes[0]!.membres[1]!;
    expect(m).toEqual({
      id: expect.any(Number),
      mesh: 'perso',
      carte: 1,
      statut: ['inactif', 'empreinte'].includes(cas)
        ? 'mesh_change'
        : ['thread', 'date', 'disparue'].includes(cas)
          ? 'carte_remplacee'
          : 'lecture_impossible',
    });
    expect(groupes[0]!.ecart).toBe(false);
    if (['inactif', 'empreinte'].includes(cas)) expect(lecteur).not.toHaveBeenCalled();
  },
);

test('archivage réel : tables intactes, membre mesh_change après réactivation', async () => {
  const c = await contexte(false, true);
  const principal = await c.service.preparer(cibles[0]!);
  c.depot.creer(
    [
      principal,
      {
        mesh: 'perso',
        carte: 1,
        empreinte: empreinteMesh('perso', 'https://example.com'),
        thread_uuid: 'perso-1',
        carte_creee_a: '2026-11-13',
      },
    ],
    null,
  );
  const avant = c.depot.liste();
  await c.meshes.archiver('perso');
  expect(c.depot.liste()).toEqual(avant);
  expect(await c.service.liste()).toMatchObject([
    { membres: [{ statut: 'ok' }, { statut: 'mesh_change' }] },
  ]);
});

test('ok : champs autorisés et écart par égalité textuelle des étapes', async () => {
  const c = await contexte();
  await c.service.creer(cibles, null);
  expect(await c.service.liste()).toMatchObject([
    {
      ecart: false,
      membres: [
        { titre: 'principal', etape: 'build', responsable: 'peer-a', obligations: 2 },
        { titre: 'perso' },
      ],
    },
  ]);
  const r = reponse('perso');
  if (r.ok) r.data.stage = 'Build';
  vi.spyOn(c.meshes.obtenir('perso').board, 'carte').mockResolvedValue(r);
  c.tick(60_000);
  expect(await c.service.liste()).toMatchObject([{ ecart: true }]);
});

test('limite globale de quatre lectures, coalescence et cache de 60 s', async () => {
  const c = await contexte();
  for (let i = 1; i <= 6; i++)
    await c.service.creer(
      cibles.map((m) => ({ ...m, carte: i })),
      null,
    );
  let simultanees = 0;
  let maximum = 0;
  let nombre = 0;
  const liberer: (() => void)[] = [];
  for (const mesh of ['principal', 'perso'])
    vi.spyOn(c.meshes.obtenir(mesh).board, 'carte').mockImplementation(async (id) => {
      nombre++;
      simultanees++;
      maximum = Math.max(maximum, simultanees);
      await new Promise<void>((resolve) => liberer.push(resolve));
      simultanees--;
      return reponse(mesh, id);
    });
  const a = c.service.liste();
  const b = c.service.liste();
  expect(nombre).toBe(4);
  while (nombre < 12 || simultanees) {
    liberer.splice(0).forEach((resolve) => resolve());
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await Promise.all([a, b]);
  expect(maximum).toBe(4);
  expect(nombre).toBe(12);
  c.tick(59_999);
  await c.service.liste();
  expect(nombre).toBe(12);
  c.tick(1);
  const suivant = c.service.liste();
  expect(nombre).toBe(16);
  while (nombre < 24 || simultanees) {
    liberer.splice(0).forEach((resolve) => resolve());
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await suivant;
  expect(nombre).toBe(24);
});

test('cache séparé par empreinte : un numéro réutilisé est relu', async () => {
  const c = await contexte();
  await c.service.creer(cibles, null);
  await c.service.liste();
  const configurer = c.meshes.configuration.bind(c.meshes);
  vi.spyOn(c.meshes, 'configuration').mockImplementation((nom) => ({
    ...configurer(nom),
    gateway: 'https://example.com',
  }));
  c.db.prepare('DELETE FROM groupes_cartes').run();
  await c.service.creer(cibles, null);
  const lecteur = vi.spyOn(c.meshes.obtenir('perso').board, 'carte');
  await c.service.liste();
  expect(lecteur).toHaveBeenCalledOnce();
});

test('deux faux meshes : bon lecteur, BoardReader.carte en cache et journal sans écriture mesh', async () => {
  const c = await contexte(true);
  const r = await c.creer();
  expect(r.statusCode).toBe(201);
  const id = r.json().id as number;
  const { groupes } = (await c.app.inject('/api/cartes-reliees')).json();
  expect(groupes[0].membres.map((m: { titre: string }) => m.titre)).toEqual(['principal', 'perso']);
  const lecteur = c.meshes.obtenir('principal').board;
  await lecteur.carte(1);
  await lecteur.carte(1);
  await c.app.inject({
    method: 'PATCH',
    url: `/api/cartes-reliees/${id}`,
    headers: { authorization: 'admin' },
    payload: { note: 'texte' },
  });
  await c.app.inject({
    method: 'POST',
    url: `/api/cartes-reliees/${id}/membres`,
    headers: { authorization: 'admin' },
    payload: { mesh: 'perso', carte: 2 },
  });
  await c.app.inject({
    method: 'DELETE',
    url: `/api/cartes-reliees/${id}/membres/${groupes[0].membres[0].id}`,
    headers: { authorization: 'admin' },
  });
  const lignes = readFileSync(c.journal, 'utf8').trim().split('\n');
  expect(lignes).toHaveLength(5);
  for (const ligne of lignes)
    expect(ligne).toMatch(/^board cards show [12] --json --as (principal|perso)$/);
});

test.each([
  ['POST', '/api/cartes-reliees'],
  ['POST', '/api/cartes-reliees/1/membres'],
  ['DELETE', '/api/cartes-reliees/1/membres/1'],
  ['PATCH', '/api/cartes-reliees/1'],
] as const)('garde admin : %s %s', async (method, url) => {
  const c = await contexte();
  expect((await c.app.inject({ method, url, payload: {} })).statusCode).toBe(403);
  expect(c.appels).toEqual([]);
});

async function contextePagination(nombre: number) {
  const c = await contexte();
  const modeles = await Promise.all(cibles.map((cible) => c.service.preparer(cible)));
  for (let carte = 1; carte <= nombre; carte++)
    c.depot.creer(
      modeles.map((m) => ({ ...m, carte, thread_uuid: `${m.mesh}-${carte}` })),
      null,
    );
  c.appels.length = 0;
  return c;
}

test.each([
  ['', 20],
  ['?limite=50', 50],
] as const)(
  'pagination : défaut et maximum %s, lectures limitées aux groupes rendus',
  async (query, nombre) => {
    const c = await contextePagination(61);
    const r = await c.app.inject(`/api/cartes-reliees${query}`);
    expect(r.statusCode).toBe(200);
    const page = r.json();
    expect(page.groupes.map((g: { id: number }) => g.id)).toEqual(
      Array.from({ length: nombre }, (_, i) => i + 1),
    );
    expect(page.suivant).toBe(nombre);
    expect(c.appels).toHaveLength(nombre * 2);
    for (const appel of c.appels) {
      expect(appel.args.slice(0, 3)).toEqual(['board', 'cards', 'show']);
      expect(Number(appel.args[3])).toBeGreaterThanOrEqual(1);
      expect(Number(appel.args[3])).toBeLessThanOrEqual(nombre);
    }
    expect(page.groupes[0].membres.map((m: { titre: string }) => m.titre)).toEqual([
      'principal',
      'perso',
    ]);
  },
);

test('pagination : curseur exclusif, suite, dernière page pleine puis page vide', async () => {
  const c = await contextePagination(61);
  const premiere = (await c.app.inject('/api/cartes-reliees?limite=2&apres=58')).json();
  expect(premiere.groupes.map((g: { id: number }) => g.id)).toEqual([59, 60]);
  expect(premiere.suivant).toBe(60);
  expect(c.appels.map((a) => Number(a.args[3])).sort((a, b) => a - b)).toEqual([59, 59, 60, 60]);
  c.appels.length = 0;
  const derniere = (await c.app.inject('/api/cartes-reliees?limite=2&apres=59')).json();
  expect(derniere.groupes.map((g: { id: number }) => g.id)).toEqual([60, 61]);
  expect(derniere.suivant).toBeNull();
  expect(c.appels.map((a) => Number(a.args[3]))).toEqual([61, 61]);
  c.appels.length = 0;
  expect((await c.app.inject('/api/cartes-reliees?apres=61')).json()).toEqual({
    groupes: [],
    suivant: null,
  });
  expect(c.appels).toEqual([]);
});

test('pagination : aucun groupe et recherche ciblée inchangée', async () => {
  const c = await contexte();
  expect((await c.app.inject('/api/cartes-reliees')).json()).toEqual({
    groupes: [],
    suivant: null,
  });
  expect(c.appels).toEqual([]);
  const id = await c.service.creer(cibles, null);
  const groupe = (
    await c.app.inject('/api/cartes-reliees?mesh=principal&carte=1&limite=1&apres=999')
  ).json();
  expect(groupe.id).toBe(id);
  expect(groupe.membres).toHaveLength(2);
  expect(groupe).not.toHaveProperty('groupes');
  expect(groupe).not.toHaveProperty('suivant');
});

test.each([
  'limite=0',
  'limite=51',
  'limite=-1',
  'limite=1.5',
  'limite=',
  'limite=abc',
  'limite=1e1',
  'limite=9007199254740992',
  'limite=1&limite=2',
  'apres=-1',
  'apres=1.5',
  'apres=',
  'apres=abc',
  'apres=1e1',
  'apres=9007199254740992',
  'apres=1&apres=2',
])('pagination : refus 400 sans lecture pour %s', async (query) => {
  const c = await contextePagination(1);
  expect((await c.app.inject(`/api/cartes-reliees?${query}`)).statusCode).toBe(400);
  expect(c.appels).toEqual([]);
});

test('48.1c : retrait sans cascade, aucune ligne orpheline et carte réutilisable', async () => {
  const c = await contexte();
  c.db.pragma('foreign_keys = OFF');
  const id = await c.service.creer(cibles, null);
  c.depot.retirer(id, c.depot.obtenir(id).membres[0]!.id);
  expect(c.db.prepare('SELECT * FROM membres_groupe').all()).toEqual([]);
  expect(c.depot.liste()).toEqual([]);
  const nouveau = await c.service.creer(cibles, null);
  expect(c.depot.obtenir(nouveau).membres).toHaveLength(2);
});

test.each([
  ['2026-11-13T00:00:00.000Z', '2026-11-13T01:00:00+01:00', 'ok'],
  [null, null, 'ok'],
  [null, '2026-11-13', 'carte_remplacee'],
  ['illisible', 'illisible', 'ok'],
  ['illisible', 'autre', 'carte_remplacee'],
  ['2026-11-13', '2026-11-14', 'carte_remplacee'],
] as const)('48.1c : dates %s et %s : %s', async (initiale, lue, statut) => {
  const c = await contexte();
  const membres = await Promise.all(cibles.map((cible) => c.service.preparer(cible)));
  membres[1]!.carte_creee_a = initiale;
  c.depot.creer(membres, null);
  const resultat = reponse('perso');
  if (!resultat.ok) throw new Error('réponse attendue');
  resultat.data.createdAt = lue;
  vi.spyOn(c.meshes.obtenir('perso').board, 'carte').mockResolvedValue(resultat);
  expect(await c.service.liste()).toMatchObject([{ membres: [{ statut: 'ok' }, { statut }] }]);
});

test.each(['réponse', 'exception'] as const)('48.1c : cache négatif de 5 s (%s)', async (cas) => {
  const c = await contexte();
  await c.service.creer(cibles, null);
  const lecteur = vi.spyOn(c.meshes.obtenir('perso').board, 'carte');
  if (cas === 'exception') lecteur.mockRejectedValueOnce(new Error('lecture impossible'));
  else lecteur.mockResolvedValueOnce({ ok: false, kind: 'unreachable', readAt: '' });
  lecteur.mockResolvedValue(reponse('perso'));
  expect(await c.service.liste()).toMatchObject([
    { membres: [{ statut: 'ok' }, { statut: 'lecture_impossible' }] },
  ]);
  c.tick(4_999);
  await c.service.liste();
  expect(lecteur).toHaveBeenCalledTimes(1);
  c.tick(1);
  expect(await c.service.liste()).toMatchObject([
    { membres: [{ statut: 'ok' }, { statut: 'ok' }] },
  ]);
  expect(lecteur).toHaveBeenCalledTimes(2);
});

test('48.1c : la vraie garde refuse GET cartes reliées au jeton de run', async () => {
  const c = await contexte();
  const app = Fastify();
  nettoyages.push(() => app.close());
  await app.register(cookie);
  const auth = createAuthState();
  auth.runTokens.set('jeton-factice', 'run-factice');
  registerSecurity(app, auth, { getPort: () => 4321 });
  registerCartesRelieesRoutes(app, { db: c.db, meshes: c.meshes });
  const reponse = await app.inject({
    method: 'GET',
    url: '/api/cartes-reliees',
    headers: { host: 'localhost:4321', authorization: 'Bearer jeton-factice' },
  });
  expect(reponse.statusCode).toBe(403);
  expect(reponse.json()).toEqual({ error: 'token de run : POST /api/events uniquement' });
  expect(c.appels).toEqual([]);
});

test('48.3 : date ISO sans fuseau lue en UTC, dans les deux sens', async () => {
  const ancienFuseau = process.env.TZ;
  process.env.TZ = 'Europe/Paris';
  try {
    expect(new Date('2026-07-09T05:21:39').getTimezoneOffset()).toBe(-120);
    for (const [initiale, lue] of [
      ['2026-11-13T12:34:56.123', '2026-11-13T12:34:56.123Z'],
      ['2026-11-13T12:34:56.123Z', '2026-11-13T12:34:56.123'],
      ['2026-07-09 05:21:39', '2026-07-09T05:21:39'],
      ['2026-07-09T05:21:39', '2026-07-09 05:21:39'],
      ['2026-07-09 05:21:39', '2026-07-09T05:21:39Z'],
      ['2026-07-09T05:21:39Z', '2026-07-09 05:21:39'],
      ['2026-07-09T05:21:39', '2026-07-09T05:21:39Z'],
      ['2026-07-09T05:21:39Z', '2026-07-09T05:21:39'],
      ['2026-07-09 05:21', '2026-07-09T05:21:00Z'],
      ['2026-07-09 05:21:39.123', '2026-07-09T05:21:39.123Z'],
      ['2026-07-09 07:21:39+02:00', '2026-07-09T05:21:39Z'],
    ]) {
      const c = await contexte();
      const membres = await Promise.all(cibles.map((cible) => c.service.preparer(cible)));
      membres[1]!.carte_creee_a = initiale!;
      c.depot.creer(membres, null);
      const resultat = reponse('perso');
      if (!resultat.ok) throw new Error('réponse attendue');
      resultat.data.createdAt = lue!;
      vi.spyOn(c.meshes.obtenir('perso').board, 'carte').mockResolvedValue(resultat);
      expect(await c.service.liste()).toMatchObject([
        { membres: [{ statut: 'ok' }, { statut: 'ok' }] },
      ]);
    }
  } finally {
    if (ancienFuseau === undefined) delete process.env.TZ;
    else process.env.TZ = ancienFuseau;
  }
});

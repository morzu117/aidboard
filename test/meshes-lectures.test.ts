import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, expect, test, vi } from 'vitest';
import { DEFAULT_CONFIG, type AidConfig } from '../src/daemon/config.js';
import { openDb } from '../src/daemon/db.js';
import { EventStore } from '../src/daemon/events/store.js';
import { MeshRegistry } from '../src/daemon/mesh/registre.js';
import { envSwarph } from '../src/daemon/mesh/env.js';
import { registerMeshRoutes } from '../src/daemon/routes/mesh.js';
import { registerBoardRoutes } from '../src/daemon/routes/board.js';
import { registerSwarphRoutes } from '../src/daemon/routes/swarph.js';
import { registerAvisMeshRoutes } from '../src/daemon/routes/avis-mesh.js';
import { AidHttpError } from '../src/daemon/errors.js';
import { buildSnapshot } from '../src/daemon/state/snapshot.js';
import { StructuralService } from '../src/daemon/structural/service.js';
import { activerMesh } from '../src/daemon/mesh/identite.js';
import { empreinteMesh } from '../src/shared/meshes.js';
import { agentEnv } from '../src/daemon/pty/spawn.js';
import type { Porte } from '../src/daemon/confirmations/porte.js';

const hostiles = [
  'MESH_GATEWAY_TOKEN',
  'SWARPH_GATEWAY',
  'SWARPH_STATE_ROOT',
  'SWARPH_SERVICE_TOKEN',
  'SWARPH_BRAIN_GATEWAY',
  'MESH_DB_PATH',
  'SWARPH_CHANNEL_CELL',
  'SWARPH_MEMORY_DIR',
  'GBRAIN_TOKEN',
  'SWARPH_BRAIN_TOKEN',
];
const nettoyages: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const nettoyer of nettoyages.splice(0).reverse()) await nettoyer();
});

async function contexte(rebranche = false, initialiser = true) {
  const home = mkdtempSync(join(tmpdir(), 'aid-46-lectures-'));
  const db = openDb(join(home, 'state.db'));
  const store = new EventStore(db);
  const config: AidConfig = {
    ...DEFAULT_CONFIG,
    mesh: { ...DEFAULT_CONFIG.mesh, bin: process.execPath },
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
  };
  if (rebranche) activerMesh(db, 'perso', empreinteMesh('perso', 'https://perso.example.com'));
  const appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const registre = new MeshRegistry({
    config,
    db,
    store,
    log: () => undefined,
    tailscale: async () => 'running',
    exec: async (_bin, args, opts) => {
      appels.push({ args, env: opts.env });
      return {
        ok: true,
        stdout: args[0] === 'monitor' ? '{"running":true}' : '{}',
        stderr: '',
        timedOut: false,
      };
    },
  });
  nettoyages.push(() => {
    registre.dispose();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  if (initialiser) await registre.init();
  return { home, db, store, config, registre, appels };
}

function dm(store: EventStore, mesh: unknown, id = 1) {
  store.append({
    source: 'swarph',
    type: 'mesh.dm',
    data: {
      mesh,
      id,
      from: 'principal',
      to: 'perso',
      kind: 'question',
      content: String(mesh),
    },
  });
}

function environnement(env: NodeJS.ProcessEnv, home: string, gateway: string) {
  expect(env.HOME).toBe(home);
  expect(env.SWARPH_SELF).toBe('principal');
  expect(env.SWARPH_STATE).toBe(join(home, 'swarph_state'));
  expect(env.MESH_GATEWAY_URL).toBe(gateway);
  for (const nom of hostiles)
    if (nom === 'SWARPH_BRAIN_GATEWAY') expect(env[nom]).toBe(gateway);
    else expect(env).not.toHaveProperty(nom);
  expect(env).not.toHaveProperty('AUTRE_SECRET');
}

test('deux identités de même cell : environnement reçu par service, deux boards, comité et lectures', async () => {
  for (const nom of [...hostiles, 'AUTRE_SECRET']) vi.stubEnv(nom, 'hostile');
  const c = await contexte();
  await c.registre.init();
  for (const nom of ['principal', 'perso']) {
    const s = c.registre.obtenir(nom);
    const debut = c.appels.length;
    await s.mesh.read(['monitor', 'status']);
    await s.board.projects();
    await s.boardHost.projects();
    await s.lecteur.motionOuverte('principal');
    await s.ecrivain.baselineAbsent({ canal: 'principal', raison: 'exemple' });
    await s.swarph.peers();
    await s.swarph.memory();
    await s.swarph.codegraph('principal');
    expect(c.appels.length - debut).toBe(8);
    for (const appel of c.appels.slice(debut))
      environnement(appel.env, join(c.home, nom), `https://${nom}.example.com`);
  }
});

test('liste blanche et ajouts du terminal : seuls terminal et hooks AID sont ajoutés', async () => {
  const c = await contexte();
  for (const nom of [...hostiles, 'AUTRE_SECRET']) vi.stubEnv(nom, 'hostile');
  vi.stubEnv('LC_ALL', 'C');
  vi.stubEnv('TMPDIR', '/tmp');
  const mesh = c.registre.configuration('perso');
  const env = agentEnv(envSwarph(mesh), [], { AID_TOPIC: 'principal' });
  environnement(env, join(c.home, 'perso'), 'https://perso.example.com');
  expect(env).toMatchObject({
    LC_ALL: 'C',
    TMPDIR: '/tmp',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    AID_TOPIC: 'principal',
  });
});

test('boîtes, marques et instantané séparés ; alias principal', async () => {
  const c = await contexte();
  dm(c.store, 'principal');
  dm(c.store, 'perso');
  const principal = c.registre.obtenir().mesh;
  const perso = c.registre.obtenir('perso').mesh;
  expect(principal.inbox()[0]!.content).toBe('principal');
  expect(perso.inbox()[0]!.content).toBe('perso');
  perso.markSeen(1);
  perso.markDecision(1);
  expect(principal.inbox()[0]).toMatchObject({ seenAt: null, decidedAt: null });
  expect(perso.inbox()[0]!.seenAt).toBeTruthy();
  const snapshot = await buildSnapshot(
    c.db,
    new StructuralService({ engine: 'off' }),
    false,
    null,
    false,
    c.registre,
  );
  expect(snapshot.mesh).toEqual(snapshot.meshes?.principal);
  expect(snapshot.meshes?.perso?.inbox[0]!.content).toBe('perso');
});

test('rebranchement inactif, archivage puis activation sans ancienne donnée', async () => {
  const c = await contexte(true);
  dm(c.store, 'perso');
  expect(c.registre.liste().find((m) => m.nom === 'perso')).toMatchObject({
    actif: false,
    erreur: 'rebranche',
  });
  expect(() => c.registre.obtenir('perso')).toThrow('rebranche');
  await c.registre.archiver('perso');
  expect(c.registre.obtenir('perso').mesh.inbox()).toEqual([]);
  expect(
    c.db.prepare("SELECT mesh FROM mesh_inbox WHERE mesh LIKE 'perso@archive-%'").get(),
  ).toBeTruthy();
  await expect(c.registre.archiver('principal')).rejects.toThrow('mesh non rebranche');
});

test.each([null, 12, {}, '', '../perso', 'Perso', 'perso@archive-invalide'])(
  'projecteurs : mesh invalide %j ignoré',
  async (mesh) => {
    const c = await contexte(false, false);
    dm(c.store, mesh);
    c.store.append({ source: 'swarph', type: 'mesh.state', data: { mesh, connected: true } });
    expect((c.db.prepare('SELECT count(*) AS n FROM mesh_inbox').get() as { n: number }).n).toBe(0);
    expect((c.db.prepare('SELECT count(*) AS n FROM mesh_state').get() as { n: number }).n).toBe(0);
  },
);

test('projecteurs : événements anciens et archives acceptés', async () => {
  const c = await contexte();
  dm(c.store, undefined);
  dm(c.store, 'perso@archive-2026-11-12');
  expect(c.registre.principal?.mesh.inbox()).toHaveLength(1);
  expect((c.db.prepare('SELECT count(*) AS n FROM mesh_inbox').get() as { n: number }).n).toBe(2);
});

async function serveur(c: Awaited<ReturnType<typeof contexte>>) {
  const app = Fastify();
  app.setErrorHandler((e, _req, reply) => {
    if (e instanceof AidHttpError) return reply.code(e.status).send({ error: e.message });
    return reply.code(500).send({ error: 'erreur interne' });
  });
  registerMeshRoutes(app, { mesh: null, meshes: c.registre });
  registerBoardRoutes(app, { board: null, meshes: c.registre });
  registerSwarphRoutes(app, { swarph: null, meshes: c.registre });
  registerAvisMeshRoutes(app, { avis: null, meshes: c.registre, porte: {} as Porte });
  nettoyages.push(() => app.close());
  return app;
}

test('routes : sélection, 404, 409 et liste JSON sans gateway, home ni chemin', async () => {
  const c = await contexte(true);
  const app = await serveur(c);
  for (const chemin of [
    '/api/mesh',
    '/api/board/projects',
    '/api/swarph/cells',
    '/api/avis-mesh',
  ]) {
    expect((await app.inject(`${chemin}?mesh=inconnu`)).statusCode).toBe(404);
    const r = await app.inject(`${chemin}?mesh=perso`);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'rebranche' });
    expect((await app.inject(chemin)).statusCode).toBe(200);
  }
  const liste = await app.inject('/api/meshes');
  expect(liste.statusCode).toBe(200);
  expect(liste.body).not.toMatch(/gateway|proxySocket|stateRoot|home|example\.com/);
  expect(liste.body).not.toContain(c.home);
  expect(Object.keys(liste.json()[0]).sort()).toEqual([
    'actif',
    'cell',
    'ecriture',
    'erreur',
    'etat',
    'nom',
  ]);
  expect((await app.inject({ method: 'POST', url: '/api/meshes/perso/archiver' })).statusCode).toBe(
    403,
  );
});

test('routes DM et connexion : mesh du chemin, anciennes formes sur principal', async () => {
  const c = await contexte();
  dm(c.store, 'principal');
  dm(c.store, 'perso');
  const app = await serveur(c);
  for (const action of ['seen', 'decision']) {
    expect(
      (await app.inject({ method: 'POST', url: `/api/mesh/perso/dm/1/${action}` })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'POST', url: `/api/mesh/inconnu/dm/1/${action}` })).statusCode,
    ).toBe(404);
  }
  expect(c.registre.principal?.mesh.inbox()[0]!.seenAt).toBeNull();
  expect((await app.inject({ method: 'POST', url: '/api/mesh/dm/1/seen' })).statusCode).toBe(200);
  for (const action of ['connect', 'disconnect'])
    expect(
      (await app.inject({ method: 'POST', url: `/api/mesh/perso/${action}` })).statusCode,
    ).toBe(202);
});

test('une erreur de lecture reste locale à son mesh', async () => {
  const c = await contexte();
  vi.spyOn(c.registre.obtenir('perso').mesh, 'read').mockRejectedValue(new Error('indisponible'));
  const app = await serveur(c);
  expect((await app.inject('/api/board/projects?mesh=perso')).json()).toMatchObject({ ok: false });
  expect((await app.inject('/api/board/projects?mesh=principal')).statusCode).toBe(200);
});

test('un échec de construction ne bloque pas les autres meshes', async () => {
  const c = await contexte();
  const configuration = structuredClone(c.config);
  configuration.meshes.perso!.gateway = 'gateway invalide';
  const registre = new MeshRegistry({
    config: configuration,
    db: c.db,
    store: c.store,
    log: () => undefined,
  });
  nettoyages.push(() => registre.dispose());
  await registre.init();
  expect(registre.principal).not.toBeNull();
  expect(() => registre.obtenir('perso')).toThrow(
    expect.objectContaining({ status: 409, message: 'demarrage' }),
  );
  expect(registre.liste().find((m) => m.nom === 'perso')).toMatchObject({
    actif: false,
    erreur: 'demarrage',
  });
});

test('sans gateway : aucune valeur hostile et aucun gateway implicite', async () => {
  const c = await contexte();
  for (const nom of hostiles) vi.stubEnv(nom, 'hostile');
  const env = envSwarph({ ...c.registre.configuration(), gateway: '' });
  for (const nom of hostiles) expect(env).not.toHaveProperty(nom);
  expect(env).not.toHaveProperty('MESH_GATEWAY_URL');
});

test('archivage local authentifié : activation et alias visibles sans redémarrage', async () => {
  const { startTestDaemon } = await import('./helpers/daemon.js');
  const { issueRunToken } = await import('../src/daemon/security.js');
  const home = mkdtempSync(join(tmpdir(), 'aid-46-archive-'));
  const base = openDb(join(home, 'state.db'));
  activerMesh(base, 'principal', empreinteMesh('perso', 'https://perso.example.com'));
  base.close();
  const t = await startTestDaemon(home, {
    config: {
      mesh: { ...DEFAULT_CONFIG.mesh, bin: '/exemple/binaire-absent' },
      meshes: {
        principal: {
          ...DEFAULT_CONFIG.mesh,
          cell: 'principal',
          home: join(home, 'principal'),
          gateway: 'https://principal.example.com',
        },
      },
    },
  });
  try {
    const chemin = '/api/meshes/principal/archiver';
    const headersRun = {
      ...t.headers,
      authorization: `Bearer ${issueRunToken(t.d.auth, 'principal')}`,
    };
    expect(
      (await t.d.app.inject({ method: 'POST', url: chemin, headers: headersRun })).statusCode,
    ).toBe(403);
    expect(
      (
        await t.d.app.inject({
          method: 'POST',
          url: chemin,
          headers: { ...t.headers, origin: 'https://example.com' },
        })
      ).statusCode,
    ).toBe(403);
    expect((await t.d.app.inject({ url: '/api/mesh', headers: t.headers })).statusCode).toBe(409);
    expect(
      (await t.d.app.inject({ method: 'POST', url: chemin, headers: t.headers })).statusCode,
    ).toBe(204);
    expect((await t.d.app.inject({ url: '/api/mesh', headers: t.headers })).statusCode).toBe(200);
    const snapshot = (await t.d.app.inject({ url: '/api/state', headers: t.headers })).json();
    expect(snapshot.mesh).toEqual(snapshot.meshes.principal);
    expect(
      (await t.d.app.inject({ method: 'POST', url: chemin, headers: t.headers })).statusCode,
    ).toBe(409);
  } finally {
    await t.d.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('avis lus par mesh : listes et détails restent cloisonnés', async () => {
  const c = await contexte();
  const id = '20261112T120000Z-abcd';
  for (const [mesh, carte] of [
    ['principal', 1],
    ['perso', 2],
  ] as const)
    c.db
      .prepare(
        `INSERT INTO avis_mesh (mesh, id, question, sieges, carte, jeton, date, etat, echeances)
      VALUES (?, ?, 'exemple', '[]', ?, 'exemple', '2026-11-12', 'confirmation', '{}')`,
      )
      .run(mesh, mesh === 'principal' ? id : '20261112T120000Z-abce', carte);
  const app = await serveur(c);
  expect((await app.inject('/api/avis-mesh')).json().demandes[0].carte).toBe(1);
  expect((await app.inject('/api/avis-mesh?mesh=perso')).json().demandes[0].carte).toBe(2);
  expect((await app.inject(`/api/avis-mesh/${id}?mesh=perso`)).statusCode).toBe(404);
  expect(c.registre.obtenir('perso').avis.ligne('20261112T120000Z-abce').carte).toBe(2);
});

test('mesh sans cell : 404 mesh désactivé ; nom inconnu : 404 mesh inconnu', async () => {
  const c = await contexte();
  const config = structuredClone(c.config);
  config.meshes.principal!.cell = '';
  const registre = new MeshRegistry({ config, db: c.db, store: c.store, log: () => undefined });
  nettoyages.push(() => registre.dispose());
  expect(() => registre.obtenir()).toThrow(
    expect.objectContaining({ status: 404, message: 'mesh désactivé' }),
  );
  expect(() => registre.obtenir('inconnu')).toThrow(
    expect.objectContaining({ status: 404, message: 'mesh inconnu' }),
  );
  const app = await serveur({ ...c, registre });
  for (const chemin of [
    '/api/mesh',
    '/api/board/projects',
    '/api/swarph/cells',
    '/api/avis-mesh',
  ]) {
    const reponse = await app.inject(chemin);
    expect(reponse.statusCode).toBe(404);
    expect(reponse.json()).toEqual({ error: 'mesh désactivé' });
  }
});

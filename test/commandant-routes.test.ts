import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Writable } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { migrate } from '../src/daemon/db.js';
import { EventStore } from '../src/daemon/events/store.js';
import { ServiceCommandant } from '../src/daemon/commandant/service.js';
import { registerCommandantRoutes } from '../src/daemon/routes/commandant.js';
import { notifierCommandant } from '../src/daemon/push/commandant.js';
import { RegistreAppareils } from '../src/daemon/host/appareils.js';
import { Appairages } from '../src/daemon/host/appairage.js';
import { COOKIE_APPAREIL, ouvrirServeurAppareils } from '../src/daemon/host/serveur.js';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import {
  creerPasserelleCommandant,
  IDENTIFIANT_COCKPIT_TEST,
} from './fixtures/passerelle-commandant.js';
import { startTestDaemon } from './helpers/daemon.js';

const nettoyages: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const f of nettoyages.splice(0).reverse()) await f();
});
async function preparer() {
  const home = mkdtempSync(join(tmpdir(), 'aid-commandant-routes-'));
  nettoyages.push(() => rmSync(home, { recursive: true, force: true }));
  const faux = await creerPasserelleCommandant();
  nettoyages.push(() => faux.fermer());
  const db = new Database(':memory:');
  migrate(db);
  nettoyages.push(() => db.close());
  const store = new EventStore(db);
  const registre = new RegistreAppareils(db);
  const { appareil, jeton } = registre.emettre({ nom: 'Téléphone test', identite: null });
  db.prepare('INSERT INTO push_abonnements VALUES (?, ?, ?, ?, ?)').run(
    appareil.id,
    'https://example.com/push',
    'cle',
    'auth',
    new Date().toISOString(),
  );
  const envoyer = vi.fn<typeof import('../src/daemon/push/envoi.js').envoyer>(async () => ({
    statut: 'ok' as const,
  }));
  const service = new ServiceCommandant({
    home,
    meshes: () => ({ principal: { gateway: faux.url, cell: 'cell-lab' } }),
    notifier: (id) =>
      notifierCommandant(id, {
        db,
        store,
        actif: () => true,
        envoi: () => ({
          clesVapid: {
            clePubliqueBase64url: () => '',
            jetonVapid: () => '',
            enTeteAuthorization: () => '',
          },
        }),
        envoyer,
      }),
  });
  nettoyages.push(() => service.arreter());
  const logs: string[] = [];
  const app = Fastify({
    logger: {
      stream: new Writable({
        write(morceau, _enc, cb) {
          logs.push(String(morceau));
          cb();
        },
      }),
    },
  });
  app.addHook('onRequest', async (req) => {
    req.principal =
      req.headers['x-admin-test'] === '1'
        ? { kind: 'admin', via: 'bearer' }
        : { kind: 'run', runId: 'run-test' };
  });
  registerCommandantRoutes(app, service, true);
  await app.ready();
  nettoyages.push(() => app.close());
  const injecter = (
    method: 'GET' | 'PUT' | 'DELETE' | 'POST',
    url: string,
    payload?: object,
    admin = true,
  ) =>
    app.inject({
      method,
      url,
      headers: admin ? { 'x-admin-test': '1' } : {},
      ...(payload ? { payload } : {}),
    });
  return { home, faux, db, store, registre, jeton, service, app, logs, envoyer, injecter };
}
it('les routes gardent le secret hors logs, événements, config, erreurs et réponses HTTP', async () => {
  const t = await preparer();
  const corps: string[] = [];
  writeFileSync(join(t.home, 'config.yaml'), 'mesh: {}\n');
  for (const rep of [
    await t.injecter('GET', '/api/commandant/principal'),
    await t.injecter('PUT', '/api/commandant/principal/identifiant', {
      identifiant: IDENTIFIANT_COCKPIT_TEST,
    }),
    await t.injecter('GET', '/api/commandant/principal'),
    await t.injecter('GET', '/api/commandant/principal/demandes/1235'),
    await t.injecter('GET', '/api/commandant/principal/identifiant'),
    await t.injecter('POST', '/api/commandant/principal/battement'),
    await t.injecter('PUT', '/api/commandant/principal/identifiant', {
      identifiant: IDENTIFIANT_COCKPIT_TEST + 'invalide',
    }),
    await t.injecter('GET', '/api/commandant/inconnu'),
  ])
    corps.push(rep.body);
  expect(t.envoyer).toHaveBeenCalledTimes(3);
  expect(
    t.envoyer.mock.calls.every(
      (appel) => JSON.stringify(appel[1]) === JSON.stringify({ c: (appel[1] as { c: number }).c }),
    ),
  ).toBe(true);
  expect(t.store.since(null).filter((e) => e.type === 'push.envoye')).toHaveLength(3);
  for (const http of [401, 403, 422, 500]) {
    t.faux.scenario.erreurListe = {
      http,
      corps: {
        error: IDENTIFIANT_COCKPIT_TEST,
        detail: [
          {
            loc: ['body', IDENTIFIANT_COCKPIT_TEST],
            msg: IDENTIFIANT_COCKPIT_TEST,
            input: IDENTIFIANT_COCKPIT_TEST,
          },
        ],
      },
    };
    await t.service.actualiser('principal');
    corps.push((await t.injecter('GET', '/api/commandant/principal')).body);
  }
  t.faux.scenario.erreurListe = null;
  t.faux.scenario.corpsListe = { [IDENTIFIANT_COCKPIT_TEST]: IDENTIFIANT_COCKPIT_TEST };
  await t.service.actualiser('principal');
  corps.push((await t.injecter('GET', '/api/commandant/principal')).body);
  // Une erreur locale d'écriture et une erreur du parseur JSON sont également neutralisées.
  rmSync(join(t.home, 'cockpit'), { recursive: true });
  writeFileSync(join(t.home, 'cockpit'), 'fichier');
  corps.push(
    (
      await t.injecter('PUT', '/api/commandant/principal/identifiant', {
        identifiant: IDENTIFIANT_COCKPIT_TEST,
      })
    ).body,
  );
  corps.push(
    (
      await t.app.inject({
        method: 'PUT',
        url: '/api/commandant/principal/identifiant',
        headers: { 'x-admin-test': '1', 'content-type': 'application/json' },
        payload: '{"identifiant":"' + IDENTIFIANT_COCKPIT_TEST,
      })
    ).body,
  );
  const traces = JSON.stringify({
    logs: t.logs,
    evenements: t.store.since(null),
    corps,
    config: readFileSync(join(t.home, 'config.yaml'), 'utf8'),
  });
  expect(traces.includes(IDENTIFIANT_COCKPIT_TEST)).toBe(false);
  expect(readFileSync(join(t.home, 'config.yaml'), 'utf8')).toBe('mesh: {}\n');
});
it('réserve PUT/DELETE au principal admin, valide le format et ne déclare pas de réponse', async () => {
  const t = await preparer();
  for (const method of ['PUT', 'DELETE'] as const)
    expect(
      (
        await t.injecter(
          method,
          '/api/commandant/principal/identifiant',
          { identifiant: IDENTIFIANT_COCKPIT_TEST },
          false,
        )
      ).statusCode,
    ).toBe(403);
  expect(
    (await t.injecter('PUT', '/api/commandant/principal/identifiant', { identifiant: 'invalide' }))
      .statusCode,
  ).toBe(400);
  const saisie = await t.injecter('PUT', '/api/commandant/principal/identifiant', {
    identifiant: IDENTIFIANT_COCKPIT_TEST,
  });
  expect(saisie.json()).toEqual({ etat: 'valide', saisie: expect.any(String) });
  expect(saisie.headers['cache-control']).toBe('no-store');
  expect((await t.injecter('GET', '/api/commandant/principal/demandes/invalide')).statusCode).toBe(
    400,
  );
  expect(
    (await t.injecter('POST', '/api/commandant/principal/demandes/1235/decide')).statusCode,
  ).toBe(404);
  expect((await t.injecter('DELETE', '/api/commandant/principal/identifiant')).statusCode).toBe(
    204,
  );
  expect((await t.injecter('GET', '/api/commandant/principal/identifiant')).json()).toEqual({
    etat: 'absent',
    saisie: null,
  });
});
it('le port appareils sert uniquement les quatre lectures ; PUT/DELETE de l’identifiant y sont absents', async () => {
  const t = await preparer();
  await t.service.saisir('principal', IDENTIFIANT_COCKPIT_TEST);
  const routes: string[] = [];
  const s = await ouvrirServeurAppareils({
    port: 0,
    interdits: [],
    nom: () => 'aid-e2e.ts.net',
    registre: t.registre,
    appairages: new Appairages(),
    webRoot: null,
    commandant: t.service,
    onRoute: (r) => {
      for (const method of Array.isArray(r.method) ? r.method : [r.method])
        if (method !== 'HEAD' && r.url.startsWith('/api/commandant/'))
          routes.push(`${method} ${r.url}`);
    },
  });
  if (!s.disponible) throw new Error(s.raison);
  nettoyages.push(() => s.app.close());
  const headers = {
    host: 'aid-e2e.ts.net',
    origin: 'https://aid-e2e.ts.net',
    cookie: `${COOKIE_APPAREIL}=${t.jeton}`,
    'x-aid-cockpit': '1',
  };
  for (const url of [
    '/api/commandant/principal',
    '/api/commandant/principal/demandes/1235',
    '/api/commandant/principal/identifiant',
  ])
    expect((await s.app.inject({ url, headers })).statusCode).toBe(200);
  expect(
    (await s.app.inject({ method: 'POST', url: '/api/commandant/principal/battement', headers }))
      .statusCode,
  ).toBe(204);
  for (const method of ['PUT', 'DELETE'] as const)
    expect(
      (
        await s.app.inject({
          method,
          url: '/api/commandant/principal/identifiant',
          headers,
          ...(method === 'PUT' ? { payload: { identifiant: IDENTIFIANT_COCKPIT_TEST } } : {}),
        })
      ).statusCode,
    ).toBe(404);
  expect(routes.sort()).toEqual(
    [
      'GET /api/commandant/:mesh',
      'GET /api/commandant/:mesh/demandes/:id',
      'GET /api/commandant/:mesh/identifiant',
      'POST /api/commandant/:mesh/battement',
    ].sort(),
  );
});
it('le vrai daemon raccorde le service aux routes du Mac et le ferme proprement', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aid-commandant-daemon-'));
  nettoyages.push(() => rmSync(home, { recursive: true, force: true }));
  const faux = await creerPasserelleCommandant();
  nettoyages.push(() => faux.fermer());
  const t = await startTestDaemon(home, {
    config: {
      mesh: {
        ...DEFAULT_CONFIG.mesh,
        bin: join(import.meta.dirname, 'fixtures/fake-swarph.sh'),
        cell: 'cell-lab',
        home,
        stateRoot: join(home, 'mesh-etat'),
        gateway: faux.url,
      },
    },
  });
  nettoyages.push(() => t.d.stop());
  const rep = await t.d.app.inject({
    method: 'PUT',
    url: '/api/commandant/principal/identifiant',
    headers: t.headers,
    payload: { identifiant: IDENTIFIANT_COCKPIT_TEST },
  });
  expect(rep.statusCode).toBe(200);
  const liste = await t.d.app.inject({ url: '/api/commandant/principal', headers: t.headers });
  expect(liste.json().lignes).toHaveLength(3);
});
it('le battement répond sans attendre une passerelle lente', async () => {
  const t = await preparer();
  await t.service.saisir('principal', IDENTIFIANT_COCKPIT_TEST);
  const avant = t.service.etat('principal').derniereLecture;
  t.faux.scenario.delaiMs = 200;
  const rep = await t.injecter('POST', '/api/commandant/principal/battement');
  expect(rep.statusCode).toBe(204);
  // La lecture lancée par le battement n'a pas encore reçu sa réponse distante.
  expect(t.service.etat('principal').derniereLecture).toBe(avant);
  await t.service.actualiser('principal');
});

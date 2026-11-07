import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, expect, test } from 'vitest';
import { buildSnapshot } from '../src/daemon/state/snapshot.js';
import { openDb } from '../src/daemon/db.js';
import { parseConfig } from '../src/daemon/config.js';
import { Appairages } from '../src/daemon/host/appairage.js';
import { RegistreAppareils, DUREE_ACCES_MS } from '../src/daemon/host/appareils.js';
import { ouvrirServeurAppareils, COOKIE_APPAREIL } from '../src/daemon/host/serveur.js';
import { abonnementsActifs } from '../src/daemon/push/abonnements.js';
import { startTestDaemon } from './helpers/daemon.js';

const nettoyages: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of nettoyages.reverse()) await f();
  nettoyages.length = 0;
});
const endpoint = 'https://web.push.apple.com/marqueur-confidentiel';
const corps = {
  endpoint,
  keys: {
    p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'),
    auth: Buffer.alloc(16, 2).toString('base64url'),
  },
};
async function preparer() {
  const dossier = mkdtempSync(join(tmpdir(), 'aid-push-'));
  const db = openDb(join(dossier, 'state.db'));
  nettoyages.push(() => {
    db.close();
    rmSync(dossier, { recursive: true, force: true });
  });
  let instant = Date.now();
  let actif = true;
  let journal = '';
  const registre = new RegistreAppareils(db, () => instant);
  const acces = registre.emettre({ nom: 'Test', identite: null });
  const s = await ouvrirServeurAppareils({
    port: 0,
    interdits: [],
    nom: () => 'aid-e2e.ts.net',
    registre,
    appairages: new Appairages(),
    webRoot: null,
    now: () => instant,
    push: { db, dossierEtat: dossier, actif: () => actif },
    etat: () =>
      buildSnapshot(db, { status: async () => ({ state: 'unavailable' }) } as unknown as Parameters<
        typeof buildSnapshot
      >[1]),
    logStream: new Writable({
      write(chunk, _enc, suite) {
        journal += String(chunk);
        suite();
      },
    }),
  });
  if (!s.disponible) throw new Error(s.raison);
  nettoyages.push(() => s.app.close());
  const envoyer = (
    method: 'GET' | 'POST' | 'DELETE',
    url = '/api/appareils/moi/push',
    payload?: unknown,
  ) =>
    s.app.inject({
      method,
      url,
      payload: payload as never,
      headers: {
        host: 'aid-e2e.ts.net',
        origin: 'https://aid-e2e.ts.net',
        'sec-fetch-site': 'same-origin',
        cookie: `${COOKIE_APPAREIL}=${acces.jeton}`,
      },
    });
  return {
    db,
    registre,
    acces,
    envoyer,
    couper: () => {
      actif = false;
    },
    avancer: () => {
      instant += DUREE_ACCES_MS;
    },
    lire: () => abonnementsActifs(db, instant),
    journal: () => journal,
  };
}

test('corps strict, clés et endpoint refusés sans fuite dans le journal', async () => {
  const t = await preparer();
  for (const payload of [
    { ...corps, extra: true },
    { ...corps, keys: { ...corps.keys, extra: true } },
    { ...corps, keys: { ...corps.keys, p256dh: Buffer.alloc(64).toString('base64url') } },
    { ...corps, keys: { ...corps.keys, p256dh: Buffer.alloc(65, 1).toString('base64url') } },
    { ...corps, keys: { ...corps.keys, auth: Buffer.alloc(15).toString('base64url') } },
    { ...corps, endpoint: 'x'.repeat(2049) },
    { ...corps, keys: { ...corps.keys, auth: 42 } },
  ]) {
    const r = await t.envoyer('POST', undefined, payload);
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain(endpoint);
  }
  const r = await t.envoyer('POST', undefined, {
    ...corps,
    endpoint: endpoint.replace('https:', 'http:'),
  });
  expect(r.statusCode).toBe(400);
  expect(r.json()).toEqual({ raison: 'endpoint' });
  expect(t.journal()).not.toContain(endpoint);
});

test('remplacement, état sans endpoint, désabonnement et réglage coupé', async () => {
  const t = await preparer();
  expect((await t.envoyer('GET', '/api/appareils/push/cle')).json().cle).toHaveLength(87);
  for (let i = 0; i < 2; i++) {
    const r = await t.envoyer('POST', undefined, corps);
    expect(r.statusCode).toBe(204);
    expect(r.body).toBe('');
  }
  expect(t.lire()).toHaveLength(1);
  const moi = await t.envoyer('GET', '/api/appareils/moi');
  expect(moi.json().push).toEqual({ actifSurLeMac: true, abonne: true });
  for (const url of ['/api/appareils/moi', '/api/appareils', '/api/state']) {
    expect((await t.envoyer('GET', url)).body).not.toContain(endpoint);
  }
  expect((await t.envoyer('DELETE')).statusCode).toBe(204);
  expect(t.lire()).toEqual([]);
  t.couper();
  for (const [method, url] of [
    ['GET', '/api/appareils/push/cle'],
    ['POST', '/api/appareils/moi/push'],
    ['DELETE', '/api/appareils/moi/push'],
  ] as const) {
    const r = await t.envoyer(method, url, method === 'POST' ? corps : undefined);
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ raison: 'push_coupe' });
  }
  expect(t.journal()).not.toContain(endpoint);
});

test.each(['revocation', 'tous', 'echeance', 'suppression'])('effacement : %s', async (cas) => {
  const t = await preparer();
  expect(t.db.pragma('foreign_keys', { simple: true })).toBe(1);
  await t.envoyer('POST', undefined, corps);
  if (cas === 'revocation') t.registre.revoquer(t.acces.appareil.id);
  if (cas === 'tous') t.registre.toutRevoquer();
  if (cas === 'echeance') t.avancer();
  if (cas === 'suppression') t.db.prepare('DELETE FROM appareils').run();
  expect(t.lire()).toEqual([]);
  expect(t.db.prepare('SELECT * FROM push_abonnements').all()).toEqual([]);
});

test('interrupteur Mac : défaut, clés, panneau, effacement et persistance', async () => {
  expect(parseConfig('modeHost:\n  actif: true\n').modeHost.push).toBe(false);
  const t = await startTestDaemon();
  nettoyages.push(() => rmSync(t.home, { recursive: true, force: true }));
  nettoyages.push(() => t.d.stop());
  const basculer = (actif: boolean) =>
    t.d.app.inject({
      method: 'PUT',
      url: '/api/host/push',
      headers: t.headers,
      payload: { actif },
    });
  expect((await t.d.app.inject({ url: '/api/host', headers: t.headers })).json().push).toBe(false);
  expect(existsSync(join(t.home, 'vapid.pem'))).toBe(false);
  expect((await basculer(true)).json().push).toBe(true);
  expect(existsSync(join(t.home, 'vapid.pem'))).toBe(true);
  const a = new RegistreAppareils(t.db).emettre({ nom: 'Test', identite: null });
  t.db
    .prepare('INSERT INTO push_abonnements VALUES (?, ?, ?, ?, ?)')
    .run(a.appareil.id, endpoint, corps.keys.p256dh, corps.keys.auth, new Date().toISOString());
  const panneau = await t.d.app.inject({ url: '/api/host', headers: t.headers });
  expect(panneau.json().abonnements).toBe(1);
  const liste = await t.d.app.inject({ url: '/api/host/appareils', headers: t.headers });
  expect(liste.json()).toEqual([expect.objectContaining({ id: a.appareil.id, push: true })]);
  expect(liste.body).not.toContain(endpoint);

  for (const url of ['/api/host', '/api/state'])
    expect((await t.d.app.inject({ url, headers: t.headers })).body).not.toContain(endpoint);
  expect((await basculer(false)).json()).toMatchObject({ push: false, abonnements: 0 });
  expect((await t.d.app.inject({ url: '/api/host/appareils', headers: t.headers })).json()).toEqual(
    [expect.objectContaining({ id: a.appareil.id, push: false })],
  );

  expect(t.db.prepare('SELECT * FROM push_abonnements').all()).toEqual([]);
});

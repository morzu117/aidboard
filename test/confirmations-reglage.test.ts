import Database from 'better-sqlite3';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { migrate, type Db } from '../src/daemon/db.js';
import { creerReglage } from '../src/daemon/confirmations/reglage.js';
import { issueRunToken } from '../src/daemon/security.js';
import { RegistreAppareils } from '../src/daemon/host/appareils.js';
import { COOKIE_APPAREIL } from '../src/daemon/host/serveur.js';
import { startTestDaemon } from './helpers/daemon.js';

const nettoyages: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of nettoyages.reverse()) await f();
  nettoyages.length = 0;
});
function base() {
  const db = new Database(':memory:');
  nettoyages.push(() => db.close());
  migrate(db);
  return db;
}

test('migration additive : anciennes demandes, valeurs initiales et contraintes', () => {
  const db: Db = new Database(':memory:');
  nettoyages.push(() => db.close());
  // Applique la base antérieure avant de confier la reprise au migrateur.
  for (const fichier of readdirSync('migrations')
    .filter((f) => /^\d{3}_.*\.sql$/.test(f) && f < '024')
    .sort()) {
    db.exec(readFileSync(join('migrations', fichier), 'utf8'));
  }
  db.pragma('user_version = 23');
  db.prepare(
    `INSERT INTO pda_demandes
    (id, action, sujet, h_demande, numero, echeance, etat, cree_a)
    VALUES ('ancienne', 'essai', 'test', 'hash', '1234', 100, 'ouverte', 'date')`,
  ).run();
  migrate(db);
  expect(db.pragma('user_version', { simple: true })).toBe(25);
  const reglage = creerReglage(db);
  expect(reglage.lire()).toEqual(
    ['merge', 'push', 'nettoyage', 'projet.retirer', 'mesh.ecrire'].map((action) => ({
      action,
      actif: true,
      modifieA: null,
    })),
  );
  expect(reglage.lireArmement()).toEqual({ arme: false, armeA: null, desarmeA: null });
  expect(db.prepare('SELECT * FROM pda_demandes').get()).toMatchObject({
    id: 'ancienne',
    etat: 'ouverte',
    classe: null,
    params: null,
    resume: null,
    numero_mac: null,
    resultat: null,
    raison: null,
  });
  db.prepare("UPDATE pda_demandes SET etat = 'expiree', resultat = 'annulee'").run();
  expect(db.prepare('SELECT etat, resultat FROM pda_demandes').get()).toEqual({
    etat: 'expiree',
    resultat: 'annulee',
  });
  expect(() => db.exec("UPDATE pda_demandes SET resultat = 'inconnu'")).toThrow(/CHECK/);
  expect(() => db.exec('UPDATE confirmations_reglage SET actif = 2')).toThrow(/CHECK/);
  expect(() => db.exec('UPDATE confirmations_armement SET arme = 2')).toThrow(/CHECK/);
  expect(() => db.exec('INSERT INTO confirmations_armement (id, arme) VALUES (2, 0)')).toThrow(
    /CHECK/,
  );
  expect(() =>
    db.exec("INSERT INTO confirmations_reglage (action, actif) VALUES ('inconnue', 0)"),
  ).toThrow(/CHECK/);
  migrate(db);
  expect(reglage.lire()).toHaveLength(5);
});

test('plancher toujours et essai, réglage immédiat, armement idempotent et réarmement', () => {
  const db = base();
  const reglage = creerReglage(db);
  for (const action of ['appairage', 'pda.activer', 'host.option', 'reglage', 'desarmement']) {
    expect(() =>
      db.prepare('INSERT INTO confirmations_reglage (action, actif) VALUES (?, 0)').run(action),
    ).toThrow(/CHECK/);
    expect(reglage.exige(action)).toBe(true);
  }
  expect(reglage.exige('essai')).toBe(true);
  expect(reglage.exige('inconnue')).toBe(false);
  vi.spyOn(Date, 'now').mockReturnValue(100);
  reglage.couperConfirme('merge');
  expect(reglage.exige('merge')).toBe(false);
  reglage.rallumer('merge');
  expect(reglage.exige('merge')).toBe(true);
  expect(reglage.lire()[0]).toMatchObject({ modifieA: 100 });
  expect(() => reglage.rallumer('appairage')).toThrow('action inconnue');
  reglage.armer();
  vi.mocked(Date.now).mockReturnValue(200);
  reglage.armer();
  expect(reglage.arme()).toBe(true);
  expect(reglage.lireArmement()).toEqual({ arme: true, armeA: 100, desarmeA: null });
  reglage.desarmerConfirme();
  expect(reglage.arme()).toBe(false);
  expect(reglage.lireArmement()).toEqual({ arme: false, armeA: 100, desarmeA: 200 });
  vi.mocked(Date.now).mockReturnValue(300);
  reglage.armer();
  expect(reglage.lireArmement()).toEqual({ arme: true, armeA: 300, desarmeA: 200 });
});

test('routes admin du Mac seulement, rallumage immédiat et coupure différée', async () => {
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
  nettoyages.push(async () => {
    await t.d.stop();
    rmSync(t.home, { recursive: true, force: true });
  });
  const url = '/api/confirmations/reglage';
  const reglage = creerReglage(t.db);
  expect((await t.d.app.inject({ method: 'GET', url, headers: t.headers })).json()).toEqual({
    actions: reglage.lire(),
    bandeau: null,
    arme: false,
    armeA: null,
    desarmeA: null,
  });
  const nonAdmin = {
    host: t.headers.host!,
    authorization: `Bearer ${issueRunToken(t.d.auth, 'test')}`,
  };
  for (const method of ['GET', 'PUT'] as const) {
    expect((await t.d.app.inject({ method, url, headers: nonAdmin })).statusCode).toBe(403);
  }
  reglage.couperConfirme('merge');
  expect(
    (
      await t.d.app.inject({
        method: 'PUT',
        url,
        headers: t.headers,
        payload: { action: 'merge', actif: true },
      })
    ).statusCode,
  ).toBe(200);
  expect(reglage.exige('merge')).toBe(true);
  const refus = await t.d.app.inject({
    method: 'PUT',
    url,
    headers: t.headers,
    payload: { action: 'merge', actif: false },
  });
  expect(refus.statusCode).toBe(200);
  expect(refus.json()).toEqual({ actions: reglage.lire(), ...reglage.lireArmement() });
  expect(reglage.exige('merge')).toBe(false);
  for (const payload of [
    { action: 'inconnue', actif: true },
    { action: 'reglage', actif: false },
    { action: 'merge', actif: 1 },
    { action: 'merge', actif: true, extra: true },
  ]) {
    expect(
      (await t.d.app.inject({ method: 'PUT', url, headers: t.headers, payload })).statusCode,
    ).toBe(400);
  }
  await t.d.app.inject({
    method: 'PUT',
    url: '/api/host',
    headers: t.headers,
    payload: { actif: true },
  });
  const acces = new RegistreAppareils(t.db).emettre({ nom: 'Test', identite: null });
  const appareils = t.d.modeHost.instance()!;
  for (const method of ['GET', 'PUT'] as const) {
    expect(
      (
        await appareils.inject({
          method,
          url,
          headers: {
            host: 'aid-e2e.ts.net',
            origin: 'https://aid-e2e.ts.net',
            'sec-fetch-site': 'same-origin',
            cookie: `${COOKIE_APPAREIL}=${acces.jeton}`,
          },
        })
      ).statusCode,
    ).toBe(404);
  }
});

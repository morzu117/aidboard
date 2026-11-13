import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { DUREE_CODE_MS, PLAFOND_RECLAMATIONS } from '../src/daemon/host/appairage.js';
import { COOKIE_APPAREIL, COOKIE_DEMANDE, CORPS_INCONNU } from '../src/daemon/host/serveur.js';
import type { TailscaleExec } from '../src/daemon/mesh/tailscale.js';
import { issueRunToken } from '../src/daemon/security.js';
import { startTestDaemon, type TestDaemon } from './helpers/daemon.js';

// Chantier 31 (D176, D179) : l'appairage de bout en bout, sur un vrai daemon. Les deux ports.

const NOM = 'mac-synthetique.exemple.ts.net';
let t: TestDaemon | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await t?.d.stop();
  t = null;
});

const tailnet: TailscaleExec = async (_bin, args) =>
  args[0] === 'status'
    ? {
        stdout: JSON.stringify({
          BackendState: 'Running',
          Self: { DNSName: `${NOM}.`, UserID: 1 },
          User: { '1': { LoginName: 'utilisateur@exemple' } },
        }),
        code: null,
      }
    : { stdout: '', code: null };

async function demarrer(extra: { webRoot?: string } = {}) {
  t = await startTestDaemon(undefined, { tailscaleExec: tailnet, ...extra });
  await t.d.app.inject({
    method: 'PUT',
    url: '/api/host',
    headers: t.headers,
    payload: { actif: true },
  });
  return t;
}

const mac = (method: 'GET' | 'POST', url: string, payload?: object) =>
  t!.d.app.inject({ method, url, headers: t!.headers, ...(payload && { payload }) });

const appareil = (
  method: 'GET' | 'POST',
  url: string,
  opts: { payload?: object; headers?: Record<string, string> } = {},
) =>
  t!.d.modeHost.instance()!.inject({
    method,
    url,
    headers: {
      host: NOM,
      origin: `https://${NOM}`,
      'sec-fetch-site': 'same-origin',
      ...opts.headers,
    },
    ...(opts.payload && { payload: opts.payload }),
  });

const creer = async () =>
  (await mac('POST', '/api/host/appairages')).json<{
    demandeId: string;
    code: string;
    url: string;
  }>();

const reclamer = (code: string, headers: Record<string, string> = {}) =>
  appareil('POST', '/appairage/reclamer', { payload: { code, nom: 'Téléphone' }, headers });

function cookie(
  r: { cookies: Array<{ name: string; value: string }> },
  nom: string,
): string | undefined {
  return r.cookies.find((c) => c.name === nom)?.value;
}

test('31.6 (D176) : le parcours complet, cookie d’appareil posé une seule fois', async () => {
  await demarrer();
  const d = await creer();
  expect(d.url).toBe(`https://${NOM}/appairer#${d.code}`);
  const r = await reclamer(d.code);
  expect(r.statusCode).toBe(200);
  const { demandeId, codeCourt } = r.json<{ demandeId: string; codeCourt: string }>();
  expect(demandeId).toBe(d.demandeId);
  const cd = r.cookies.find((c) => c.name === COOKIE_DEMANDE)!;
  expect(cd).toMatchObject({
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: 300,
  });
  expect(cd.domain).toBeUndefined();
  const demande = { cookie: `${COOKIE_DEMANDE}=${cd.value}` };

  // le Mac voit le code court et le nom avant d'approuver ; l'identité, non vérifiable (D179)
  const vue = (await mac('GET', '/api/host/appairage')).json();
  expect(vue).toMatchObject({
    demande: { etat: 'reclamee', codeCourt, nom: 'Téléphone', identite: null },
    identiteVerifiable: false,
  });
  expect(JSON.stringify(vue)).not.toContain(d.code);
  expect(JSON.stringify(vue)).not.toContain(cd.value);

  const attente = await appareil('GET', `/appairage/${demandeId}`, { headers: demande });
  expect(attente.json()).toEqual({ etat: 'attente' });
  expect(attente.headers['set-cookie']).toBeUndefined();

  // sans identité Tailscale : 409, puis la case
  const refuse = await mac('POST', `/api/host/appairages/${demandeId}/approuver`, {});
  expect([refuse.statusCode, refuse.json().error]).toEqual([409, 'identite-absente']);
  const ok = await mac('POST', `/api/host/appairages/${demandeId}/approuver`, {
    sansIdentite: true,
  });
  expect(ok.statusCode).toBe(200);

  const pris = await appareil('GET', `/appairage/${demandeId}`, { headers: demande });
  expect(pris.json()).toEqual({ etat: 'approuve' });
  expect(pris.headers['cache-control']).toBe('no-store');
  const ca = pris.cookies.find((c) => c.name === COOKIE_APPAREIL)!;
  expect(ca).toMatchObject({
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: 8 * 3600,
  });
  // le cookie de demande est effacé à la pose du cookie d'appareil
  const efface = pris.cookies.find((c) => c.name === COOKIE_DEMANDE)!;
  expect(efface.value).toBe('');
  expect(efface.maxAge === 0 || Date.parse(String(efface.expires)) <= Date.now()).toBe(true);

  const moi = await appareil('GET', '/api/appareils/moi', {
    headers: { cookie: `${COOKIE_APPAREIL}=${ca.value}` },
  });
  expect(moi.statusCode).toBe(200);
  expect(moi.json().nom).toBe('Téléphone');

  // relue : consommée, sans aucun cookie
  const encore = await appareil('GET', `/appairage/${demandeId}`, { headers: demande });
  expect(encore.json()).toEqual({ etat: 'consomme' });
  expect(encore.headers['set-cookie']).toBeUndefined();
  // et le code ne sert plus
  const reutilise = await reclamer(d.code);
  expect([reutilise.statusCode, reutilise.json()]).toEqual([404, CORPS_INCONNU]);
});

test('31.6 (D179) : l’identité vue par Serve est affichée et dispense de la case, sans être crue', async () => {
  await demarrer();
  const d = await creer();
  const r = await reclamer(d.code, { 'tailscale-user-login': 'utilisateur@exemple' });
  const { demandeId } = r.json<{ demandeId: string }>();
  expect((await mac('GET', '/api/host/appairage')).json()).toMatchObject({
    demande: { identite: 'utilisateur@exemple' },
    identiteVerifiable: false,
  });
  expect((await mac('POST', `/api/host/appairages/${demandeId}/approuver`, {})).statusCode).toBe(
    200,
  );
});

test('31.6 (lab M4) : une seconde réclamation annule, et le Mac le sait', async () => {
  await demarrer();
  const d = await creer();
  expect((await reclamer(d.code)).statusCode).toBe(200);
  const second = await reclamer(d.code);
  expect([second.statusCode, second.json()]).toEqual([404, CORPS_INCONNU]);
  expect(second.headers['set-cookie']).toBeUndefined();
  expect((await mac('GET', '/api/host/appairage')).json().demande).toMatchObject({
    etat: 'annulee',
    raison: 'deux-reclamations',
  });
  expect(
    (await mac('POST', `/api/host/appairages/${d.demandeId}/approuver`, { sansIdentite: true }))
      .statusCode,
  ).toBe(404);
});

test('31.6 (lab M4, D179) : plafond global, 429, quelle que soit l’adresse annoncée', async () => {
  await demarrer();
  await creer();
  for (let i = 0; i < PLAFOND_RECLAMATIONS; i++) {
    expect((await reclamer('faux', { 'x-forwarded-for': `203.0.113.${i}` })).statusCode).toBe(404);
  }
  const r = await reclamer('faux', { 'x-forwarded-for': '198.51.100.7' });
  expect(r.statusCode).toBe(429);
});

test('31.6 (D176) : un code expiré, 404 même corps', async () => {
  await demarrer();
  const d = await creer();
  const maintenant = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(maintenant + DUREE_CODE_MS);
  const r = await reclamer(d.code);
  expect([r.statusCode, r.json()]).toEqual([404, CORPS_INCONNU]);
});

test('31.6 (DM 91366) : un demandeId juste sans son cookie, ou avec un autre, rend 404, même corps', async () => {
  await demarrer();
  const d = await creer();
  const r = await reclamer(d.code);
  const { demandeId } = r.json<{ demandeId: string }>();
  await mac('POST', `/api/host/appairages/${demandeId}/approuver`, { sansIdentite: true });
  const etranger = await appareil('GET', '/appairage/id-synthetique-etranger', {
    headers: { cookie: `${COOKIE_DEMANDE}=${cookie(r, COOKIE_DEMANDE)}` },
  });
  expect([etranger.statusCode, etranger.json()]).toEqual([404, CORPS_INCONNU]);
  const essais: Array<Record<string, string>> = [
    {},
    { cookie: `${COOKIE_DEMANDE}=autre-jeton-synthetique` },
  ];
  for (const headers of essais) {
    const x = await appareil('GET', `/appairage/${demandeId}`, { headers });
    expect(x.statusCode).toBe(404);
    expect(x.body).toBe(etranger.body);
    expect(x.headers['set-cookie']).toBeUndefined();
  }
  // et l'appareil légitime prend toujours son accès
  const ok = await appareil('GET', `/appairage/${demandeId}`, {
    headers: { cookie: `${COOKIE_DEMANDE}=${cookie(r, COOKIE_DEMANDE)}` },
  });
  expect(ok.json()).toEqual({ etat: 'approuve' });
});

test('31.6 (D176) : approuver, créer ou voir depuis le port des appareils est impossible', async () => {
  await demarrer();
  const d = await creer();
  const r = await reclamer(d.code);
  const { demandeId } = r.json<{ demandeId: string }>();
  await mac('POST', `/api/host/appairages/${demandeId}/approuver`, { sansIdentite: true });
  const pris = await appareil('GET', `/appairage/${demandeId}`, {
    headers: { cookie: `${COOKIE_DEMANDE}=${cookie(r, COOKIE_DEMANDE)}` },
  });
  const ca = { cookie: `${COOKIE_APPAREIL}=${cookie(pris, COOKIE_APPAREIL)}` };
  const d2 = await creer();
  await reclamer(d2.code, { 'x-forwarded-for': '203.0.113.50' });
  for (const [method, url] of [
    ['POST', `/api/host/appairages/${d2.demandeId}/approuver`],
    ['POST', '/api/host/appairages'],
    ['GET', '/api/host/appairage'],
    ['POST', `/appairage/${d2.demandeId}/approuver`],
  ] as const) {
    const x = await appareil(method, url, { headers: ca, payload: { sansIdentite: true } });
    expect(x.statusCode, url).toBe(404);
  }
  expect((await mac('GET', '/api/host/appairage')).json().demande.etat).toBe('reclamee');
});

test('31.6 (D176) : réclamer sans Origin, ou depuis un autre site, 403', async () => {
  await demarrer();
  const d = await creer();
  const sans = await t!.d.modeHost.instance()!.inject({
    method: 'POST',
    url: '/appairage/reclamer',
    headers: { host: NOM },
    payload: { code: d.code },
  });
  expect(sans.statusCode).toBe(403);
  expect((await reclamer(d.code, { 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
  // la demande n'a pas bougé
  expect((await reclamer(d.code)).statusCode).toBe(200);
});

test('31.6 (D176) : créer une demande, admin seulement et mode host disponible', async () => {
  t = await startTestDaemon(undefined, { tailscaleExec: tailnet });
  const eteint = await mac('POST', '/api/host/appairages');
  expect([eteint.statusCode, eteint.json().error]).toEqual([409, 'mode host éteint']);
  await t.d.app.inject({
    method: 'PUT',
    url: '/api/host',
    headers: t.headers,
    payload: { actif: true },
  });
  const run = issueRunToken(t.d.auth, 'run-synthetique');
  for (const url of [
    '/api/host/appairages',
    '/api/host/appairages/x/approuver',
    '/api/host/appairages/x/refuser',
  ]) {
    const r = await t.d.app.inject({
      method: 'POST',
      url,
      headers: { host: t.headers.host!, authorization: `Bearer ${run}` },
    });
    expect(r.statusCode, url).toBe(403);
  }
  // refuser annule ; éteindre aussi
  const d = await creer();
  expect((await mac('POST', `/api/host/appairages/${d.demandeId}/refuser`)).statusCode).toBe(200);
  expect((await mac('POST', `/api/host/appairages/${d.demandeId}/refuser`)).statusCode).toBe(404);
  const d2 = await creer();
  await t.d.app.inject({
    method: 'PUT',
    url: '/api/host',
    headers: t.headers,
    payload: { actif: false },
  });
  expect((await mac('GET', '/api/host/appairage')).json().demande).toMatchObject({
    id: d2.demandeId,
    raison: 'coupee',
  });
});

test('31.6 (D176) : /appairer, la page de la SPA, en no-referrer et sans cookie', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aid-web-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><div id="root"></div>');
  await demarrer({ webRoot: root });
  const r = await appareil('GET', '/appairer');
  expect(r.statusCode).toBe(200);
  expect(r.headers['referrer-policy']).toBe('no-referrer');
  expect(r.headers['set-cookie']).toBeUndefined();
});

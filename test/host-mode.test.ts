import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { loadConfig } from '../src/daemon/config.js';
import { RegistreAppareils } from '../src/daemon/host/appareils.js';
import { COOKIE_APPAREIL } from '../src/daemon/host/serveur.js';
import type { TailscaleExec } from '../src/daemon/mesh/tailscale.js';
import { resolvePaths } from '../src/daemon/paths.js';
import { issueRunToken, SESSION_COOKIE } from '../src/daemon/security.js';
import type { EtatModeHostDaemon, EtatPourAppareil } from '../src/shared/host.js';
import WebSocket from 'ws';
import { seedTopic, startTestDaemon, type TestDaemon } from './helpers/daemon.js';

// Chantier 31 (D171, D172) : le mode host sur un vrai daemon. L'interrupteur du Mac, et la
// frontière entre les deux ports dans les deux sens.

const NOM = 'mac-synthetique.exemple.ts.net';
let t: TestDaemon | null = null;
afterEach(async () => {
  await t?.d.stop();
  t = null;
});

function tailnet(nom: { v: string | null } = { v: NOM }): TailscaleExec {
  return async (_bin, args) =>
    args[0] === 'status'
      ? {
          stdout: JSON.stringify({
            BackendState: 'Running',
            Self: { ...(nom.v && { DNSName: `${nom.v}.` }), UserID: 1 },
            User: { '1': { LoginName: 'utilisateur@exemple' } },
          }),
          code: null,
        }
      : { stdout: '', code: null };
}

function build(): string {
  const root = mkdtempSync(join(tmpdir(), 'aid-web-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><div id="root"></div>');
  return root;
}

const basculer = (actif: unknown) =>
  t!.d.app.inject({ method: 'PUT', url: '/api/host', headers: t!.headers, payload: { actif } });

const surAppareil = (headers: Record<string, string>, url = '/api/appareils/moi') =>
  t!.d.modeHost.instance()!.inject({
    url,
    headers: { host: NOM, 'sec-fetch-site': 'same-origin', ...headers },
  });

test('31.5 (D172) : PUT /api/host allume le port des appareils, sans redémarrer, et l’écrit', async () => {
  t = await startTestDaemon(undefined, { tailscaleExec: tailnet() });
  expect(t.d.modeHost.instance()).toBeNull();
  const r = await basculer(true);
  expect(r.statusCode).toBe(200);
  expect(r.headers['cache-control']).toBe('no-store');
  const e = r.json<EtatModeHostDaemon>();
  expect(e).toMatchObject({ actif: true, disponible: true, raison: null });
  expect(e.port).toBe(t.d.modeHost.portOuvert());
  expect(e.port).not.toBe(t.d.port);
  expect(loadConfig(resolvePaths(t.home)).modeHost.actif).toBe(true);
  // le même daemon répond toujours sur son port
  expect((await t.d.app.inject({ url: '/api/host', headers: t.headers })).statusCode).toBe(200);
  // et le port des appareils écoute vraiment
  expect(t.d.modeHost.instance()!.server.listening).toBe(true);
  // deux fois : idempotent, une seule instance
  const app = t.d.modeHost.instance();
  await basculer(true);
  expect(t.d.modeHost.instance()).toBe(app);
});

test('31.5 (D172, D177) : l’éteindre coupe tous les accès, ferme le port et l’écrit', async () => {
  t = await startTestDaemon(undefined, { tailscaleExec: tailnet() });
  await basculer(true);
  const registre = new RegistreAppareils(t.db);
  const { jeton } = registre.emettre({ nom: 'Téléphone', identite: null });
  expect((await surAppareil({ cookie: `${COOKIE_APPAREIL}=${jeton}` })).statusCode).toBe(200);
  const r = await basculer(false);
  expect(r.json<EtatModeHostDaemon>()).toMatchObject({
    actif: false,
    disponible: false,
    raison: 'mode host éteint',
  });
  expect(t.d.modeHost.instance()).toBeNull();
  expect(registre.authentifier(jeton)).toEqual({ ok: false, raison: 'revoque' });
  expect(loadConfig(resolvePaths(t.home)).modeHost.actif).toBe(false);
  // rallumé : l'ancien accès reste coupé
  await basculer(true);
  expect((await surAppareil({ cookie: `${COOKIE_APPAREIL}=${jeton}` })).statusCode).toBe(401);
});

test('31.5 (D172) : PUT /api/host, admin seulement, actif booléen', async () => {
  t = await startTestDaemon(undefined, { tailscaleExec: tailnet() });
  for (const actif of ['true', 1, null, undefined]) {
    expect((await basculer(actif)).statusCode, String(actif)).toBe(400);
  }
  const jeton = issueRunToken(t.d.auth, 'run-synthetique');
  const run = await t.d.app.inject({
    method: 'PUT',
    url: '/api/host',
    headers: { host: t.headers.host!, authorization: `Bearer ${jeton}` },
    payload: { actif: true },
  });
  expect(run.statusCode).toBe(403);
  expect(t.d.modeHost.instance()).toBeNull();
});

test('31.5 (D172) : un config.yaml qui ne passerait plus n’est pas écrit, et rien ne s’allume', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aid-d-'));
  t = await startTestDaemon(home, { tailscaleExec: tailnet() });
  writeFileSync(resolvePaths(home).config, 'modeHost: [1, 2]\n');
  const r = await basculer(true);
  expect(r.statusCode).toBe(409);
  expect(t.d.modeHost.instance()).toBeNull();
  expect(readFileSync(resolvePaths(home).config, 'utf8')).toBe('modeHost: [1, 2]\n');
});

test('31.5 (D171) : actif en config, le port s’ouvre au démarrage ; l’arrêt le ferme sans couper', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aid-d-'));
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.yaml'), 'modeHost:\n  actif: true\n');
  t = await startTestDaemon(home, { tailscaleExec: tailnet() });
  const app = t.d.modeHost.instance();
  expect(app).not.toBeNull();
  const { jeton } = new RegistreAppareils(t.db).emettre({ nom: 'A', identite: null });
  await t.d.stop();
  t = null;
  expect(app!.server.listening).toBe(false);
  t = await startTestDaemon(home, { tailscaleExec: tailnet() });
  expect((await surAppareil({ cookie: `${COOKIE_APPAREIL}=${jeton}` })).statusCode).toBe(200);
});

test('31.5 (D171) : ni le jeton admin, ni le cookie du Mac, ni un jeton de run n’ouvrent le port des appareils', async () => {
  t = await startTestDaemon(undefined, { tailscaleExec: tailnet() });
  await basculer(true);
  const run = issueRunToken(t.d.auth, 'run-synthetique');
  const essais: Array<Record<string, string>> = [
    { authorization: `Bearer ${t.d.auth.adminToken}` },
    { cookie: `${SESSION_COOKIE}=${t.d.auth.sessionToken}` },
    { authorization: `Bearer ${run}` },
    // le jeton admin glissé dans le cookie d'appareil
    { cookie: `${COOKIE_APPAREIL}=${t.d.auth.adminToken}` },
    { cookie: `${COOKIE_APPAREIL}=${t.d.auth.sessionToken}` },
  ];
  for (const headers of essais) {
    const r = await surAppareil({ ...headers, 'x-aid-cockpit': '1' });
    expect(r.statusCode, JSON.stringify(headers)).toBe(401);
  }
  // et les routes du Mac n'y existent pas, même avec le jeton admin
  const etat = await surAppareil({ authorization: `Bearer ${t.d.auth.adminToken}` }, '/api/state');
  expect(etat.statusCode).toBe(401);
});

test('31.5 : un cookie d’appareil valide n’ouvre rien sur le port du Mac', async () => {
  t = await startTestDaemon(undefined, { tailscaleExec: tailnet() });
  await basculer(true);
  const { jeton } = new RegistreAppareils(t.db).emettre({ nom: 'A', identite: null });
  for (const url of ['/api/state', '/api/host', '/api/appareils/moi']) {
    const r = await t.d.app.inject({
      url,
      headers: {
        host: t.headers.host!,
        cookie: `${COOKIE_APPAREIL}=${jeton}`,
        'sec-fetch-site': 'same-origin',
        'x-aid-cockpit': '1',
      },
    });
    expect(r.statusCode, url).toBe(401);
  }
});

test('31.5 (lab DM 91366) : les deux ports servent le même index.html, sans rien du Mac', async () => {
  const root = build();
  t = await startTestDaemon(undefined, { tailscaleExec: tailnet(), webRoot: root });
  await basculer(true);
  const fichier = readFileSync(join(root, 'index.html'));
  const mac = await t.d.app.inject({
    url: '/',
    headers: { host: t.headers.host!, authorization: t.headers.authorization! },
  });
  expect(mac.rawPayload.equals(fichier)).toBe(true);
  for (const url of ['/', '/appairer', '/une/route']) {
    const r = await surAppareil({}, url);
    expect(r.rawPayload.equals(fichier), url).toBe(true);
    for (const secret of [t.d.auth.adminToken, t.d.auth.sessionToken, `127.0.0.1:${t.d.port}`]) {
      expect(r.body).not.toContain(secret);
      expect(JSON.stringify(r.headers)).not.toContain(secret);
    }
  }
});

test('31.5 (D173) : le nom lu après coup, par GET /api/host, ouvre le port des appareils', async () => {
  const nom = { v: null as string | null };
  t = await startTestDaemon(undefined, { tailscaleExec: tailnet(nom) });
  const e = (await basculer(true)).json<EtatModeHostDaemon>();
  expect(e).toMatchObject({ disponible: false, raison: 'nom Tailscale du Mac non lu' });
  expect((await surAppareil({}, '/')).statusCode).toBe(421);
  nom.v = NOM;
  const lu = (
    await t.d.app.inject({ url: '/api/host', headers: t.headers })
  ).json<EtatModeHostDaemon>();
  expect(lu).toMatchObject({ disponible: true, raison: null });
  expect((await surAppareil({}, '/')).statusCode).toBe(404);
});

test('31.7 (D175) : GET /api/state sur le port des appareils, masqué, depuis la vraie base', async () => {
  t = await startTestDaemon(undefined, { tailscaleExec: tailnet() });
  seedTopic(t.db);
  await basculer(true);
  const { jeton } = new RegistreAppareils(t.db).emettre({ nom: 'A', identite: null });
  const r = await surAppareil({ cookie: `${COOKIE_APPAREIL}=${jeton}` }, '/api/state');
  expect(r.statusCode).toBe(200);
  const e = r.json<EtatPourAppareil>();
  expect(e.topics.map((x) => x.title)).toEqual(['T']);
  expect(e.agents.map((x) => x.id)).toEqual(['ag_1']);
  for (const chemin of ['/definitely/missing', '/w/s', '"sh"', '/a"', '/w"']) {
    expect(r.body, chemin).not.toContain(chemin);
  }
  // le même état sur le port du Mac porte bien ces chemins : le masque fait la différence
  const mac = await t.d.app.inject({ url: '/api/state', headers: t.headers });
  expect(mac.body).toContain('/definitely/missing');
});

test('31.7 (D183) : éteindre le mode host ferme les sockets des appareils en 4401', async () => {
  t = await startTestDaemon(undefined, { tailscaleExec: tailnet() });
  await basculer(true);
  const { jeton } = new RegistreAppareils(t.db).emettre({ nom: 'A', identite: null });
  const ws = new WebSocket(`ws://127.0.0.1:${t.d.modeHost.portOuvert()}/ws/signal`, {
    headers: {
      host: NOM,
      origin: `https://${NOM}`,
      cookie: `${COOKIE_APPAREIL}=${jeton}`,
      'sec-fetch-site': 'same-origin',
    },
  });
  await new Promise((r, j) => {
    ws.on('open', r);
    ws.on('error', j);
  });
  const fin = new Promise<[number, string]>((r) => ws.on('close', (c, m) => r([c, String(m)])));
  await basculer(false);
  expect(await fin).toEqual([4401, 'revoque']);
});

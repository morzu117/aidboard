import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DEFAULT_CONFIG, loadConfig } from '../src/daemon/config.js';
import { RegistreAppareils } from '../src/daemon/host/appareils.js';
import { COOKIE_APPAREIL } from '../src/daemon/host/serveur.js';
import { resolvePaths } from '../src/daemon/paths.js';
import { issueRunToken } from '../src/daemon/security.js';
import { startTestDaemon, type TestDaemon } from './helpers/daemon.js';

let dossier: string;
let t: TestDaemon | undefined;
const url = '/api/meshes/rejoindre';
const demande = { gateway: 'https://aid-e2e.ts.net', cell: 'peer-a', mesh: 'essai' };
const secret = 'FAUX-JETON-NE-JAMAIS-SERVIR';
const home = () => join(dossier, 'home');
const jeton = () => join(home(), '.config/swarph/peer-a.peer_token');
const inscription = () => join(home(), '.config/swarph/peer-a.join.json');
const config = () => resolvePaths(t!.home).config;
const lireConfig = () => readFileSync(config(), 'utf8');

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), 'aid-routes-'));
  copyFileSync(resolve('test/fixtures/fake-swarph-join.mjs'), join(dossier, 'swarph'));
  chmodSync(join(dossier, 'swarph'), 0o700);
  scenario({});
});
afterEach(async () => {
  await t?.d.stop();
  t = undefined;
  vi.restoreAllMocks();
  rmSync(dossier, { recursive: true, force: true });
});
function scenario(valeur: Record<string, unknown>) {
  writeFileSync(join(dossier, 'scenario.json'), JSON.stringify(valeur));
}
async function demarrer() {
  const aidHome = join(dossier, 'aid');
  mkdirSync(aidHome);
  writeFileSync(join(aidHome, 'config.yaml'), `mesh:\n  home: ${home()}\n`);
  t = await startTestDaemon(aidHome, {
    config: { mesh: { ...DEFAULT_CONFIG.mesh, home: home(), bin: join(dossier, 'swarph') } },
    tailscaleExec: async (_bin, args) => ({
      stdout:
        args[0] === 'status'
          ? JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'aid-e2e.ts.net.' } })
          : '{}',
      code: null,
    }),
  });
}
const requete = (
  method: 'POST' | 'GET' | 'DELETE',
  chemin = url,
  payload?: Record<string, unknown>,
) =>
  t!.d.app.inject({
    method,
    url: chemin,
    headers: t!.headers,
    ...(payload === undefined ? {} : { payload }),
  });
async function attendre(etat: string) {
  let reponse = await requete('GET');
  await vi.waitFor(
    async () => {
      reponse = await requete('GET');
      expect(reponse.json().etat).toBe(etat);
    },
    { timeout: 5000 },
  );
  expect(reponse.body).not.toContain(secret);
  return reponse.json();
}

test('serveur principal : quatre routes, succès persistant sans GET, oubli sans toucher aux fichiers privés', async () => {
  scenario({ temoin: true });
  await demarrer();
  const journaux: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    journaux.push(args.join(' '));
  });
  vi.spyOn(console, 'log').mockImplementation((...args) => {
    journaux.push(args.join(' '));
  });
  for (const flux of [process.stdout, process.stderr])
    vi.spyOn(flux, 'write').mockImplementation((bloc) => {
      journaux.push(String(bloc));
      return true;
    });
  for (const niveau of ['info', 'warn', 'error', 'debug', 'trace', 'fatal'] as const)
    vi.spyOn(t!.d.app.log, niveau).mockImplementation((...args: unknown[]) => {
      journaux.push(JSON.stringify(args));
    });
  expect((await requete('GET')).json()).toEqual({ etat: 'aucune' });
  const debut = await requete('POST', url, demande);
  expect(debut.statusCode).toBe(200);
  expect(debut.headers['cache-control']).toBe('no-store');
  expect(debut.body).not.toContain(secret);
  // L'écriture ne dépend d'aucun sondage GET.
  await vi.waitFor(
    () =>
      expect(loadConfig(resolvePaths(t!.home)).meshes.essai).toMatchObject({
        cell: demande.cell,
        gateway: demande.gateway,
      }),
    { timeout: 5000 },
  );
  expect(await attendre('approuve')).toEqual({
    etat: 'approuve',
    temoin: 'peer-b',
    redemarrage: true,
    ...demande,
    cheminJeton: jeton(),
  });
  expect(
    (await t!.d.app.inject({ url: '/api/meshes', headers: t!.headers })).json(),
  ).not.toContainEqual(expect.objectContaining({ nom: 'essai' }));
  expect(readFileSync(jeton(), 'utf8')).toBe(secret);
  // Le faux fichier de suivi permet de vérifier l'oubli sans lire un vrai jeton.
  writeFileSync(inscription(), '{"cell":"peer-a"}');
  const oubli = await requete('DELETE', '/api/meshes/config/essai');
  expect(oubli.statusCode).toBe(200);
  expect(oubli.json()).toEqual({
    redemarrage: true,
    message: 'Le jeton existe toujours. Pour le révoquer, demande à l’opérateur du gateway.',
  });
  expect(oubli.body).not.toContain(secret);
  expect(loadConfig(resolvePaths(t!.home)).meshes.essai).toBeUndefined();
  expect(readFileSync(jeton(), 'utf8')).toBe(secret);
  expect(readFileSync(inscription(), 'utf8')).toBe('{"cell":"peer-a"}');
  expect((await requete('DELETE')).json().etat).toBe('approuve');
  expect(journaux.join('\n')).not.toContain(secret);
});

test('annuler attend SIGINT et la fin de l’enfant ; une seule demande par daemon', async () => {
  scenario({ attente: true, reserve: true });
  await demarrer();
  expect((await requete('POST', url, demande)).statusCode).toBe(200);
  expect((await requete('POST', url, demande)).statusCode).toBe(409);
  await attendre('en-attente');
  const fin = await requete('DELETE');
  expect(fin.json()).toEqual({
    etat: 'annule',
    code: 'ABCD-EFGH',
    ...demande,
    cheminJeton: jeton(),
  });
  expect(readFileSync(join(dossier, 'signal'), 'utf8')).toBe('SIGINT');
  expect(existsSync(jeton())).toBe(false);
  expect(loadConfig(resolvePaths(t!.home)).meshes.essai).toBeUndefined();
});

test('des POST simultanés ne lancent pas deux lecteurs ni deux demandes', async () => {
  scenario({ attente: true });
  await demarrer();
  const reponses = await Promise.all([
    requete('POST', url, demande),
    requete('POST', url, demande),
  ]);
  expect(reponses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
});

test('sans authentification ou avec un jeton de run : aucune des quatre routes accessible', async () => {
  await demarrer();
  const run = issueRunToken(t!.d.auth, 'run-synthetique');
  for (const [method, chemin] of [
    ['GET', url],
    ['POST', url],
    ['DELETE', url],
    ['DELETE', '/api/meshes/config/essai'],
  ] as const) {
    for (const token of [undefined, run]) {
      const r = await t!.d.app.inject({
        method,
        url: chemin,
        headers: { host: t!.headers.host!, ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(method === 'POST' ? { payload: demande } : {}),
      });
      expect(r.statusCode).toBe(token ? 403 : 401);
    }
  }
  expect((await requete('GET')).json()).toEqual({ etat: 'aucune' });
});

test('port des appareils : aucune des quatre routes, même pour un appareil authentifié', async () => {
  await demarrer();
  const activation = await t!.d.app.inject({
    method: 'PUT',
    url: '/api/host',
    headers: t!.headers,
    payload: { actif: true },
  });
  expect(activation.statusCode).toBe(200);
  const appareils = t!.d.modeHost.instance()!;
  expect(appareils).not.toBeNull();
  const { jeton: cookie } = new RegistreAppareils(t!.db).emettre({
    nom: 'Appareil de test',
    identite: null,
  });
  for (const [method, chemin] of [
    ['GET', url],
    ['POST', url],
    ['DELETE', url],
    ['DELETE', '/api/meshes/config/essai'],
  ] as const) {
    const r = await appareils.inject({
      method,
      url: chemin,
      headers: {
        host: 'aid-e2e.ts.net',
        origin: 'https://aid-e2e.ts.net',
        'sec-fetch-site': 'same-origin',
        cookie: `${COOKIE_APPAREIL}=${cookie}`,
      },
      ...(method === 'POST' ? { payload: demande } : {}),
    });
    expect(r.statusCode).toBe(404);
  }
});

test.each(['swarph-cli 0.79.9', 'swarph-cli 0.80.0'])(
  'plancher de version : %s',
  async (version) => {
    scenario({ version, attente: true });
    await demarrer();
    const r = await requete('POST', url, demande);
    expect(r.statusCode).toBe(version.includes('0.79') ? 400 : 200);
    if (r.statusCode === 400) {
      expect(r.json()).toEqual({
        error: 'swarph trop ancien pour rejoindre un mesh (0.80.0 ou plus)',
      });
      expect(existsSync(join(dossier, 'constat.json'))).toBe(false);
    }
  },
);

test.each([
  { gateway: 'http://192.0.2.1' },
  { cell: '../peer-a' },
  { mesh: 'principal' },
  { mesh: '../essai' },
  { gateway: 12 },
  { autre: true },
])('validation d’avance : %j', async (changement) => {
  await demarrer();
  const r = await requete('POST', url, { ...demande, ...changement });
  expect(r.statusCode).toBe(400);
  expect(r.json().error).toBeTypeOf('string');
  expect(existsSync(join(dossier, 'constat.json'))).toBe(false);
});

test('jeton déjà présent : refus sans lecture ni lancement ; principal ne s’oublie pas', async () => {
  await demarrer();
  mkdirSync(join(home(), '.config/swarph'), { recursive: true });
  writeFileSync(jeton(), secret, { mode: 0o600 });
  const r = await requete('POST', url, demande);
  expect(r.statusCode).toBe(400);
  expect(r.json()).toEqual({ error: 'Fichier de jeton déjà présent' });
  expect(r.body).not.toContain(secret);
  expect((await requete('DELETE', '/api/meshes/config/principal')).statusCode).toBe(400);
  expect(readFileSync(jeton(), 'utf8')).toBe(secret);
});

test('mesh ajouté pendant la demande : succès de join, refus d’écraser la config', async () => {
  await demarrer();
  expect((await requete('POST', url, demande)).statusCode).toBe(200);
  writeFileSync(config(), 'meshes:\n  principal: {}\n  essai: {cell: peer-b}\n');
  const avant = lireConfig();
  expect(await attendre('approuve')).toMatchObject({
    redemarrage: false,
    libelle: 'Mesh déjà configuré : rien n’est écrit',
  });
  expect(lireConfig()).toBe(avant);
});

test('config devenue illisible : aucune écriture, état explicite sans détail brut', async () => {
  await demarrer();
  expect((await requete('POST', url, demande)).statusCode).toBe(200);
  writeFileSync(config(), 'mesh: [');
  expect(await attendre('approuve')).toMatchObject({
    redemarrage: false,
    libelle: expect.stringContaining('Configuration non écrite'),
  });
  expect(lireConfig()).toBe('mesh: [');
});

test('mesh déjà ajouté depuis le démarrage : refus avant join', async () => {
  await demarrer();
  writeFileSync(config(), 'meshes:\n  principal: {}\n  essai: {cell: peer-b}\n');
  const avant = lireConfig();
  const r = await requete('POST', url, demande);
  expect(r.statusCode).toBe(400);
  expect(r.json()).toEqual({ error: 'Mesh déjà configuré' });
  expect(lireConfig()).toBe(avant);
  expect(existsSync(join(dossier, 'constat.json'))).toBe(false);
});

test.each(['dev', ''])('version illisible %j : refus sans sortie brute', async (version) => {
  scenario({ version });
  await demarrer();
  const r = await requete('POST', url, demande);
  expect(r.statusCode).toBe(400);
  expect(r.json()).toEqual({ error: 'Version de swarph illisible' });
  expect(existsSync(join(dossier, 'constat.json'))).toBe(false);
});

test('le mesh rejoindre s’oublie sans annuler la demande ; DELETE rejoindre reste l’annulation', async () => {
  scenario({ attente: true, reserve: true });
  await demarrer();
  writeFileSync(config(), 'meshes:\n  principal: {}\n  rejoindre: {cell: peer-b}\n');
  expect((await requete('POST', url, demande)).statusCode).toBe(200);
  await attendre('en-attente');
  const oubli = await requete('DELETE', '/api/meshes/config/rejoindre');
  expect(oubli.statusCode).toBe(200);
  expect(loadConfig(resolvePaths(t!.home)).meshes.rejoindre).toBeUndefined();
  expect((await requete('GET')).json().etat).toBe('en-attente');
  expect((await requete('DELETE')).json()).toEqual({
    etat: 'annule',
    code: 'ABCD-EFGH',
    ...demande,
    cheminJeton: jeton(),
  });
  expect(readFileSync(join(dossier, 'signal'), 'utf8')).toBe('SIGINT');
});

test('oublier un mesh absent : 404 et config inchangée', async () => {
  await demarrer();
  const avant = lireConfig();
  const r = await requete('DELETE', '/api/meshes/config/absent');
  expect(r.statusCode).toBe(404);
  expect(r.json()).toEqual({ error: 'Mesh absent de la config' });
  expect(lireConfig()).toBe(avant);
});

test('33.4 : contexte admin conservé pour les commandes après retour sur Machines', async () => {
  scenario({ attente: true });
  await demarrer();
  const saisie = { ...demande, gateway: 'https://aid-e2e.ts.net/' };
  const debut = await requete('POST', url, saisie);
  expect(debut.statusCode).toBe(200);
  expect(debut.json()).toMatchObject({ ...saisie, cheminJeton: jeton() });
  expect(await attendre('en-attente')).toMatchObject({ ...saisie, cheminJeton: jeton() });
  expect((await requete('DELETE')).json()).toMatchObject({ ...saisie, cheminJeton: jeton() });
});

test('33.3bis : le gateway enregistré est normalisé', async () => {
  await demarrer();
  const saisie = { ...demande, gateway: 'https://EXAMPLE.com/' };
  expect((await requete('POST', url, saisie)).statusCode).toBe(200);
  await attendre('approuve');
  expect(loadConfig(resolvePaths(t!.home)).meshes.essai).toMatchObject({
    cell: demande.cell,
    gateway: 'https://example.com',
  });
  expect(lireConfig()).not.toContain(saisie.gateway);
  expect(existsSync(join(t!.home, 'rejoindre.json'))).toBe(false);
});

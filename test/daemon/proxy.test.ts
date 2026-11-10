import { writeFile } from 'node:fs/promises';
import { afterEach, expect, expectTypeOf, test } from 'vitest';
import {
  creerProxyClient,
  lireReponseProxy,
  VERBES_LECTURE,
  VERBES_PROXY,
} from '../../src/daemon/mesh/proxy.js';
import { parseConfig } from '../../src/daemon/config.js';
import { creerFauxProxy, type ScenarioProxy } from '../fixtures/faux-proxy.js';

const proxies: Awaited<ReturnType<typeof creerFauxProxy>>[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.fermer()));
});
async function preparer(scenario: ScenarioProxy) {
  const proxy = await creerFauxProxy(scenario);
  proxies.push(proxy);
  return { proxy, client: creerProxyClient({ socket: proxy.socket, delaiMs: 1000 }) };
}

test.each(VERBES_PROXY)('succès et requête exacte : %s', async (verbe) => {
  const { proxy, client } = await preparer({
    reponse: { ok: true, status: 201, body: { id: 1 }, detail: 'privé' },
  });
  expect(await client.appeler(verbe, { content: 'bonjour' })).toEqual({
    ok: true,
    status: 201,
    body: { id: 1 },
  });
  expect(proxy.lignes).toHaveLength(1);
  const requete = JSON.parse(proxy.lignes[0]!);
  expect(Object.keys(requete).sort()).toEqual(['args', 'request_id', 'verb']);
  expect(requete).toMatchObject({ verb: verbe, args: { content: 'bonjour' } });
  expect(requete.request_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test.each([
  'verb_not_allowed',
  'bad_args',
  'peer_not_allowed',
  'proxy_unavailable',
  'upstream_unreachable',
  'upstream_ambiguous',
  'upstream_error',
])('code %s sans detail', async (code) => {
  const { client } = await preparer({
    reponse: { ok: false, error: code, status: 503, detail: 'privé' },
  });
  expect(await client.appeler('mesh.send', {})).toEqual({
    ok: false,
    code,
    ...(code === 'upstream_error' ? { status: 503 } : {}),
  });
});

test.each<ScenarioProxy>(['request_id_faux', 'illisible', 'trop_longue'])(
  'format refusé : %s',
  async (scenario) => {
    const { client } = await preparer(scenario);
    expect(await client.appeler('mesh.send', {})).toEqual({ ok: false, code: 'format' });
  },
);

test.each([
  { ok: true, status: 199, body: {} },
  { ok: true, status: 300, body: {} },
  { ok: true, status: 200.5, body: {} },
  { ok: true, body: {} },
  { ok: true, status: 200 },
  { ok: true, status: 200, body: null },
  { ok: true, status: 200, body: [] },
  { ok: false, error: 'inconnu' },
  { ok: 'true', status: 200, body: {} },
])('réponse invalide : %j', async (reponse) => {
  const { client } = await preparer({ reponse });
  expect(await client.appeler('mesh.send', {})).toEqual({ ok: false, code: 'format' });
});

test('parseur pur : ligne absente, JSON primitif et identifiant différent', () => {
  for (const ligne of [
    '',
    'null',
    '[]',
    '42',
    '{"request_id":"autre","ok":true,"status":200,"body":{}}',
  ])
    expect(lireReponseProxy(ligne, 'attendu')).toEqual({ ok: false, code: 'format' });
});

test.each<ScenarioProxy>(['fragmentee', 'deux_lignes'])(
  'lit seulement la première ligne, même fragmentée : %s',
  async (scenario) => {
    const { client } = await preparer(scenario);
    expect(await client.appeler('mesh.send', {})).toEqual({ ok: true, status: 200, body: {} });
  },
);

test('délai dépassé : détruit la socket', async () => {
  const { proxy } = await preparer('silence');
  expect(
    await creerProxyClient({ socket: proxy.socket, delaiMs: 30 }).appeler('mesh.send', {}),
  ).toEqual({ ok: false, code: 'delai' });
  await expect.poll(() => proxy.connexionsActives).toBe(0);
});

test('socket absente, vide ou connexion refusée : connexion', async () => {
  const { proxy } = await preparer('silence');
  // Un fichier ordinaire à ce chemin refuse la connexion Unix.
  const refusee = proxy.socket + '-refusee';
  await writeFile(refusee, '');
  for (const socket of ['', proxy.socket + '-absente', refusee])
    expect(await creerProxyClient({ socket }).appeler('mesh.send', {})).toEqual({
      ok: false,
      code: 'connexion',
    });
});

test('fermeture après réception de la ligne : interrompu', async () => {
  const { proxy, client } = await preparer('fermeture_apres_ligne');
  expect(await client.appeler('mesh.send', {})).toEqual({ ok: false, code: 'interrompu' });
  expect(proxy.lignes).toHaveLength(1);
});

test('fermeture du proxy avant lecture : interrompu par prudence dès write', async () => {
  const { proxy, client } = await preparer('fermeture');
  expect(await client.appeler('mesh.send', {})).toEqual({ ok: false, code: 'interrompu' });
  expect(proxy.lignes).toEqual([]);
});

test('verbe hors liste : exception avant connexion', async () => {
  const { proxy, client } = await preparer('silence');
  expect(() => client.appeler('mesh.mark_read', {})).toThrow('Verbe proxy non autorisé');
  expect(proxy.nombreConnexions).toBe(0);
  expect(proxy.lignes).toEqual([]);
});

test('une connexion et un UUID par appel ; UUID injectable', async () => {
  const { proxy, client } = await preparer({ reponse: { ok: true, status: 200, body: {} } });
  await client.appeler('mesh.send', {});
  await client.appeler('mesh.send', {});
  const id = '12345678-1234-4123-8123-123456789abc';
  await creerProxyClient({ socket: proxy.socket, uuid: () => id }).appeler('mesh.send', {});
  expect(proxy.nombreConnexions).toBe(3);
  const ids = proxy.lignes.map((ligne) => (JSON.parse(ligne) as { request_id: string }).request_id);
  expect(new Set(ids).size).toBe(3);
  expect(ids[2]).toBe(id);
});

test('D262 : proxySocket vide par défaut, chaîne acceptée, autres types refusés', () => {
  expect(parseConfig('').mesh.proxySocket).toBe('');
  expect(parseConfig('mesh:\n  proxySocket: ""').mesh.proxySocket).toBe('');
  expect(parseConfig('mesh:\n  proxySocket: /tmp/proxy.sock').mesh.proxySocket).toBe(
    '/tmp/proxy.sock',
  );
  for (const valeur of ['42', 'true', 'null', '[]', '{}'])
    expect(() => parseConfig(`mesh:\n  proxySocket: ${valeur}`)).toThrow('mesh.proxySocket');
});

test('body tableau accepté uniquement par le client de lecture', async () => {
  const body = [{ slug: 'page-a' }];
  const { proxy, client } = await preparer({ reponse: { ok: true, status: 200, body } });
  const lecture = creerProxyClient({ socket: proxy.socket, verbes: VERBES_LECTURE });
  expect(await lecture.appeler('memory.list', {})).toEqual({ ok: true, status: 200, body });
  expect(await client.appeler('mesh.send', {})).toEqual({ ok: false, code: 'format' });
  const ecriture = creerProxyClient({ socket: proxy.socket, verbes: VERBES_PROXY });
  const resultat = await ecriture.appeler('mesh.send', {});
  expect(resultat).toEqual({ ok: false, code: 'format' });
  if (resultat.ok) expectTypeOf(resultat.body).toEqualTypeOf<Record<string, unknown>>();
  const resultatParDefaut = await client.appeler('mesh.send', {});
  if (resultatParDefaut.ok)
    expectTypeOf(resultatParDefaut.body).toEqualTypeOf<Record<string, unknown>>();
});

test.each([null, 'texte', 42, true])(
  'body primitif refusé dans les deux modes : %j',
  async (body) => {
    const { proxy, client } = await preparer({ reponse: { ok: true, status: 200, body } });
    const lecture = creerProxyClient({ socket: proxy.socket, verbes: VERBES_LECTURE });
    expect(await lecture.appeler('mesh.peers', {})).toEqual({ ok: false, code: 'format' });
    expect(await client.appeler('mesh.send', {})).toEqual({ ok: false, code: 'format' });
  },
);

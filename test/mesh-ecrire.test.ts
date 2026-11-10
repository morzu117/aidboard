import { envoiIncertain, libelleEnvoi } from '../web/src/data/ecritures.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, expect, test, vi } from 'vitest';
import { argsProxy, REFUS_FIL_PROXY, type Ecriture } from '../src/shared/ecritures.js';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import { creerActionsConfirmation } from '../src/daemon/confirmations/actions.js';
import { creerPorte } from '../src/daemon/confirmations/porte.js';
import { creerReglage } from '../src/daemon/confirmations/reglage.js';
import { registerEcrituresRoutes } from '../src/daemon/routes/ecritures.js';
import { registerConfirmationRoutes } from '../src/daemon/routes/confirmations.js';
import { FilePda } from '../src/daemon/pda/file.js';
import { AidHttpError } from '../src/daemon/errors.js';
import { BoardReader } from '../src/daemon/mesh/board.js';
import { migrate } from '../src/daemon/db.js';
import { preparerPda, assertionPda } from './helpers/pda.js';
import { creerFauxProxy, type ScenarioProxy } from './fixtures/faux-proxy.js';
import { startTestDaemon } from './helpers/daemon.js';
import { RegistreAppareils } from '../src/daemon/host/appareils.js';
import { COOKIE_APPAREIL } from '../src/daemon/host/serveur.js';

const texte = 'Bonjour, message de test à garder hors du journal.';
const exemples: Ecriture[] = [
  { action: 'carte.note', params: { carte: 42, a: 'peer-b', kind: 'fyi', texte } },
  { action: 'dm.envoyer', params: { pair: 'peer-b', fil: null, kind: 'answer', texte } },
  { action: 'canal.poster', params: { canal: 'general', kind: 'status', texte } },
];
const attendus = [
  { verb: 'board.cards.say', args: { id: 42, content: texte, kind: 'fyi', to_node: 'peer-b' } },
  { verb: 'mesh.send', args: { to_node: 'peer-b', content: texte, kind: 'answer' } },
  { verb: 'channel.post', args: { channel: 'general', content: texte, kind: 'status' } },
];
const nettoyages: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const f of nettoyages.splice(0).reverse()) await f();
});
const succes = {
  reponse: {
    ok: true,
    status: 201,
    body: { id: 72, open_obligations: [81], closed_obligations: [], texte },
  },
};
async function preparer(scenario: ScenarioProxy = succes) {
  const t = preparerPda();
  nettoyages.push(t.nettoyer);
  const proxy = await creerFauxProxy(scenario);
  nettoyages.push(() => proxy.fermer());
  const config = structuredClone(DEFAULT_CONFIG);
  config.mesh.cell = 'peer-a';
  config.mesh.proxySocket = proxy.socket;
  const board = new BoardReader({ mesh: { read: vi.fn() }, cell: config.mesh.cell, log: vi.fn() });
  const obligations = vi.spyOn(board, 'obligations').mockResolvedValue({
    ok: true,
    data: { obligations: [], truncated: false, asOf: null },
    schemaVersion: null,
    readAt: '',
  });
  const hotesPrives: string[] = [];
  const actions = creerActionsConfirmation({ ...t, config, board });
  // Le nettoyage est aussi testé avec une politique locale qui évolue après la demande.
  const { creerActionEcriture } = await import('../src/daemon/confirmations/ecritures.js');
  actions['mesh.ecrire'] = creerActionEcriture({ ...t, config, board, hotesPrives });
  const reglage = creerReglage(t.db);
  reglage.armer();
  const appareil = await t.appareil();
  let reponses: { id: string; appareil: string; corps: string; curseur: number }[] = [];
  const porte = creerPorte({ db: t.db, actions, file: () => file });
  const file = new FilePda({
    ...t,
    actif: () => true,
    contexte: () => ({ origine: 'https://aid-e2e.ts.net', rpId: 'aid-e2e.ts.net' }),
    signaler: vi.fn(),
    executer: (ligne) => porte.executerConfirmee(ligne),
    preparerConsommation: (ligne) => porte.preparerConsommation(ligne),
    relais: {
      publierAutorises: async () => true,
      deposer: async () => true,
      retirer: async () => {},
      tirer: async () => reponses,
    },
  });
  nettoyages.push(() => file.arreter());
  const app = Fastify();
  nettoyages.push(() => app.close());
  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (req) => {
    req.principal = { kind: 'admin', via: 'bearer' };
  });
  app.setErrorHandler((e, _req, reply) => {
    if (e instanceof AidHttpError) return reply.code(e.status).send({ error: e.message });
    throw e;
  });
  registerEcrituresRoutes(app, { cell: config.mesh.cell, board, porte });
  registerConfirmationRoutes(app, t.db, porte, () => file);
  const demander = (payload: unknown = exemples[0]) =>
    app.inject({ method: 'POST', url: '/api/swarph/ecrire/envoyer', payload: payload as object });
  const resultat = async (id: string) => {
    const r = await app.inject('/api/confirmations');
    return [...r.json().ouvertes, ...r.json().recentes].find((d) => d.id === id);
  };
  const oui = async (id: string) => {
    const ligne = t.db
      .prepare('SELECT numero, numero_mac FROM pda_demandes WHERE id = ?')
      .get(id) as { numero: string; numero_mac: string | null };
    // Comme dans confirmations-porte : adapter la fausse passkey aux demandes toujours.
    if (ligne.numero_mac !== null)
      t.db.prepare('UPDATE pda_demandes SET numero = ? WHERE id = ?').run(ligne.numero_mac, id);
    const assertion = await assertionPda(t.db, id, appareil);
    if (ligne.numero_mac !== null)
      t.db.prepare('UPDATE pda_demandes SET numero = ? WHERE id = ?').run(ligne.numero, id);
    reponses = [
      {
        id,
        appareil: appareil.id,
        curseur: 1,
        corps: Buffer.from(JSON.stringify(assertion)).toString('base64url'),
      },
    ];
    await file.tour();
    reponses = [];
    return resultat(id);
  };
  return {
    ...t,
    proxy,
    config,
    actions,
    board,
    obligations,
    reglage,
    hotesPrives,
    demander,
    resultat,
    oui,
    app,
  };
}

test('D264 — proxy-protocol.md « Argument types » et table des verbes : args fermés sans conversion', () => {
  exemples.forEach((e, i) => expect(argsProxy(e.action, e.params)).toEqual(attendus[i]));
  expect(argsProxy('carte.note', { carte: 42, a: null, kind: 'fyi', texte })).toEqual({
    verb: 'board.cards.say',
    args: { id: 42, content: texte, kind: 'fyi' },
  });
  expect(() =>
    argsProxy('dm.envoyer', {
      pair: 'peer-b',
      fil: '00000000-0000-4000-8000-000000000000',
      kind: 'fyi',
      texte,
    }),
  ).toThrow(REFUS_FIL_PROXY);
  for (const extra of ['from_node', 'actor', 'cc', 'thread_id', 'reply_to'])
    expect(() =>
      argsProxy('carte.note', { ...exemples[0]!.params, [extra]: 'interdit' } as never),
    ).toThrow();
  expect(() =>
    argsProxy('carte.note', { carte: true, a: null, kind: 'fyi', texte } as never),
  ).toThrow();
});

test.each([0, 1, 2])('demande, oui, proxy et résultat sans texte : action %s', async (i) => {
  const t = await preparer();
  const demande = await t.demander(exemples[i]);
  expect(demande.statusCode).toBe(202);
  expect(t.proxy.lignes).toHaveLength(0);
  const { confirmation } = demande.json();
  const ligne = t.db
    .prepare('SELECT params, resume FROM pda_demandes WHERE id = ?')
    .get(confirmation) as { params: string; resume: string };
  expect(JSON.parse(ligne.params)).toEqual(exemples[i]);
  expect(ligne.resume).not.toContain(texte);
  const resultat = await t.oui(confirmation);
  expect(resultat).toMatchObject({
    resultat: 'executee',
    envoi: { code: 'succes', id: 72, open_obligations: [81], status: 201 },
  });
  expect(JSON.stringify(resultat)).not.toContain(texte);
  const requete = JSON.parse(t.proxy.lignes[0]!);
  expect(requete).toEqual({ ...attendus[i], request_id: expect.any(String) });
  expect(t.journal).toHaveBeenCalledWith(
    'mesh.ecrire',
    expect.objectContaining({
      action: exemples[i]!.action,
      request_id: requete.request_id,
      code: 'succes',
    }),
  );
  expect(JSON.stringify(t.journal.mock.calls)).not.toContain(texte);
  expect(JSON.stringify(t.journal.mock.calls)).not.toContain('params');
  expect(t.obligations).toHaveBeenCalledTimes(i === 0 ? 2 : 0);
  // « Replies, deadlines, and retry safety » : réponse JSON brute et une seule tentative.
  await t.oui(confirmation);
  expect(t.proxy.lignes).toHaveLength(1);
});

test.each([
  'verb_not_allowed',
  'bad_args',
  'peer_not_allowed',
  'proxy_unavailable',
  'upstream_unreachable',
  'upstream_ambiguous',
  'upstream_error',
])('code du proxy %s jusqu’à envoi, sans detail', async (code) => {
  const t = await preparer({ reponse: { ok: false, error: code, status: 503, detail: texte } });
  const { confirmation } = (await t.demander()).json();
  const r = await t.oui(confirmation);
  expect(r).toMatchObject({
    resultat: 'echouee',
    envoi: { code, status: 503, open_obligations: [] },
  });
  expect(JSON.stringify(r)).not.toContain(texte);
  expect(JSON.stringify(t.journal.mock.calls)).not.toContain(texte);
  expect(t.proxy.lignes).toHaveLength(1);
});
test.each<ScenarioProxy>(['illisible', 'fermeture_apres_ligne'])(
  'erreur de transport %s jusqu’à envoi',
  async (scenario) => {
    const t = await preparer(scenario);
    const { confirmation } = (await t.demander()).json();
    expect((await t.oui(confirmation)).envoi.code).toBe(
      scenario === 'illisible' ? 'format' : 'interrompu',
    );
  },
);
test('closed_obligations non vide est une erreur incertaine, jamais un succès', async () => {
  const t = await preparer({
    reponse: {
      ok: true,
      status: 201,
      body: { id: 72, open_obligations: [], closed_obligations: [81], texte },
    },
  });
  const { confirmation } = (await t.demander()).json();
  expect(await t.oui(confirmation)).toMatchObject({
    resultat: 'echouee',
    envoi: { code: 'obligation-close', open_obligations: [] },
  });
});
test('params valides modifiés depuis la signature : perime, aucun appel', async () => {
  const t = await preparer();
  const { confirmation } = (await t.demander()).json();
  const autre = {
    ...exemples[0],
    params: { ...exemples[0]!.params, texte: 'Autre message valide' },
  };
  t.db
    .prepare('UPDATE pda_demandes SET params = ? WHERE id = ?')
    .run(JSON.stringify(autre), confirmation);
  expect(await t.oui(confirmation)).toMatchObject({
    resultat: 'perimee',
    raison: 'perime',
    envoi: null,
  });
  expect(t.proxy.lignes).toHaveLength(0);
});
test('preparer refait le nettoyage au oui après changement de politique', async () => {
  const t = await preparer();
  const { confirmation } = (
    await t.demander({
      action: 'canal.poster',
      params: { canal: 'general', kind: 'fyi', texte: 'Voir example.com' },
    })
  ).json();
  t.hotesPrives.push('example.com');
  expect(await t.oui(confirmation)).toMatchObject({ resultat: 'perimee', raison: 'perime' });
  expect(t.proxy.lignes).toHaveLength(0);
});
test('route : sans proxy, schéma, fil et nettoyage sans texte ; preparer seul ne contourne rien', async () => {
  const t = await preparer();
  const action = t.actions['mesh.ecrire'];
  for (const [params, status] of [
    [{ carte: true, a: null, kind: 'fyi', texte }, 400],
    [{ pair: 'peer-b', fil: '00000000-0000-4000-8000-000000000000', kind: 'fyi', texte }, 400],
    [{ carte: 42, a: null, kind: 'fyi', texte: 'Voir aid-e2e.ts.net' }, 422],
  ] as const) {
    const e = { action: 'pair' in params ? 'dm.envoyer' : 'carte.note', params };
    const r = await t.demander(e);
    expect(r.statusCode).toBe(status);
    expect(r.body).not.toContain(params.texte);
    await expect(action.preparer(e as never, { confirmation: true })).rejects.toMatchObject({
      status,
    });
    if ('pair' in params) expect(r.json().error).toBe(REFUS_FIL_PROXY);
  }
  t.config.mesh.proxySocket = '';
  expect((await t.demander()).statusCode).toBe(409);
  expect((await t.demander()).json()).toEqual({ error: 'proxy_absent' });
  await expect(action.preparer(exemples[0]!, { confirmation: true })).rejects.toMatchObject({
    status: 409,
  });
  expect(t.proxy.lignes).toHaveLength(0);
});
test('porte désarmée : refus avant préparation, aucun envoi ni demande', async () => {
  const t = await preparer();
  t.reglage.desarmerConfirme();
  const preparation = vi.spyOn(t.actions['mesh.ecrire'], 'preparer');
  const r = await t.demander();
  expect(r.statusCode).toBe(409);
  expect(r.json()).toEqual({ error: 'confirmation_requise' });
  expect(preparation).not.toHaveBeenCalled();
  expect(t.proxy.lignes).toHaveLength(0);
  expect(t.proxy.nombreConnexions).toBe(0);
  expect(t.db.prepare('SELECT count(*) AS n FROM pda_demandes').get()).toEqual({ n: 0 });
});

test('réglage forcé à zéro : confirmation obligatoire et un seul envoi après oui', async () => {
  const t = await preparer();
  t.db.prepare("UPDATE confirmations_reglage SET actif = 0 WHERE action = 'mesh.ecrire'").run();
  expect(t.reglage.exige('mesh.ecrire')).toBe(true);
  const r = await t.demander();
  expect(r.statusCode).toBe(202);
  expect(t.proxy.lignes).toHaveLength(0);
  const { confirmation } = r.json();
  expect(await t.oui(confirmation)).toMatchObject({ resultat: 'executee' });
  expect(t.proxy.lignes).toHaveLength(1);
  await t.oui(confirmation);
  expect(t.proxy.lignes).toHaveLength(1);
});

test.each([false, true])('modification mesh.ecrire refusée, porte armée : %s', async (arme) => {
  const t = await preparer();
  if (!arme) t.reglage.desarmerConfirme();
  const r = await t.app.inject({
    method: 'PUT',
    url: '/api/confirmations/reglage',
    payload: { action: 'mesh.ecrire', actif: false },
  });
  expect(r.statusCode).toBe(400);
  expect(t.reglage.exige('mesh.ecrire')).toBe(true);
  expect(() => t.reglage.couperConfirme('mesh.ecrire')).toThrow('confirmation obligatoire');
  expect(t.proxy.lignes).toHaveLength(0);
  expect(t.db.prepare('SELECT count(*) AS n FROM pda_demandes').get()).toEqual({ n: 0 });
});

test('migration 025 préserve les réglages 024, ajoute mesh.ecrire actif et envoi, reste idempotente', () => {
  const db = new Database(':memory:');
  try {
    for (const f of readdirSync('migrations')
      .filter((f) => /^\d{3}_.*sql$/.test(f) && f < '025')
      .sort())
      db.exec(readFileSync(join('migrations', f), 'utf8'));
    db.pragma('user_version = 24');
    db.exec("UPDATE confirmations_reglage SET actif = 0, modifie_a = 123 WHERE action = 'push'");
    const avant = creerReglage(db).lire();
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(25);
    expect(creerReglage(db).lire()).toEqual([
      ...avant,
      { action: 'mesh.ecrire', actif: true, modifieA: null },
    ]);
    expect(() => db.exec("INSERT INTO confirmations_reglage VALUES ('inconnu', 1, NULL)")).toThrow(
      /CHECK/,
    );
    expect(() => db.exec('UPDATE confirmations_reglage SET actif = 2')).toThrow(/CHECK/);
    migrate(db);
    expect(creerReglage(db).lire()).toHaveLength(5);
    expect(db.prepare('SELECT envoi FROM pda_demandes').all()).toEqual([]);
  } finally {
    db.close();
  }
});
test('mesh désactivé : 404 ; mode host : aucune route d’envoi', async () => {
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
  nettoyages.push(() => t.d.stop());
  expect(
    (
      await t.d.app.inject({
        method: 'POST',
        url: '/api/swarph/ecrire/envoyer',
        headers: t.headers,
        payload: exemples[0],
      })
    ).statusCode,
  ).toBe(404);
  await t.d.app.inject({
    method: 'PUT',
    url: '/api/host',
    headers: t.headers,
    payload: { actif: true },
  });
  const { jeton } = new RegistreAppareils(t.db).emettre({ nom: 'Exemple', identite: null });
  const r = await t.d.modeHost.instance()!.inject({
    method: 'POST',
    url: '/api/swarph/ecrire/envoyer',
    payload: exemples[0],
    headers: {
      host: 'aid-e2e.ts.net',
      origin: 'https://aid-e2e.ts.net',
      'sec-fetch-site': 'same-origin',
      cookie: `${COOKIE_APPAREIL}=${jeton}`,
    },
  });
  expect(r.statusCode).toBe(404);
});

test('« Replies, deadlines, and retry safety » : délai client de 20 s, une seule tentative', async () => {
  const t = await preparer('silence');
  const { confirmation } = (await t.demander()).json();
  const reponse = await t.oui(confirmation);
  expect(reponse).toMatchObject({
    resultat: 'echouee',
    envoi: { code: 'delai', open_obligations: [] },
  });
  expect(t.proxy.lignes).toHaveLength(1);
}, 25_000);

test('body incomplet : format, sans conserver le contenu brut du gateway', async () => {
  const t = await preparer({ reponse: { ok: true, status: 201, body: { texte } } });
  const { confirmation } = (await t.demander()).json();
  const r = await t.oui(confirmation);
  expect(r).toMatchObject({ resultat: 'echouee', envoi: { code: 'format', open_obligations: [] } });
  expect(JSON.stringify(r)).not.toContain(texte);
});

test('proxy retiré au oui : perime sans connexion ; obligations indisponibles non bloquantes', async () => {
  const t = await preparer();
  t.obligations.mockRejectedValue(new Error('indisponible'));
  const { confirmation } = (await t.demander()).json();
  expect(confirmation).toEqual(expect.any(String));
  t.config.mesh.proxySocket = '';
  expect(await t.oui(confirmation)).toMatchObject({ resultat: 'perimee', raison: 'perime' });
  expect(t.proxy.lignes).toHaveLength(0);
});

test('mesh.ecrire : toute modification de sa ligne est refusée', async () => {
  const t = await preparer();
  for (const actif of [false, true]) {
    const r = await t.app.inject({
      method: 'PUT',
      url: '/api/confirmations/reglage',
      payload: { action: 'mesh.ecrire', actif },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'confirmation obligatoire' });
    expect(t.reglage.exige('mesh.ecrire')).toBe(true);
  }
  expect(t.db.prepare('SELECT count(*) AS n FROM pda_demandes').get()).toEqual({ n: 0 });
});

test('obligation-close est affiché comme incertain par le web', () => {
  const envoi = { code: 'obligation-close' as const, open_obligations: [] };
  expect(envoiIncertain(envoi)).toBe(true);
  expect(libelleEnvoi(envoi)).toBe(
    'Envoi incertain : il est peut-être parti. Relis le fil avant de réessayer.',
  );
});

import { startTestDaemon } from './helpers/daemon.js';
import { RegistreAppareils } from '../src/daemon/host/appareils.js';
import { COOKIE_APPAREIL } from '../src/daemon/host/serveur.js';
import { afterEach, expect, test, vi } from 'vitest';
import Fastify from 'fastify';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import { creerActionsConfirmation } from '../src/daemon/confirmations/actions.js';
import { creerPorte } from '../src/daemon/confirmations/porte.js';
import { creerReglage } from '../src/daemon/confirmations/reglage.js';
import { registerEcrituresRoutes } from '../src/daemon/routes/ecritures.js';
import { registerConfirmationRoutes } from '../src/daemon/routes/confirmations.js';
import { FilePda } from '../src/daemon/pda/file.js';
import { AidHttpError } from '../src/daemon/errors.js';
import { BoardReader } from '../src/daemon/mesh/board.js';
import { parseObligations } from '../src/shared/board.js';
import { hashAccept, tailleJsonPython } from '../src/shared/etats.js';
import { preparerPda, assertionPda } from './helpers/pda.js';
import { creerFauxProxy, type ScenarioProxy } from './fixtures/faux-proxy.js';
const texte = 'Texte confidentiel de test';
const cible = { carte: 42, obligation: 81, attendu: { status: 'open' as const } };
const exemples = [
  { action: 'obligation.prendre', params: cible },
  { action: 'obligation.refuser', params: { ...cible, motif: texte } },
];
const obligation = (champs = {}) =>
  parseObligations({
    obligations: [{ id: 81, status: 'open', holder: 'peer-a', accept: 'Accept', ...champs }],
  })!.value.obligations[0]!;
const nettoyages: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of nettoyages.splice(0).reverse()) await f();
});
const succes = { reponse: { ok: true, status: 200, body: { texte } } };
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
    data: { obligations: [obligation()], truncated: false, asOf: null },
    schemaVersion: null,
    readAt: '',
  });
  const hotesPrives: string[] = [];
  const actions = creerActionsConfirmation({ ...t, config, board });
  // Le nettoyage est aussi testé avec une politique locale qui évolue après la demande.
  const { creerActionEtat } = await import('../src/daemon/confirmations/etats.js');
  actions['mesh.etat'] = creerActionEtat({ ...t, config, board, hotesPrives });
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
    app.inject({ method: 'POST', url: '/api/swarph/etat/envoyer', payload: payload as object });
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

async function cloture() {
  return {
    action: 'obligation.clore',
    params: {
      ...cible,
      attendu: { status: 'open', acceptSha256: await hashAccept('Accept') },
      issue: 'skipped',
      preuve: texte,
      preuves: { c1: texte },
    },
  };
}

test('proxy-protocol.md « Argument types » et table des verbes : chaque args exact, résultat et journal sans textes', async () => {
  const fermer = await cloture();
  const attendus = [
    { verb: 'board.obligations.take', args: { id: 81, expect_status: 'open' } },
    { verb: 'board.obligations.decline', args: { id: 81, expect_status: 'open', why: texte } },
    {
      verb: 'board.obligations.close',
      args: {
        id: 81,
        expect_status: 'open',
        expect_accept_sha256: fermer.params.attendu.acceptSha256,
        outcome: 'skipped',
        evidence: texte,
        evidence_json: { c1: texte },
      },
    },
  ];
  for (const [i, exemple] of [...exemples, fermer].entries()) {
    const t = await preparer();
    const demande = await t.demander(exemple);
    expect(demande.statusCode).toBe(202);
    expect(t.proxy.lignes).toHaveLength(0);
    const id = demande.json().confirmation;
    const r = await t.oui(id);
    expect(r).toMatchObject({ resultat: 'executee', envoi: { code: 'succes', status: 200 } });
    expect(r.envoi).toEqual({ code: 'succes', status: 200 });
    expect(JSON.parse(t.proxy.lignes[0]!)).toEqual({
      ...attendus[i],
      request_id: expect.any(String),
    });
    expect(JSON.stringify(r)).not.toContain(texte);
    expect(JSON.stringify(t.journal.mock.calls)).not.toContain(texte);
    expect(t.journal).toHaveBeenCalledWith('mesh.etat', {
      action: exemple.action,
      carte: '42',
      obligation: '81',
      request_id: JSON.parse(t.proxy.lignes[0]!).request_id,
      code: 'succes',
    });
    expect(t.obligations).toHaveBeenCalledTimes(2);
    await t.oui(id);
    expect(t.proxy.lignes).toHaveLength(1);
  }
});

test.each([
  ['obligation.prendre', { status: 'closed' }],
  ['obligation.prendre', { taken_at: 'date' }],
  ['obligation.refuser', { taken_at: 'date' }],
  ['obligation.clore', { accept: 'Modifié' }],
  ['obligation.clore', { status: 'withdrawn' }],
  ['obligation.prendre', { id: 82 }],
])('D272 : refus tôt %s %j, puis relecture au oui', async (action, changement) => {
  const t = await preparer();
  const exemple =
    action === 'obligation.clore' ? await cloture() : exemples.find((e) => e.action === action)!;
  const { confirmation } = (await t.demander(exemple)).json();
  t.obligations.mockResolvedValue({
    ok: true,
    data: { obligations: [obligation(changement)], truncated: false, asOf: null },
    schemaVersion: null,
    readAt: '',
  });
  expect((await t.demander(exemple)).json()).toEqual({ error: 'perime' });
  expect((await t.demander(exemple)).statusCode).toBe(409);
  expect(await t.oui(confirmation)).toMatchObject({ resultat: 'perimee', raison: 'perime' });
  expect(t.proxy.lignes).toHaveLength(0);
});

test('409 gateway gardé sans retry et sans détail', async () => {
  const t = await preparer({
    reponse: { ok: false, error: 'upstream_error', status: 409, detail: texte },
  });
  const { confirmation } = (await t.demander(exemples[1])).json();
  const r = await t.oui(confirmation);
  expect(r).toMatchObject({ resultat: 'echouee', envoi: { code: 'upstream_error', status: 409 } });
  expect(JSON.stringify(r)).not.toContain(texte);
  expect(JSON.stringify(t.journal.mock.calls)).not.toContain(texte);
  expect(t.proxy.lignes).toHaveLength(1);
});

test('route : schéma, nettoyage, proxy absent, lecture indisponible et réglage forcé à zéro', async () => {
  const t = await preparer();
  expect((await t.demander({ action: 'obligation.refuser', params: cible })).statusCode).toBe(400);
  expect(
    (
      await t.demander({
        action: 'obligation.refuser',
        params: { ...cible, motif: 'aid-e2e.ts.net' },
      })
    ).statusCode,
  ).toBe(422);
  t.config.mesh.proxySocket = '';
  expect((await t.demander()).json()).toEqual({ error: 'proxy_absent' });
  t.config.mesh.proxySocket = t.proxy.socket;
  t.obligations.mockRejectedValueOnce(new Error('indisponible'));
  expect((await t.demander()).json()).toEqual({ error: 'perime' });
  t.db.prepare("UPDATE confirmations_reglage SET actif = 0 WHERE action = 'mesh.etat'").run();
  expect(t.reglage.exige('mesh.etat')).toBe(true);
  const r = await t.demander();
  expect(r.statusCode).toBe(202);
  expect(t.proxy.lignes).toHaveLength(0);
  expect(t.proxy.nombreConnexions).toBe(0);
  const { confirmation } = r.json();
  expect(await t.oui(confirmation)).toMatchObject({ resultat: 'executee' });
  expect(t.proxy.lignes).toHaveLength(1);
  await t.oui(confirmation);
  expect(t.proxy.lignes).toHaveLength(1);
});
test('porte désarmée : confirmation requise, aucun envoi ni demande', async () => {
  const t = await preparer();
  t.reglage.desarmerConfirme();
  const preparation = vi.spyOn(t.actions['mesh.etat'], 'preparer');
  const r = await t.demander();
  expect(r.statusCode).toBe(409);
  expect(r.json()).toEqual({ error: 'confirmation_requise' });
  expect(preparation).not.toHaveBeenCalled();
  expect(t.proxy.lignes).toHaveLength(0);
  expect(t.proxy.nombreConnexions).toBe(0);
  expect(t.db.prepare('SELECT count(*) AS n FROM pda_demandes').get()).toEqual({ n: 0 });
});
test.each([false, true])('couper mesh.etat est refusé, porte armée : %s', async (arme) => {
  const t = await preparer();
  if (!arme) t.reglage.desarmerConfirme();
  const r = await t.app.inject({
    method: 'PUT',
    url: '/api/confirmations/reglage',
    payload: { action: 'mesh.etat', actif: false },
  });
  expect(r.statusCode).toBe(400);
  expect(r.json()).toEqual({ error: 'confirmation obligatoire' });
  expect(t.reglage.exige('mesh.etat')).toBe(true);
  expect(() => t.reglage.couperConfirme('mesh.etat')).toThrow('confirmation obligatoire');
  expect(t.proxy.lignes).toHaveLength(0);
  expect(t.db.prepare('SELECT count(*) AS n FROM pda_demandes').get()).toEqual({ n: 0 });
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
        url: '/api/swarph/etat/envoyer',
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
    url: '/api/swarph/etat/envoyer',
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

test('D276 : evidence_json au-delà de 12 000 refusé avant toute lecture', async () => {
  const t = await preparer();
  const exemple = await cloture();
  const preuves = { c1: 'é'.repeat(4000), c2: 'é'.repeat(4000), c3: 'é'.repeat(4000) };
  expect(
    (await t.demander({ ...exemple, params: { ...exemple.params, preuves } })).statusCode,
  ).toBe(400);
  expect(t.obligations).not.toHaveBeenCalled();
  expect(t.proxy.lignes).toHaveLength(0);
});

test('params signés et nettoyage du motif revérifiés au oui', async () => {
  const t = await preparer();
  const exemple = { action: 'obligation.refuser', params: { ...cible, motif: 'Voir example.com' } };
  const id = (await t.demander(exemple)).json().confirmation;
  t.hotesPrives.push('example.com');
  expect(await t.oui(id)).toMatchObject({ resultat: 'perimee', raison: 'perime' });
  t.hotesPrives.length = 0;
  const autre = (await t.demander(exemple)).json().confirmation;
  t.db
    .prepare('UPDATE pda_demandes SET params = ? WHERE id = ?')
    .run(
      JSON.stringify({ ...exemple, params: { ...exemple.params, motif: 'Autre motif' } }),
      autre,
    );
  expect(await t.oui(autre)).toMatchObject({ resultat: 'perimee', raison: 'perime' });
  expect(t.proxy.lignes).toHaveLength(0);
});

test.each([
  [11991, 202],
  [11992, 400],
])('D276 : preuves ASCII (%i caractères de texte) → %i', async (longueur, statut) => {
  const t = await preparer();
  const exemple = await cloture();
  const preuves = { a: 'x'.repeat(longueur) };
  expect(tailleJsonPython(preuves)).toBe(longueur + 9);
  const r = await t.demander({ ...exemple, params: { ...exemple.params, preuves } });
  expect(r.statusCode).toBe(statut);
  expect(t.db.prepare('SELECT count(*) AS n FROM pda_demandes').get()).toEqual({
    n: statut === 202 ? 1 : 0,
  });
  expect(t.proxy.lignes).toHaveLength(0);
  expect(t.proxy.nombreConnexions).toBe(0);
});

test('D276 : repro du lab, quatre textes de 15 991 caractères → 400', async () => {
  const t = await preparer();
  const exemple = await cloture();
  const preuves = Object.fromEntries(['a', 'b', 'c', 'd'].map((cle) => [cle, 'x'.repeat(15991)]));
  const r = await t.demander({ ...exemple, params: { ...exemple.params, preuves } });
  expect(r.statusCode).toBe(400);
  expect(t.db.prepare('SELECT count(*) AS n FROM pda_demandes').get()).toEqual({ n: 0 });
  expect(t.obligations).not.toHaveBeenCalled();
  expect(t.proxy.lignes).toHaveLength(0);
  expect(t.proxy.nombreConnexions).toBe(0);
});

test('D276 : preuve simple de 3 900 caractères de quatre octets, demande créée', async () => {
  const t = await preparer();
  const exemple = await cloture();
  const params = { ...exemple.params };
  delete (params as { preuves?: object }).preuves;
  t.obligations.mockResolvedValue({
    ok: true,
    data: {
      obligations: [obligation({ id: Number.MAX_SAFE_INTEGER })],
      truncated: false,
      asOf: null,
    },
    schemaVersion: null,
    readAt: '',
  });
  const r = await t.demander({
    ...exemple,
    params: {
      ...params,
      carte: Number.MAX_SAFE_INTEGER,
      obligation: Number.MAX_SAFE_INTEGER,
      issue: 'cannot_evaluate',
      preuve: '😀'.repeat(3900),
    },
  });
  expect(r.statusCode).toBe(202);
});

test('D276 : 12 000 sérialisés et preuve simple de quatre octets → 413 sans demande ni proxy', async () => {
  const t = await preparer();
  const exemple = await cloture();
  const preuves = { a: 'x'.repeat(11991) };
  expect(tailleJsonPython(preuves)).toBe(12000);
  const r = await t.demander({
    ...exemple,
    params: {
      ...exemple.params,
      preuves,
      preuve: '😀'.repeat(3900),
    },
  });
  expect(r.statusCode).toBe(413);
  expect(r.json()).toEqual({ error: 'demande_trop_grande' });
  expect(t.db.prepare('SELECT count(*) AS n FROM pda_demandes').get()).toEqual({ n: 0 });
  expect(t.proxy.lignes).toHaveLength(0);
  expect(t.proxy.nombreConnexions).toBe(0);
});

test('D276 : 12 000 caractères de quatre octets dépassent le plafond Python → 400', async () => {
  const t = await preparer();
  const exemple = await cloture();
  const r = await t.demander({
    ...exemple,
    params: {
      ...exemple.params,
      preuves: { a: '😀'.repeat(12000) },
    },
  });
  expect(r.statusCode).toBe(400);
  expect(t.db.prepare('SELECT count(*) AS n FROM pda_demandes').get()).toEqual({ n: 0 });
  expect(t.proxy.lignes).toHaveLength(0);
  expect(t.proxy.nombreConnexions).toBe(0);
});

const deplacement = {
  action: 'carte.deplacer',
  params: { carte: 42, etape: 'review', attendu: { stage: 'build', stageVersion: 3 } },
};
async function preparerDeplacement(scenario: ScenarioProxy = succes) {
  const t = await preparer(scenario);
  const { parseCard } = await import('../src/shared/board.js');
  const card = vi.spyOn(t.board, 'card').mockResolvedValue({
    card: {
      ok: true,
      data: parseCard({ id: 42, stage: 'build', stage_version: 3, assignee: 'peer-a' })!.value,
      schemaVersion: null,
      readAt: '',
    },
    graph: { ok: false, kind: 'unknown', readAt: '' },
    thread: { ok: false, kind: 'unknown', readAt: '' },
    obligations: { ok: false, kind: 'unknown', readAt: '' },
  });
  return { ...t, card };
}
test('D293 : demande toujours même avec réglage à zéro, aucune écriture avant le oui, une seule après', async () => {
  const t = await preparerDeplacement();
  t.db.prepare("UPDATE confirmations_reglage SET actif = 0 WHERE action = 'mesh.etat'").run();
  const r = await t.demander(deplacement);
  expect(r.statusCode).toBe(202);
  expect(t.proxy.lignes).toEqual([]);
  expect((await t.oui(r.json().confirmation)).envoi.code).toBe('succes');
  expect(t.proxy.lignes.map((l) => JSON.parse(l))).toMatchObject([
    {
      verb: 'board.cards.move',
      args: { id: 42, stage: 'review', expect_stage: 'build', expect_stage_version: 3 },
    },
  ]);
  expect(t.card).toHaveBeenCalledWith(42, { fresh: true, sansCache: true });
});
test('D293 : porte désarmée, aucun chemin direct', async () => {
  const t = await preparerDeplacement();
  t.reglage.desarmerConfirme();
  const r = await t.demander(deplacement);
  expect(r.statusCode).toBe(409);
  expect(r.json().error).toBe('confirmation_requise');
  expect(t.card).not.toHaveBeenCalled();
  expect(t.proxy.lignes).toEqual([]);
});
test('D293 : done refusé avant le proxy', async () => {
  const t = await preparerDeplacement();
  expect(
    (await t.demander({ ...deplacement, params: { ...deplacement.params, etape: 'done' } }))
      .statusCode,
  ).toBe(400);
  expect(t.proxy.lignes).toEqual([]);
});
test('D293 : version changée avant le oui, demande périmée, aucune écriture', async () => {
  const t = await preparerDeplacement();
  const r = await t.demander(deplacement);
  const fiche = await t.board.card(42);
  if (fiche.card.ok) fiche.card.data.stageVersion = 4;
  expect((await t.oui(r.json().confirmation)).resultat).toBe('perimee');
  expect(t.proxy.lignes).toEqual([]);
});
test.each([
  [403, undefined, undefined, 'Droit manquant'],
  [409, 'precondition', 'ready', 'La carte a changé (ready)'],
  [409, 'step_gate', undefined, "Porte d'étape"],
  [409, 'flow_unconfirmed', undefined, "Flow non confirmé (l'orchestrateur doit le confirmer)"],
  [409, 'open_obligations', undefined, 'Obligations ouvertes'],
  [403, 'forbidden', undefined, 'Droit manquant'],
  [400, 'bad_stage', undefined, 'Étape inconnue'],
  [404, 'not_found', undefined, 'Carte absente'],
  [
    409,
    'other',
    undefined,
    'Déplacement non confirmé. Relis la carte avant toute nouvelle action.',
  ],
  [
    409,
    'secret-amont',
    'secret-amont',
    'La carte a changé ou une porte a refusé le déplacement. Relis la carte.',
  ],
] as const)(
  'D293 : refus structuré %s/%s sans texte amont',
  async (status, refusal, current_stage, libelle) => {
    const { libelleDeplacement } = await import('../src/shared/deplacements.js');
    const t = await preparerDeplacement({
      reponse: {
        ok: false,
        error: 'upstream_error',
        status,
        detail: 'secret-amont',
        refusal,
        current_stage,
      },
    });
    const r = await t.demander(deplacement);
    const fin = await t.oui(r.json().confirmation);
    expect(libelleDeplacement(fin.envoi)).toBe(libelle);
    expect(JSON.stringify(fin)).not.toContain('secret-amont');
    expect(JSON.stringify(t.db.prepare('SELECT * FROM pda_demandes').all())).not.toContain(
      'secret-amont',
    );
    expect(JSON.stringify(t.journal.mock.calls)).not.toContain('secret-amont');
    expect(t.proxy.lignes).toHaveLength(1);
  },
);
test('D293 : warn 2xx réduit à un booléen, corps amont supprimé', async () => {
  const t = await preparerDeplacement({
    reponse: { ok: true, status: 200, body: { warn: 'secret-amont', detail: 'secret-amont' } },
  });
  const r = await t.demander(deplacement);
  const fin = await t.oui(r.json().confirmation);
  expect(fin.envoi).toEqual({ code: 'succes', status: 200, avertissement: true });
  expect(JSON.stringify(fin)).not.toContain('secret-amont');
  expect(JSON.stringify(t.db.prepare('SELECT * FROM pda_demandes').all())).not.toContain(
    'secret-amont',
  );
  expect(JSON.stringify(t.journal.mock.calls)).not.toContain('secret-amont');
});
test('D293 : assignee changé au oui, demande périmée sans envoi', async () => {
  const t = await preparerDeplacement();
  const r = await t.demander(deplacement);
  const fiche = await t.board.card(42);
  if (fiche.card.ok) fiche.card.data.assignee = 'peer-b';
  t.card.mockClear();
  expect((await t.oui(r.json().confirmation)).resultat).toBe('perimee');
  expect(t.card).toHaveBeenCalledWith(42, { fresh: true, sansCache: true });
  expect(t.proxy.lignes).toEqual([]);
});
test('D293 : demande manuelle non assignée refusée sans envoi', async () => {
  const t = await preparerDeplacement();
  const fiche = await t.board.card(42);
  if (fiche.card.ok) fiche.card.data.assignee = null;
  t.card.mockClear();
  const r = await t.demander(deplacement);
  expect(r.statusCode).toBe(409);
  expect(r.json()).toEqual({ error: 'perime' });
  expect(t.card).toHaveBeenCalledWith(42, { fresh: true, sansCache: true });
  expect(t.db.prepare('SELECT * FROM pda_demandes').all()).toEqual([]);
  expect(t.proxy.lignes).toEqual([]);
});

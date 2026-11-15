import * as ecritures from '../src/shared/ecritures.js';
import * as transport from '../src/daemon/mesh/proxy.js';
import { creerActionsConfirmation } from '../src/daemon/confirmations/actions.js';
import { creerPorte } from '../src/daemon/confirmations/porte.js';
import { creerReglage } from '../src/daemon/confirmations/reglage.js';
import { FilePda } from '../src/daemon/pda/file.js';
import { assertionPda } from './helpers/pda.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, expect, test, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import { CreationsCartes } from '../src/daemon/confirmations/cartes.js';
import { creerActionEcriture } from '../src/daemon/confirmations/ecritures.js';
import type { ContexteAction } from '../src/daemon/confirmations/porte.js';
import { AidHttpError } from '../src/daemon/errors.js';
import { BoardReader } from '../src/daemon/mesh/board.js';
import { creerProxyClient, argumentsCreationValides } from '../src/daemon/mesh/proxy.js';
import { registerEcrituresRoutes } from '../src/daemon/routes/ecritures.js';
import {
  AVERTISSEMENT_CREATION,
  CREATION_EN_COURS,
  CREATION_INCERTAINE,
} from '../src/shared/ecritures.js';
import { creerFauxProxy } from './fixtures/faux-proxy.js';
import { preparerPda } from './helpers/pda.js';
import { startTestDaemon, waitFor } from './helpers/daemon.js';
import { migrate, openDb } from '../src/daemon/db.js';

const nettoyages: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of nettoyages.splice(0).reverse()) await f();
});
const params = {
  projet: 17,
  projetNom: 'Projet exemple',
  titre: 'Une carte',
  corps: 'Swairm: exemple/depot#sujet-1',
};
const entree = { action: 'carte.creer' as const, params };

async function contexte() {
  const t = preparerPda();
  nettoyages.push(t.nettoyer);
  let cartes: unknown[] = [];
  let lectureEnEchec = false;
  let creation: Record<string, unknown> = {
    ok: true,
    status: 201,
    body: { id: 99, body: 'privé', detail: 'privé', open_obligations: [1] },
  };
  let apresCreation = () => {};
  const proxy = await creerFauxProxy({
    traiter: ({ verb }) => {
      if (verb === 'board.projects.list')
        return { ok: true, status: 200, body: { projects: [{ id: 17, title: 'Projet exemple' }] } };
      if (verb === 'board.cards.list')
        return lectureEnEchec
          ? { ok: false, error: 'upstream_unreachable', detail: 'privé' }
          : { ok: true, status: 200, body: { cards: cartes } };
      if (verb === 'board.cards.create') {
        apresCreation();
        return creation;
      }
      return { ok: false, error: 'verb_not_allowed' };
    },
  });
  nettoyages.push(() => proxy.fermer());
  const config = {
    ...structuredClone(DEFAULT_CONFIG),
    mesh: {
      ...DEFAULT_CONFIG.mesh,
      cell: 'peer-a',
      gateway: 'https://example.com',
      proxySocket: proxy.socket,
    },
  };
  const board = new BoardReader({
    cell: 'peer-a',
    proxySocket: proxy.socket,
    mesh: {
      read: vi.fn(() => {
        throw new Error('aucun repli CLI');
      }),
    },
    log: () => {},
  });
  const vols = new CreationsCartes(t.db, () => config.mesh.proxySocket);
  const journal = vi.fn();
  const action = creerActionEcriture({ config, board, cartes: vols, journal });
  const ctx = (): ContexteAction => ({ confirmation: true, mesh: 'principal' });
  const preparer = () => action.preparer(entree, ctx());
  const envoyer = async () => {
    const c = ctx();
    await action.executer(await preparer(), c);
    return c.envoi;
  };
  const requetes = () => proxy.lignes.map((l) => JSON.parse(l));
  return {
    ...t,
    proxy,
    board,
    config,
    vols,
    action,
    journal,
    ctx,
    preparer,
    envoyer,
    requetes,
    cartes: (v: unknown[]) => {
      cartes = v;
    },
    echecLecture: (v: boolean) => {
      lectureEnEchec = v;
    },
    reponse: (v: Record<string, unknown>) => {
      creation = v;
    },
    apresCreation: (f: () => void) => {
      apresCreation = f;
    },
  };
}

test('préparation relit la liste, signe son nom, nettoie et normalise le titre', async () => {
  const t = await contexte();
  expect(
    await t.action.preparer({ ...entree, params: { ...params, titre: '  Une carte  ' } }, t.ctx()),
  ).toEqual(entree);
  expect(t.requetes().map((r) => r.verb)).toEqual(['board.projects.list']);
  for (const p of [
    { ...params, projet: 18 },
    { ...params, projetNom: 'Autre nom' },
  ])
    await expect(t.action.preparer({ ...entree, params: p }, t.ctx())).rejects.toMatchObject({
      status: 400,
    });
  expect(t.requetes().filter((r) => r.verb === 'board.projects.list')).toHaveLength(3);
  for (const champ of ['titre', 'corps'])
    await expect(
      t.action.preparer(
        {
          ...entree,
          params: {
            ...params,
            [champ]:
              champ === 'corps'
                ? params.corps + '\n\npassword=exemple-confidentiel'
                : 'password=exemple-confidentiel',
          },
        },
        t.ctx(),
      ),
    ).rejects.toMatchObject({ status: 422 });
});
test.each([
  ['', false, 'proxy_absent'],
  ['configure', true, 'proxy_lecture_seule'],
] as const)(
  'préparation sans proxy ou en lecture seule : 409 %s',
  async (socket, lectureSeule, message) => {
    const t = await contexte();
    t.config.mesh.proxySocket = socket;
    t.config.mesh.proxyLectureSeule = lectureSeule;
    await expect(t.preparer()).rejects.toMatchObject({ status: 409, message });
    expect(t.proxy.lignes).toEqual([]);
  },
);
test('création : lecture directe avant le POST, entier JSON, uniquement trois champs, seul id gardé', async () => {
  const t = await contexte();
  const resultat = await t.envoyer();
  expect(resultat).toMatchObject({
    code: 'succes',
    id: 99,
    open_obligations: [],
    cree: true,
    enVol: false,
  });
  expect(JSON.stringify(resultat)).not.toContain('privé');
  expect(t.vols.liste('principal')).toEqual([]);
  expect(t.requetes().map((r) => [r.verb, r.args])).toEqual([
    ['board.projects.list', {}],
    ['board.cards.list', { project: 17 }],
    ['board.cards.create', { project: 17, title: params.titre, body: params.corps }],
  ]);
  expect(JSON.stringify(t.journal.mock.calls)).not.toContain(params.titre);
  expect(JSON.stringify(t.journal.mock.calls)).not.toContain(params.corps);
});
test.each([
  'bad_args',
  'verb_not_allowed',
  'peer_not_allowed',
  'proxy_unavailable',
  'upstream_unreachable',
  'upstream_error',
] as const)('issue certaine %s : efface sans relecture', async (code) => {
  const t = await contexte();
  t.reponse({ ok: false, error: code, status: 403, detail: 'privé' });
  const r = await t.envoyer();
  expect(r).toMatchObject({ code, status: 403, enVol: false });
  expect(JSON.stringify(r)).not.toContain('privé');
  expect(t.vols.liste('principal')).toEqual([]);
  expect(t.requetes().filter((r) => r.verb === 'board.cards.list')).toHaveLength(1);
});
test('connexion refusée après vérification : certaine sans relecture', async () => {
  const t = await contexte();
  const lire = t.vols.lire.bind(t.vols);
  vi.spyOn(t.vols, 'lire').mockImplementation(async (...args) => {
    const r = await lire(...args);
    t.config.mesh.proxySocket = t.proxy.socket + '-absent';
    return r;
  });
  expect(await t.envoyer()).toMatchObject({ code: 'connexion', enVol: false });
  expect(t.vols.liste('principal')).toEqual([]);
});
test.each(['done', 'parked'])('carte %s trouvée avant envoi : aucun POST', async (stage) => {
  const t = await contexte();
  t.cartes([{ id: 55, body: 'Autre texte\n' + params.corps + '\nfin', stage }]);
  expect(await t.envoyer()).toMatchObject({
    code: 'succes',
    id: 55,
    cree: false,
    message: "Une carte porte déjà ce sujet : #55. Rien n'a été créé.",
  });
  expect(t.requetes().some((r) => r.verb === 'board.cards.create')).toBe(false);
  expect(t.vols.liste('principal')).toEqual([]);
});
test('relecture ne confond ni sous-chaîne, ni projet, ni sujet', async () => {
  const t = await contexte();
  t.cartes([
    { id: 55, body: params.corps + '0' },
    { id: 56, body: 'prefixe ' + params.corps },
    { id: 57, body: 'Swairm: autre/depot#sujet-1' },
  ]);
  expect(await t.envoyer()).toMatchObject({ id: 99, cree: true });
});
test('vérification préalable en échec : rien ne part et verrou effacé', async () => {
  const t = await contexte();
  t.echecLecture(true);
  expect(await t.envoyer()).toMatchObject({ code: 'proxy_unavailable', cree: false });
  expect(t.requetes().some((r) => r.verb === 'board.cards.create')).toBe(false);
  expect(t.vols.liste('principal')).toEqual([]);
});
test.each(['trouvee', 'absente', 'echec'] as const)(
  'envoi incertain : relecture %s',
  async (issue) => {
    const t = await contexte();
    t.reponse({ ok: false, error: 'upstream_ambiguous', detail: 'privé' });
    t.apresCreation(() => {
      expect(t.vols.liste('principal')[0]?.etat).toBe('en-vol');
      if (issue === 'trouvee') t.cartes([{ id: 99, body: params.corps, stage: 'done' }]);
      if (issue === 'echec') t.echecLecture(true);
    });
    const r = await t.envoyer();
    expect(r).toMatchObject({
      code: issue === 'trouvee' ? 'succes' : 'upstream_ambiguous',
      relecture: issue,
      enVol: issue === 'echec',
      message: CREATION_INCERTAINE,
    });
    if (issue === 'trouvee') expect(r).toMatchObject({ id: 99 });
    expect(t.vols.liste('principal')).toHaveLength(issue === 'echec' ? 1 : 0);
    if (issue === 'echec') {
      expect(t.vols.liste('principal')[0]?.etat).toBe('incertain');
      await expect(t.preparer()).rejects.toMatchObject({ status: 409, message: CREATION_EN_COURS });
      t.echecLecture(false);
      expect(await t.vols.relire('principal', params.corps)).toEqual({ ok: true, id: null });
      expect(t.vols.liste('principal')).toEqual([]);
    }
  },
);
test('deux créations concurrentes : verrou unique avant la lecture asynchrone', async () => {
  const t = await contexte();
  const p = await t.preparer();
  let terminer!: (v: { ok: true; id: null }) => void;
  const lecture = new Promise<{ ok: true; id: null }>((resolve) => {
    terminer = resolve;
  });
  vi.spyOn(t.vols, 'lire').mockReturnValue(lecture);
  const premiere = t.action.executer(p, t.ctx());
  expect(t.vols.liste('principal')).toHaveLength(1);
  await expect(t.action.executer(p, t.ctx())).rejects.toMatchObject({
    status: 409,
    message: CREATION_EN_COURS,
  });
  await expect(t.preparer()).rejects.toMatchObject({ status: 409, message: CREATION_EN_COURS });
  terminer({ ok: true, id: null });
  await premiere;
  expect(t.requetes().filter((r) => r.verb === 'board.cards.create')).toHaveLength(1);
});
test('verrou par mesh et sujet, indépendant du projet', async () => {
  const t = await contexte();
  t.vols.reserver('principal', params.corps, 17);
  expect(() => t.vols.reserver('principal', params.corps, 18)).toThrow(CREATION_EN_COURS);
  expect(() => t.vols.reserver('autre', params.corps, 17)).not.toThrow();
  expect(() => t.vols.reserver('principal', 'Swairm: exemple/depot#2', 17)).not.toThrow();
});
test('une réponse 2xx sans id reste certaine, sans relecture', async () => {
  const t = await contexte();
  t.reponse({ ok: true, status: 201, body: { detail: 'privé' } });
  expect(await t.envoyer()).toMatchObject({ code: 'format', enVol: false });
  expect(t.vols.liste('principal')).toEqual([]);
  expect(t.requetes().filter((r) => r.verb === 'board.cards.list')).toHaveLength(1);
});
test('relecture invalide conserve la ligne incertaine et ne masque pas une carte mal formée', async () => {
  const t = await contexte();
  t.vols.reserver('principal', params.corps, 17);
  t.vols.incertain('principal', params.corps);
  t.cartes([{ id: 4 }, { id: 99, body: params.corps }]);
  expect(await t.vols.relire('principal', params.corps)).toEqual({ ok: false });
  expect(t.vols.liste('principal')).toHaveLength(1);
});
test('relire ne libère jamais un envoi encore en cours', async () => {
  const t = await contexte();
  t.vols.reserver('principal', params.corps, 17);
  expect(await t.vols.relire('principal', params.corps)).toEqual({ ok: false });
  expect(t.vols.liste('principal')).toHaveLength(1);
  expect(t.proxy.lignes).toEqual([]);
});
test('schéma fermé avant toute connexion au proxy', async () => {
  const t = await contexte();
  const client = creerProxyClient({ socket: t.proxy.socket });
  for (const args of [
    { project: '17', title: 'titre', body: params.corps },
    { project: 17, title: 'titre', body: params.corps, actor: 'peer-a' },
    { project: 17, title: 'titre' },
  ]) {
    expect(argumentsCreationValides(args)).toBe(false);
    expect(await client.appeler('board.cards.create', args)).toEqual({
      ok: false,
      code: 'bad_args',
    });
  }
  expect(t.proxy.lignes).toEqual([]);
});

test('routes : aperçu, liste des verrous et relecture manuelle', async () => {
  const t = await contexte();
  const app = Fastify();
  nettoyages.push(() => app.close());
  app.setErrorHandler((e, _req, reply) =>
    reply.code(e instanceof AidHttpError ? e.status : 500).send({ error: (e as Error).message }),
  );
  registerEcrituresRoutes(app, { db: t.db, board: t.board, cell: 'peer-a', cartes: t.vols });
  const r = await app.inject({
    method: 'POST',
    url: '/api/swarph/ecrire/apercu',
    payload: { ...entree, mesh: 'principal' },
  });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toMatchObject({
    ok: true,
    argv: [],
    avertissement: AVERTISSEMENT_CREATION,
    lignes: ['Titre : Une carte', 'Projet : Projet exemple (#17)', 'Sujet : exemple/depot#sujet-1'],
  });
  t.vols.reserver('principal', params.corps, 17);
  t.vols.incertain('principal', params.corps);
  expect((await app.inject('/api/swarph/cartes-en-vol?mesh=principal')).json()).toHaveLength(1);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/swarph/cartes-en-vol/relire',
        payload: { mesh: 'principal', ligne: params.corps },
      })
    ).json(),
  ).toEqual({ ok: true, id: null });
  expect((await app.inject('/api/swarph/cartes-en-vol?mesh=principal')).json()).toEqual([]);
});

test.each([false, true])(
  'démarrage du vrai daemon : ligne en vol relue, échec=%s',
  async (echec) => {
    const home = mkdtempSync(join(tmpdir(), 'aid-creation-reprise-'));
    nettoyages.push(() => rmSync(home, { recursive: true, force: true }));
    const db = openDb(join(home, 'state.db'));
    db.prepare("INSERT INTO cartes_en_vol VALUES ('principal', ?, 17, 'en-vol', 'avant')").run(
      params.corps,
    );
    db.close();
    const proxy = await creerFauxProxy({
      traiter: () =>
        echec
          ? { ok: false, error: 'upstream_unreachable' }
          : {
              ok: true,
              status: 200,
              body: { cards: [{ id: 99, body: params.corps, stage: 'parked' }] },
            },
    });
    nettoyages.push(() => proxy.fermer());
    const daemon = await startTestDaemon(home, {
      config: {
        mesh: {
          ...DEFAULT_CONFIG.mesh,
          bin: join(import.meta.dirname, 'fixtures/fake-swarph.sh'),
          cell: 'peer-a',
          gateway: 'https://example.com',
          proxySocket: proxy.socket,
        },
      },
    });
    nettoyages.push(() => daemon.d.stop());
    await waitFor(() => proxy.lignes.some((l) => JSON.parse(l).verb === 'board.cards.list'));
    if (!echec)
      await waitFor(() => daemon.db.prepare('SELECT * FROM cartes_en_vol').all().length === 0);
    const lignes = daemon.db.prepare('SELECT * FROM cartes_en_vol').all();
    expect(lignes).toHaveLength(echec ? 1 : 0);
    if (echec) expect(lignes[0]).toMatchObject({ etat: 'incertain', depuis: 'avant' });
    expect(
      proxy.lignes.some((l) => {
        const r = JSON.parse(l);
        return r.verb === 'board.cards.list' && JSON.stringify(r.args) === '{"project":17}';
      }),
    ).toBe(true);
  },
);

test.each(['interrompu', 'delai', 'format'] as const)(
  'transport %s : relecture obligatoire après envoi',
  async (code) => {
    const t = await contexte();
    const origine = transport.creerProxyClient;
    vi.spyOn(transport, 'creerProxyClient').mockImplementation((options) => {
      const client = origine(options);
      return {
        appeler: (verbe, args) =>
          verbe === 'board.cards.create'
            ? Promise.resolve({ ok: false as const, code })
            : client.appeler(verbe, args),
      };
    });
    expect(await t.envoyer()).toMatchObject({
      code,
      relecture: 'absente',
      enVol: false,
      message: CREATION_INCERTAINE,
    });
    expect(t.requetes().filter((r) => r.verb === 'board.cards.list')).toHaveLength(2);
    expect(t.vols.liste('principal')).toEqual([]);
  },
);

async function avecPorte(t: Awaited<ReturnType<typeof contexte>>) {
  const appareil = await t.appareil();
  creerReglage(t.db).armer();
  let reponses: { id: string; appareil: string; corps: string; curseur: number }[] = [];
  const actions = creerActionsConfirmation({ ...t, cartes: t.vols });
  const porte = creerPorte({ db: t.db, config: t.config, actions, file: () => file });
  const file = new FilePda({
    ...t,
    actif: () => true,
    contexte: () => ({ origine: 'https://aid-e2e.ts.net', rpId: 'aid-e2e.ts.net' }),
    signaler: () => {},
    executer: (ligne) => porte.executerConfirmee(ligne),
    preparerConsommation: (ligne) => porte.preparerConsommation(ligne),
    relais: {
      publierAutorises: async () => true,
      publierResultat: async () => true,
      deposer: async () => true,
      retirer: async () => {},
      tirer: async () => reponses,
    },
  });
  nettoyages.push(() => file.arreter());
  const app = Fastify();
  nettoyages.push(() => app.close());
  app.addHook('onRequest', async (req) => {
    req.principal = { kind: 'admin', via: 'bearer' };
  });
  app.setErrorHandler((e, _req, reply) =>
    reply.code(e instanceof AidHttpError ? e.status : 500).send({ error: (e as Error).message }),
  );
  registerEcrituresRoutes(app, {
    db: t.db,
    board: t.board,
    cell: 'peer-a',
    cartes: t.vols,
    proxySocket: t.config.mesh.proxySocket,
    proxyLectureSeule: t.config.mesh.proxyLectureSeule,
    porte,
  });
  const demander = () =>
    app.inject({
      method: 'POST',
      url: '/api/swarph/ecrire/envoyer',
      payload: { ...entree, mesh: 'principal' },
    });
  const oui = async (id: string) => {
    const ligne = t.db
      .prepare('SELECT numero, numero_mac FROM pda_demandes WHERE id = ?')
      .get(id) as { numero: string; numero_mac: string };
    t.db.prepare('UPDATE pda_demandes SET numero = ? WHERE id = ?').run(ligne.numero_mac, id);
    const assertion = await assertionPda(t.db, id, appareil);
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
    return t.db.prepare('SELECT resultat, envoi FROM pda_demandes WHERE id = ?').get(id) as {
      resultat: string;
      envoi: string | null;
    };
  };
  return { demander, oui, app };
}
test('parcours complet : demande signée, aucun POST avant le oui, résultat limité à id', async () => {
  const t = await contexte();
  const p = await avecPorte(t);
  const demande = await p.demander();
  expect(demande.statusCode, demande.body).toBe(202);
  const id = demande.json().confirmation;
  const ligne = t.db
    .prepare('SELECT params, resume, classe FROM pda_demandes WHERE id = ?')
    .get(id) as { params: string; resume: string; classe: string };
  expect(JSON.parse(ligne.params)).toEqual(entree);
  expect(ligne.resume).toContain('Création de carte dans le projet #17');
  expect(ligne.classe).toBe('toujours');
  expect(t.requetes().some((r) => r.verb === 'board.cards.create')).toBe(false);
  const resultat = await p.oui(id);
  expect(resultat.resultat).toBe('executee');
  expect(JSON.parse(resultat.envoi!)).toMatchObject({ code: 'succes', id: 99 });
  expect(resultat.envoi).not.toContain('privé');
  expect(t.requetes().filter((r) => r.verb === 'board.projects.list')).toHaveLength(2);
  expect(t.requetes().filter((r) => r.verb === 'board.cards.create')).toHaveLength(1);
});
test.each(['nom relu', 'paramètres modifiés'])(
  'confirmation périmée si %s, aucune écriture',
  async (cas) => {
    const t = await contexte();
    const p = await avecPorte(t);
    const demande = await p.demander();
    expect(demande.statusCode, demande.body).toBe(202);
    const id = demande.json().confirmation;
    if (cas === 'nom relu')
      vi.spyOn(t.board, 'projects').mockResolvedValue({
        ok: true,
        data: [{ id: 17, title: 'Autre nom', slug: null, status: null, author: 'peer-a' }],
        schemaVersion: null,
        readAt: '',
      });
    else
      t.db
        .prepare('UPDATE pda_demandes SET params = ? WHERE id = ?')
        .run(JSON.stringify({ ...entree, params: { ...params, projetNom: 'Autre nom' } }), id);
    expect(await p.oui(id)).toMatchObject({ resultat: 'perimee', envoi: null });
    expect(t.requetes().some((r) => r.verb === 'board.cards.create')).toBe(false);
  },
);
test.each([false, true])(
  'route envoi refuse sans proxy ou en lecture seule avant demande : %s',
  async (lectureSeule) => {
    const t = await contexte();
    if (lectureSeule) t.config.mesh.proxyLectureSeule = true;
    else t.config.mesh.proxySocket = '';
    const p = await avecPorte(t);
    const r = await p.demander();
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe(lectureSeule ? 'proxy_lecture_seule' : 'proxy_absent');
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM pda_demandes').get()).toEqual({ n: 0 });
    expect(t.proxy.lignes).toEqual([]);
  },
);

test('migration 033 : données conservées, idempotence et états fermés', async () => {
  const t = await contexte();
  t.vols.reserver('principal', params.corps, 17);
  const avant = t.vols.liste('principal');
  expect(avant[0]).toMatchObject({
    mesh: 'principal',
    ligne_swairm: params.corps,
    projet: 17,
    etat: 'en-vol',
  });
  expect(Number.isNaN(Date.parse(avant[0]!.depuis))).toBe(false);
  migrate(t.db);
  expect(t.vols.liste('principal')).toEqual(avant);
  expect(() => t.db.prepare("UPDATE cartes_en_vol SET etat = 'inconnu'").run()).toThrow(/CHECK/);
  expect(() => t.db.prepare('UPDATE cartes_en_vol SET projet = 0').run()).toThrow(/CHECK/);
});
test('deux relectures concurrentes partagent une lecture et ne libèrent qu’après sa réussite', async () => {
  const t = await contexte();
  t.vols.reserver('principal', params.corps, 17);
  t.vols.incertain('principal', params.corps);
  let terminer!: (r: { ok: true; id: null }) => void;
  const attente = new Promise<{ ok: true; id: null }>((resolve) => {
    terminer = resolve;
  });
  const lire = vi.spyOn(t.vols, 'lire').mockReturnValue(attente);
  const a = t.vols.relire('principal', params.corps);
  const b = t.vols.relire('principal', params.corps);
  expect(a).toBe(b);
  expect(lire).toHaveBeenCalledTimes(1);
  expect(t.vols.liste('principal')).toHaveLength(1);
  terminer({ ok: true, id: null });
  await a;
  expect(t.vols.liste('principal')).toEqual([]);
});

test('démarrage non bloquant : state répond pendant une relecture silencieuse, verrou incertain', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aid-creation-silence-'));
  nettoyages.push(() => rmSync(home, { recursive: true, force: true }));
  const db = openDb(join(home, 'state.db'));
  db.prepare("INSERT INTO cartes_en_vol VALUES ('principal', ?, 17, 'en-vol', 'avant')").run(
    params.corps,
  );
  db.close();
  const proxy = await creerFauxProxy('silence');
  nettoyages.push(() => proxy.fermer());
  const daemon = await startTestDaemon(home, {
    config: {
      mesh: {
        ...DEFAULT_CONFIG.mesh,
        bin: join(import.meta.dirname, 'fixtures/fake-swarph.sh'),
        cell: 'peer-a',
        gateway: 'https://example.com',
        proxySocket: proxy.socket,
      },
    },
  });
  nettoyages.push(() => daemon.d.stop());
  await waitFor(() => proxy.lignes.some((l) => JSON.parse(l).verb === 'board.cards.list'));
  const reponse = await daemon.d.app.inject({ url: '/api/state', headers: daemon.headers });
  expect(reponse.statusCode).toBe(200);
  expect(proxy.connexionsActives).toBeGreaterThan(0);
  expect(daemon.db.prepare('SELECT etat, depuis FROM cartes_en_vol').get()).toEqual({
    etat: 'incertain',
    depuis: 'avant',
  });
});

test('exception après réservation et avant envoi : verrou effacé, aucun POST', async () => {
  const t = await contexte();
  const p = await t.preparer();
  vi.spyOn(ecritures, 'argsProxy').mockImplementationOnce(() => {
    throw new Error('échec avant envoi');
  });
  await expect(t.action.executer(p, t.ctx())).rejects.toThrow('échec avant envoi');
  expect(t.vols.liste('principal')).toEqual([]);
  expect(t.requetes().filter((r) => r.verb === 'board.cards.create')).toEqual([]);
});

test('exception après envoi et avant classement : passage incertain et relecture immédiate', async () => {
  const t = await contexte();
  t.reponse({ ok: false, error: 'upstream_ambiguous' });
  t.apresCreation(() => t.echecLecture(true));
  vi.spyOn(ecritures, 'messageCreation').mockImplementationOnce(() => {
    throw new Error('échec après envoi');
  });
  const incertain = vi.spyOn(t.vols, 'incertain');
  const relire = vi.spyOn(t.vols, 'relire');
  await expect(t.envoyer()).rejects.toThrow('échec après envoi');
  expect(incertain).toHaveBeenCalledWith('principal', params.corps);
  expect(relire).toHaveBeenCalledWith('principal', params.corps);
  expect(t.vols.liste('principal')[0]?.etat).toBe('incertain');
  expect(t.requetes().filter((r) => r.verb === 'board.cards.list')).toHaveLength(2);
  expect(t.requetes().filter((r) => r.verb === 'board.cards.create')).toHaveLength(1);
});

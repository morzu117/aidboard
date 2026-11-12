import { RAISON_BASELINE_ABSENT } from '../src/shared/avis-mesh-api.js';
import type { ParamsAction, MeshSigne } from '../src/shared/pda.js';
import { charterAvis, citerQuestion } from '../src/shared/charter-avis.js';
import { echeancesAvisParDefaut } from '../src/shared/avis-mesh-api.js';
import { verifierCibleMesh } from '../src/daemon/mesh/cible-ecriture.js';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, expect, test, vi } from 'vitest';
import { DEFAULT_CONFIG, type AidConfig } from '../src/daemon/config.js';
import { EventStore } from '../src/daemon/events/store.js';
import { MeshRegistry } from '../src/daemon/mesh/registre.js';
import { creerPorte } from '../src/daemon/confirmations/porte.js';
import { creerActionsConfirmation } from '../src/daemon/confirmations/actions.js';
import { creerReglage } from '../src/daemon/confirmations/reglage.js';
import { FilePda, type LigneDemande } from '../src/daemon/pda/file.js';
import { registerEcrituresRoutes } from '../src/daemon/routes/ecritures.js';
import { registerAvisMeshRoutes } from '../src/daemon/routes/avis-mesh.js';
import { AidHttpError } from '../src/daemon/errors.js';
import {
  jsonCanonique,
  lireCorpsDemande,
  resumeAction,
  type CorpsDemandeV3,
} from '../src/shared/pda.js';
import { preparerPda } from './helpers/pda.js';
import { creerFauxProxy } from './fixtures/faux-proxy.js';

const nettoyages: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of nettoyages.splice(0).reverse()) await f();
});
const ecriture = {
  action: 'dm.envoyer',
  params: { pair: 'perso', fil: null, kind: 'fyi', texte: 'Bonjour' },
} as const;
async function contexte(cli = false) {
  const t = preparerPda();
  nettoyages.push(t.nettoyer);
  const proxies = await Promise.all(
    ['principal', 'perso'].map(async () => {
      const p = await creerFauxProxy({
        reponse: {
          ok: true,
          status: 201,
          body: { id: 1, open_obligations: [], closed_obligations: [] },
        },
      });
      nettoyages.push(() => p.fermer());
      return p;
    }),
  );
  const config: AidConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    mesh: { ...DEFAULT_CONFIG.mesh, bin: process.execPath },
    meshes: Object.fromEntries(
      ['principal', 'perso'].map((nom, i) => [
        nom,
        {
          ...DEFAULT_CONFIG.mesh,
          cell: 'principal',
          home: `/tmp/aid-46-${nom}`,
          gateway: `http://${nom}.example.com`,
          proxySocket: cli ? '' : proxies[i]!.socket,
        },
      ]),
    ),
  };
  const store = new EventStore(t.db);
  const appelsCli: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const registre = new MeshRegistry({
    config,
    db: t.db,
    store,
    log: () => {},
    exec: async (_bin, args, opts) => {
      appelsCli.push({ args, env: opts.env });
      return {
        ok: true,
        timedOut: false,
        stderr: '',
        stdout: JSON.stringify(
          args[0] === 'committee' && args[1] === 'rooms' ? { channel: 'avis-test' } : { id: 1 },
        ),
      };
    },
  });
  nettoyages.push(() => registre.dispose());
  await registre.init();
  // 46.6 : finir la lecture initiale en arrière-plan avant de compter les écritures.
  await Promise.all(['principal', 'perso'].map((nom) => registre.obtenir(nom).mesh.refresh()));
  appelsCli.length = 0;
  for (const nom of ['principal', 'perso']) {
    vi.spyOn(registre.obtenir(nom).swarph, 'peers').mockResolvedValue({
      ok: true,
      data: [
        { nom: 'principal', version: '' },
        { nom: 'perso', version: '' },
      ],
      readAt: '',
      schemaVersion: null,
    });
  }
  let enveloppe: { corps: string; sig: string } | undefined;
  const file = new FilePda({
    ...t,
    relais: {
      publierAutorises: async () => true,
      publierResultat: async () => true,
      deposer: async (_id, e) => {
        enveloppe = e;
        return true;
      },
      retirer: async () => {},
      tirer: async () => [],
    },
    actif: () => true,
    contexte: () => ({ origine: 'https://aid-e2e.ts.net', rpId: 'aid-e2e.ts.net' }),
    signaler: () => {},
  });
  nettoyages.push(() => file.arreter());
  const portePour = (meshes = registre) =>
    creerPorte({
      db: t.db,
      meshes,
      actions: creerActionsConfirmation({ db: t.db, config, meshes }),
      file: () => file,
    });
  const porte = portePour();
  creerReglage(t.db).armer();
  await t.appareil();
  const app = Fastify();
  nettoyages.push(() => app.close());
  app.addHook('preHandler', async (req) => {
    req.principal = { kind: 'admin', via: 'bearer' };
  });
  app.setErrorHandler((e, _req, reply) =>
    reply.code(e instanceof AidHttpError ? e.status : 500).send({ error: (e as Error).message }),
  );
  registerEcrituresRoutes(app, { db: t.db, meshes: registre, cell: '', board: null, porte });
  registerAvisMeshRoutes(app, { meshes: registre, avis: null, porte });
  const demander = async (mesh = 'perso') => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/swarph/ecrire/envoyer',
      payload: { ...ecriture, mesh },
    });
    expect(r.statusCode, r.body).toBe(202);
    return r.json().confirmation as string;
  };
  const ligne = (id: string) =>
    t.db
      .prepare(
        "SELECT id, action, params, classe, CASE WHEN classe = 'toujours' THEN NULL ELSE numero END AS numero, numero_mac, h_demande AS hDemande, echeance FROM pda_demandes WHERE id = ?",
      )
      .get(id) as LigneDemande;
  const issue = (id: string) =>
    t.db.prepare('SELECT resultat, raison FROM pda_demandes WHERE id = ?').get(id);
  return {
    ...t,
    config,
    appelsCli,
    store,
    registre,
    proxies,
    file,
    porte,
    portePour,
    app,
    demander,
    ligne,
    issue,
    corps: () => lireCorpsDemande(Buffer.from(enveloppe!.corps, 'base64url')) as CorpsDemandeV3,
  };
}

test('deux proxies : seule la destination signée reçoit une écriture ; stockage canonique', async () => {
  const t = await contexte();
  const id = await t.demander();
  expect(t.corps()).toMatchObject({
    v: 3,
    mesh: { nom: 'perso' },
    resume: '[perso] DM fyi à perso',
  });
  expect(t.db.prepare('SELECT mesh FROM pda_demandes WHERE id = ?').get(id)).toEqual({
    mesh: jsonCanonique(t.registre.signature('perso')),
  });
  await t.porte.executerConfirmee(t.ligne(id));
  expect(t.issue(id)).toEqual({ resultat: 'executee', raison: null });
  expect(t.proxies[0]!.lignes).toHaveLength(0);
  expect(t.proxies[1]!.lignes.map((s) => JSON.parse(s).verb)).toEqual(['mesh.send']);
});
for (const champ of ['cell', 'gateway', 'proxySocket'] as const) {
  test(`périmée : ${champ} changé après signature`, async () => {
    const t = await contexte();
    const id = await t.demander();
    t.registre.configuration('perso')[champ] =
      champ === 'gateway'
        ? 'http://gateway.example.com'
        : champ === 'cell'
          ? 'perso'
          : '/tmp/autre.sock';
    await t.porte.executerConfirmee(t.ligne(id));
    expect(t.issue(id)).toEqual({ resultat: 'perimee', raison: 'perime' });
    expect(t.proxies.flatMap((p) => p.lignes)).toHaveLength(0);
  });
}
for (const cas of ['retire', 'inactif'] as const) {
  test(`périmée : mesh ${cas} après signature`, async () => {
    const t = await contexte();
    const id = await t.demander();
    const config = structuredClone(t.config);
    if (cas === 'retire') delete config.meshes.perso;
    else config.meshes.perso!.cell = '';
    const registre = new MeshRegistry({ config, db: t.db, store: t.store, log: () => {} });
    nettoyages.push(() => registre.dispose());
    await t.portePour(registre).executerConfirmee(t.ligne(id));
    expect(t.issue(id)).toEqual({ resultat: 'perimee', raison: 'perime' });
    expect(t.proxies.flatMap((p) => p.lignes)).toHaveLength(0);
  });
}
for (const cas of ['nom', 'cell', 'gateway', 'proxy', 'null', 'json'] as const) {
  test(`périmée : colonne mesh altérée (${cas})`, async () => {
    const t = await contexte();
    const id = await t.demander();
    const mesh = t.corps().mesh;
    const valeur =
      cas === 'null'
        ? null
        : cas === 'json'
          ? '{'
          : jsonCanonique({
              ...mesh,
              [cas]: cas === 'nom' ? 'principal' : cas === 'cell' ? 'perso' : 'A'.repeat(43),
            });
    t.db.prepare('UPDATE pda_demandes SET mesh = ? WHERE id = ?').run(valeur, id);
    await t.porte.executerConfirmee(t.ligne(id));
    expect(t.issue(id)).toEqual({ resultat: 'perimee', raison: 'perime' });
    expect(t.proxies.flatMap((p) => p.lignes)).toHaveLength(0);
  });
}
test('gateway explicite : création refusée avec 409 gateway_requis', async () => {
  const t = await contexte();
  t.registre.configuration('perso').gateway = '';
  const r = await t.app.inject({
    method: 'POST',
    url: '/api/swarph/ecrire/envoyer',
    payload: { ...ecriture, mesh: 'perso' },
  });
  expect(r.statusCode).toBe(409);
  expect(r.json()).toEqual({ error: 'gateway_requis' });
  expect(t.db.prepare('SELECT COUNT(*) AS n FROM pda_demandes').get()).toEqual({ n: 0 });
});
test('gateway explicite : demande périmée après retrait du gateway', async () => {
  const t = await contexte();
  const id = await t.demander();
  t.registre.configuration('perso').gateway = '';
  await t.porte.executerConfirmee(t.ligne(id));
  expect(t.issue(id)).toEqual({ resultat: 'perimee', raison: 'perime' });
  expect(t.proxies.flatMap((p) => p.lignes)).toHaveLength(0);
});
test('transition : v2 ouverte sur principal, jamais perso', async () => {
  const t = await contexte();
  const id = await t.demander();
  const commun = { ...t.corps() };
  delete (commun as Partial<CorpsDemandeV3>).mesh;
  const corps = { ...commun, v: 2, resume: resumeAction('mesh.ecrire', ecriture) };
  const h = createHash('sha256').update(jsonCanonique(corps)).digest('base64url');
  t.db
    .prepare('UPDATE pda_demandes SET mesh = NULL, resume = ?, h_demande = ? WHERE id = ?')
    .run(corps.resume, h, id);
  await t.porte.executerConfirmee(t.ligne(id));
  expect(t.issue(id)).toEqual({ resultat: 'executee', raison: null });
  expect(t.proxies[0]!.lignes).toHaveLength(1);
  expect(t.proxies[1]!.lignes).toHaveLength(0);
});
for (const url of [
  '/api/swarph/ecrire/apercu',
  '/api/swarph/ecrire/envoyer',
  '/api/swarph/etat/envoyer',
  '/api/avis-mesh',
  '/api/avis-mesh/20261112T120000Z-abcd/motion',
  '/api/avis-mesh/20261112T120000Z-abcd/baseline-absent',
]) {
  test(`route ${url} : mesh requis, inconnu et inactif`, async () => {
    const t = await contexte();
    for (const [mesh, code] of [
      [undefined, 400],
      ['inconnu', 404],
      ['perso', 409],
    ] as const) {
      if (code === 409)
        vi.spyOn(t.registre, 'signature').mockImplementation(() => {
          throw new AidHttpError(409, 'rebranche');
        });
      const r = await t.app.inject({
        method: 'POST',
        url,
        headers: { 'x-aid-confirm': 'avis' },
        payload: { ...ecriture, ...(mesh && { mesh }) },
      });
      expect(r.statusCode, r.body).toBe(code);
      if (!mesh) expect(r.json()).toEqual({ error: 'mesh_requis' });
    }
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM pda_demandes').get()).toEqual({ n: 0 });
  });
}
test('cible pair absente du mesh choisi : refus création puis périmée si elle disparaît', async () => {
  const t = await contexte();
  const id = await t.demander();
  vi.mocked(t.registre.obtenir('perso').swarph.peers).mockResolvedValue({
    ok: true,
    data: [],
    readAt: '',
    schemaVersion: null,
  });
  const r = await t.app.inject({
    method: 'POST',
    url: '/api/swarph/ecrire/envoyer',
    payload: { ...ecriture, mesh: 'perso' },
  });
  expect(r.statusCode).toBe(409);
  await t.porte.executerConfirmee(t.ligne(id));
  expect(t.issue(id)).toEqual({ resultat: 'perimee', raison: 'perime' });
  expect(t.proxies.flatMap((p) => p.lignes)).toHaveLength(0);
});

test('avis : SQL, citation et CLI restent dans le mesh de la salle ; environnement propre', async () => {
  const t = await contexte(true);
  const echeances = echeancesAvisParDefaut();
  for (const [nom, carte, jeton] of [
    ['principal', 101, 'abcdef01'],
    ['perso', 102, 'abcdef02'],
  ] as const) {
    const services = t.registre.obtenir(nom);
    const id = nom === 'principal' ? '20261112T120000Z-abcd' : '20261112T120000Z-abce';
    const p = {
      id,
      nom: 'avis-test',
      question: 'Question',
      sieges: [],
      carte,
      jeton,
      echeances,
      texte: citerQuestion('Question', jeton),
      charter: charterAvis({ carte, jeton, nbSousQuestions: 1 }),
    };
    services.avis.enregistrer(p);
    services.avis.lierConfirmation(id, `confirmation-${nom}`);
    const card = vi.spyOn(services.board, 'card').mockImplementation(
      async (numero) =>
        ({
          card: { ok: numero === carte, data: {}, readAt: '', schemaVersion: null },
        }) as never,
    );
    await verifierCibleMesh(services, { action: 'mesh.avis', params: { params: p } });
    await expect(
      verifierCibleMesh(services, {
        action: 'mesh.avis',
        params: { params: { ...p, carte: carte === 101 ? 102 : 101 } },
      }),
    ).rejects.toThrow('perime');
    expect(card).toHaveBeenCalledWith(carte, { fresh: true, sansCache: true });
    if (nom === 'perso') {
      expect(() => t.registre.obtenir('principal').avis.ligne(id)).toThrow('demande inconnue');
      await services.avis.ouvrir(p);
      const ligne = services.avis.ligne(id);
      expect(ligne).toMatchObject({
        carte: 102,
        etat: 'ouverte',
        confirmation: 'confirmation-perso',
      });
      expect(t.registre.obtenir('principal').avis.ligne('20261112T120000Z-abcd')).toMatchObject({
        carte: 101,
        etat: 'confirmation',
        confirmation: 'confirmation-principal',
      });
      expect(t.appelsCli).toHaveLength(2);
      expect(t.appelsCli[0]!.args).toContain('102');
      expect(t.appelsCli[1]!.args).toContain(citerQuestion('Question', 'abcdef02'));
      for (const appel of t.appelsCli) {
        expect(appel.env).toMatchObject({
          HOME: '/tmp/aid-46-perso',
          SWARPH_SELF: 'principal',
          MESH_GATEWAY_URL: 'http://perso.example.com',
        });
        expect(appel.env).not.toHaveProperty('MESH_GATEWAY_TOKEN');
      }
    }
  }
});

for (const action of ['mesh.avis', 'mesh.avis.motion', 'mesh.avis.baseline-absent'] as const) {
  test(`porte ${action} : relecture et exécution uniquement avec le service signé`, async () => {
    const t = await contexte(true);
    const p = {
      id: '20261112T120000Z-abcd',
      nom: 'avis-test',
      question: 'Question',
      carte: 102,
      sieges: [],
      echeances: echeancesAvisParDefaut(),
      jeton: 'abcdef01',
      charter: 'Charter',
      texte: 'Question',
    };
    const motion = { id: p.id, canal: 'avis-test', texte: p.texte, echeances: p.echeances };
    const absence = { id: p.id, canal: 'avis-test', motion: 1, raison: RAISON_BASELINE_ABSENT };
    const services = t.registre.obtenir('perso');
    const principal = t.registre.obtenir('principal');
    vi.spyOn(services.board, 'card').mockResolvedValue({ card: { ok: true } } as never);
    const verifier = vi.spyOn(services.avis, 'verifier').mockReturnValue(p);
    const preparerMotion = vi.spyOn(services.avis, 'preparerMotion').mockReturnValue(motion);
    const verifierAbsence = vi.spyOn(services.avis, 'verifierAbsence').mockResolvedValue(absence);
    const ouvrir = vi.spyOn(services.avis, 'ouvrir').mockResolvedValue();
    const reprendre = vi.spyOn(services.avis, 'reprendreMotion').mockResolvedValue();
    const absent = vi.spyOn(services.avis, 'declarerAbsent').mockResolvedValue();
    const autres = [
      vi.spyOn(principal.avis, 'verifier'),
      vi.spyOn(principal.avis, 'ouvrir'),
      vi.spyOn(principal.avis, 'preparerMotion'),
      vi.spyOn(principal.avis, 'reprendreMotion'),
      vi.spyOn(principal.avis, 'verifierAbsence'),
      vi.spyOn(principal.avis, 'declarerAbsent'),
    ];
    const params =
      action === 'mesh.avis'
        ? {
            params: {
              id: p.id,
              nom: p.nom,
              carte: p.carte,
              sieges: p.sieges,
              echeances: p.echeances,
              texte: p.texte,
            },
          }
        : action === 'mesh.avis.motion'
          ? { params: motion }
          : { params: absence };
    const { id } = await t.file.creerDemande({
      action,
      params,
      mesh: t.registre.signature('perso'),
    } as ParamsAction & { mesh: MeshSigne });
    await t.porte.executerConfirmee(t.ligne(id));
    expect(t.issue(id)).toEqual({ resultat: 'executee', raison: null });
    expect(
      action === 'mesh.avis'
        ? verifier
        : action === 'mesh.avis.motion'
          ? preparerMotion
          : verifierAbsence,
    ).toHaveBeenCalled();
    expect(
      action === 'mesh.avis' ? ouvrir : action === 'mesh.avis.motion' ? reprendre : absent,
    ).toHaveBeenCalledOnce();
    for (const autre of autres) expect(autre).not.toHaveBeenCalled();
  });
}

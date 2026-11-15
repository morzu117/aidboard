import { signatureMesh } from '../src/daemon/mesh/ecriture.js';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { afterEach, expect, test, vi } from 'vitest';
import {
  siegesAvis,
  RAISON_BASELINE_ABSENT,
  echeancesAvisParDefaut,
  validerEcheancesAvis,
} from '../src/shared/avis-mesh-api.js';
import {
  CommitteeReader,
  CommitteeWriter,
  VERBES_COMMITTEE_ECRITURE,
} from '../src/daemon/mesh/committee.js';
import { VERBES_PROXY } from '../src/daemon/mesh/proxy.js';
import { meshExec } from '../src/daemon/mesh/exec.js';
import { AvisMeshService } from '../src/daemon/mesh/avis.js';
import { DEFAULT_CONFIG, parseConfig } from '../src/daemon/config.js';
import { openDb } from '../src/daemon/db.js';
import { registerAvisMeshRoutes } from '../src/daemon/routes/avis-mesh.js';
import { creerActionsAvis } from '../src/daemon/confirmations/avis.js';
import { creerActionsConfirmation } from '../src/daemon/confirmations/actions.js';
import { creerPorte, type Porte } from '../src/daemon/confirmations/porte.js';
import { AidHttpError } from '../src/daemon/errors.js';
import { jsonCanonique, resumeAction } from '../src/shared/pda.js';
import { preparerPda } from './helpers/pda.js';

const nettoyage: (() => unknown)[] = [];
afterEach(() => {
  for (const f of nettoyage.splice(0).reverse()) f();
});
const familles = { aid: 'grok', lab: 'claude', alpha: 'gemini', beta: 'gpt' };
const config = {
  ...DEFAULT_CONFIG.mesh,
  cell: 'aid',
  gateway: 'http://gateway.example.com',
  avis: { baseline: 'lab', familles },
};
const entree = { cellAid: 'aid', baseline: 'lab', cells: ['alpha', 'beta'], familles };
const echeances = () => echeancesAvisParDefaut();
const demande = () => ({
  question: 'Faut-il continuer ?',
  cells: ['alpha', 'beta'],
  carte: 42,
  echeances: echeances(),
});

test('sièges ordonnés, chair et baseline compris', () => {
  expect(siegesAvis(entree)).toEqual([
    { peer: 'aid', role: 'chair', family: 'orchestrator' },
    { peer: 'lab', role: 'baseline', family: 'claude' },
    { peer: 'alpha', role: 'seat', family: 'gemini' },
    { peer: 'beta', role: 'seat', family: 'gpt' },
  ]);
});
test.each([
  [{ ...entree, baseline: undefined }, /baseline/],
  [{ ...entree, cells: ['alpha'] }, /2 à 8/],
  [{ ...entree, cells: Array(9).fill('alpha') }, /2 à 8/],
  [{ ...entree, cells: ['alpha', 'alpha'] }, /alpha/],
  [{ ...entree, cells: ['aid', 'beta'] }, /aid/],
  [{ ...entree, cells: ['lab', 'beta'] }, /lab/],
  [{ ...entree, baseline: 'aid' }, /aid/],
  [{ ...entree, familles: { ...familles, beta: '' } }, /beta/],
  [{ ...entree, familles: { ...familles, beta: 'x'.repeat(65) } }, /beta/],
  [{ ...entree, familles: { ...familles, beta: 'gemini' } }, /alpha, beta/],
  [{ ...entree, familles: { ...familles, lab: 'orchestrator' } }, /lab/],
  [{ ...entree, familles: { ...familles, alpha: 'claude' } }, /lab, alpha/],
] as const)('sièges : refus %#', (d, erreur) => {
  expect(() => siegesAvis(d)).toThrow(erreur);
});

test('config sans baseline par défaut ; familles bornées', () => {
  expect(parseConfig('').mesh.avis?.baseline).toBeUndefined();
  expect(
    parseConfig('mesh:\n  avis:\n    baseline: lab\n    familles:\n      lab: Claude\n').mesh.avis,
  ).toEqual({ baseline: 'lab', familles: { lab: 'claude' } });
  for (const famille of ['""', '" "', 'x'.repeat(65), '42', 'autre', 'orchestrator'])
    expect(() => parseConfig(`mesh:\n  avis:\n    familles:\n      alpha: ${famille}\n`)).toThrow(
      /famille/,
    );
});

function faux() {
  const dossier = mkdtempSync(join(tmpdir(), 'avis-envoi-'));
  nettoyage.push(() => rmSync(dossier, { recursive: true, force: true }));
  const bin = join(dossier, 'swarph');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'committee' || !args.includes('--as')) process.exit(8);
if (process.env.ECHEC && args.includes(process.env.ECHEC)) { console.error(process.env.DETAIL_ECHEC); process.exit(1); }
if (args[1] === 'rooms') console.log(JSON.stringify({channel:'avis-test'}));
else if (args.includes('--open')) console.log(JSON.stringify({id:42}));
else if (args[1] === 'motion') console.log(JSON.stringify({motions: []}));
else if (args[1] === 'results') console.log(process.env.RESULTATS);
`,
    { mode: 0o755 },
  );
  let echec = '';
  let detailEchec = 'échec simulé';
  let resultats = {
    channel: 'avis-test',
    card_id: 1,
    baseline_absent: null as { reason: string; by: string; at: string } | null,
    positions_absent: [] as string[],
    id: 42,
    text: 'Question',
    options: ['avis', 'objection'],
    phase: 'positions',
    positions_deadline: new Date(Date.now() - 10000).toISOString(),
    rebuttal_deadline: '2026-11-13T13:00:00Z',
    vote_deadline: '2026-11-13T14:00:00Z',
    seats: [
      { peer: 'aid', role: 'chair', family: 'orchestrator' },
      { peer: 'lab', role: 'baseline', family: 'claude' },
      { peer: 'alpha', role: 'seat', family: 'gemini' },
      { peer: 'beta', role: 'seat', family: 'gpt' },
    ].map((s) => ({ ...s, voided: false, recast_from: null as string | null })),
    ballots: [] as unknown[],
  };
  const appels: string[][] = [];
  const fichiers: { chemin: string; contenu: string; mode: number }[] = [];
  const read = vi.fn(async (args: string[]) => {
    appels.push(args);
    for (const flag of ['--charter-file', '--seats-file']) {
      const i = args.indexOf(flag);
      if (i >= 0)
        fichiers.push({
          chemin: args[i + 1]!,
          contenu: readFileSync(args[i + 1]!, 'utf8'),
          mode: statSync(args[i + 1]!).mode & 0o777,
        });
    }
    return meshExec(bin, args, {
      env: {
        ...process.env,
        AID_HOME: dossier,
        RESULTATS: JSON.stringify(resultats),
        ECHEC: echec,
        DETAIL_ECHEC: detailEchec,
      },
      timeoutMs: 3000,
    });
  });
  const deps = { mesh: { read }, cell: 'aid' };
  const db = openDb(join(dossier, 'state.db'));
  nettoyage.push(() => db.close());
  const lecteur = new CommitteeReader(deps);
  const ecrivain = new CommitteeWriter(deps);
  const avis = new AvisMeshService({ db, config: structuredClone(config), lecteur, ecrivain });
  return {
    dossier,
    db,
    avis,
    deps,
    lecteur,
    ecrivain,
    appels,
    fichiers,
    echouer: (flag: string, detail = 'échec simulé') => {
      echec = flag;
      detailEchec = detail;
    },
    resultats: () => resultats,
    changer: (v: typeof resultats) => {
      resultats = v;
    },
  };
}

test.each([false, true])(
  'faux swarph : ouverture salle, argv et fichiers 0600 supprimés (échec %s)',
  async (echec) => {
    const t = faux();
    if (echec) t.echouer('rooms');
    const p = t.avis.preparer(demande());
    const appel = t.ecrivain.ouvrirSalle(p);
    if (echec) await expect(appel).rejects.toThrow();
    else expect(await appel).toBe('avis-test');
    expect(t.appels[0]).toEqual([
      'committee',
      'rooms',
      'open',
      '--name',
      p.nom,
      '--charter-file',
      t.fichiers[0]!.chemin,
      '--card-id',
      '42',
      '--seats-file',
      t.fichiers[1]!.chemin,
      '--json',
      '--as',
      'aid',
    ]);
    expect(t.fichiers[0]!.contenu).toContain(`QUESTION-${p.jeton}`);
    expect(JSON.parse(t.fichiers[1]!.contenu)).toEqual(siegesAvis(entree));
    for (const f of t.fichiers) {
      expect(f.mode).toBe(0o600);
      expect(existsSync(f.chemin)).toBe(false);
    }
  },
);

test('faux swarph : motion active et baseline-absent, argv exacts', async () => {
  const t = faux();
  const e = {
    positions: '2026-11-13T12:00:00Z',
    rebuttal: '2026-11-14T12:00:00Z',
    vote: '2026-11-15T12:00:00Z',
  };
  expect(
    await t.ecrivain.ouvrirMotion({ canal: 'avis-test', texte: 'Question citée', echeances: e }),
  ).toBe(42);
  await t.ecrivain.baselineAbsent({ canal: 'avis-test', raison: RAISON_BASELINE_ABSENT });
  expect(t.appels).toEqual([
    [
      'committee',
      'motion',
      'avis-test',
      '--open',
      '--text',
      'Question citée',
      '--options',
      'avis,objection',
      '--positions-deadline',
      e.positions,
      '--rebuttal-deadline',
      e.rebuttal,
      '--vote-deadline',
      e.vote,
      '--json',
      '--as',
      'aid',
    ],
    [
      'committee',
      'baseline-absent',
      'avis-test',
      '--reason',
      RAISON_BASELINE_ABSENT,
      '--as',
      'aid',
    ],
  ]);
  await t.ecrivain.ouvrirMotion({
    canal: 'avis-test',
    texte: 'Q',
    echeances: e,
  });
  expect(t.appels.at(-1)).toContain('--vote-deadline');
  expect(t.appels.at(-1)).toContain('--rebuttal-deadline');
  await expect(t.ecrivain.baselineAbsent({ canal: '../canal', raison: 'non' })).rejects.toThrow(
    /canal/,
  );
});

test('proxy non relayé : aucun lancement, aucun repli', async () => {
  const t = faux();
  const writer = new CommitteeWriter({ ...t.deps, proxySocket: '/tmp/proxy-test.sock' });
  const p = t.avis.preparer(demande());
  await expect(writer.ouvrirSalle(p)).rejects.toThrow('non relayé par le proxy');
  await expect(
    writer.ouvrirMotion({ canal: 'avis-test', texte: p.texte, echeances: p.echeances }),
  ).rejects.toThrow('non relayé');
  await expect(
    writer.baselineAbsent({ canal: 'avis-test', raison: RAISON_BASELINE_ABSENT }),
  ).rejects.toThrow('non relayé');
  expect(t.deps.mesh.read).not.toHaveBeenCalled();
  for (const verbe of VERBES_COMMITTEE_ECRITURE) expect(VERBES_PROXY).not.toContain(verbe);
});

test('salle-sans-motion : canal conservé, aucun nouvel essai', async () => {
  const t = faux();
  const p = t.avis.preparer(demande());
  t.avis.enregistrer(p);
  t.echouer('--open');
  await expect(t.avis.ouvrir(p)).rejects.toThrow();
  expect(t.avis.ligne(p.id)).toMatchObject({
    etat: 'salle-sans-motion',
    canal: 'avis-test',
    motion: null,
  });
  await expect(t.avis.ouvrir(p)).rejects.toThrow('déjà exécutée');
  expect(t.appels).toHaveLength(2);
});

async function ouverte() {
  const t = faux();
  const p = t.avis.preparer(demande());
  t.avis.enregistrer(p);
  await t.avis.ouvrir(p);
  return { ...t, p };
}

test.each(['rebuttal', 'vote', 'closed', 'positions-avant'])(
  'baseline-absent refusé : %s',
  async (phase) => {
    const t = await ouverte();
    const r = t.resultats();
    r.phase = phase === 'positions-avant' ? 'positions' : phase;
    if (phase === 'positions-avant')
      r.positions_deadline = new Date(Date.now() + 60000).toISOString();
    const actions = creerActionsAvis(t.avis);
    await expect(
      actions['mesh.avis.baseline-absent'].preparer(
        { params: { id: t.p.id } },
        { confirmation: true },
      ),
    ).rejects.toThrow(/positions après échéance/);
    expect(t.appels.some((a) => a.includes('baseline-absent'))).toBe(false);
  },
);

test('baseline hors accord, bulletins jamais stockés ; revalidation avant déclaration', async () => {
  const t = await ouverte();
  const r = t.resultats();
  r.phase = 'closed';
  const body = JSON.stringify({
    reponses: [{ n: 1, verdict: 'oui', justification: 'CORPS_UNIQUEMENT_GATEWAY' }],
  });
  r.ballots = ['alpha', 'beta', 'lab'].map((peer, i) => ({
    peer,
    round: 'positions',
    created_at: new Date().toISOString(),
    voided: false,
    placeholder: 'exemple',
    message_id: i + 1,
    body,
    outcome: 'pass',
  }));
  const resultat = await t.avis.lire(t.p.id);
  expect(resultat.baseline).toMatchObject({ cell: 'lab', etat: 'ok' });
  expect(resultat.avis.map((a) => a.cell)).toEqual(['alpha', 'beta']);
  expect(resultat.accord[0]!.compte).toEqual({ oui: 2 });
  expect(JSON.stringify(t.db.prepare('SELECT * FROM avis_mesh').all())).not.toContain(
    'CORPS_UNIQUEMENT_GATEWAY',
  );
  expect(
    (t.db.prepare('PRAGMA table_info(avis_mesh)').all() as { name: string }[]).map((c) => c.name),
  ).not.toContain('bulletins');
  r.phase = 'positions';
  r.ballots = r.ballots.filter((b) => (b as { peer: string }).peer !== 'lab');
  const actions = creerActionsAvis(t.avis);
  const p = await actions['mesh.avis.baseline-absent'].preparer(
    { params: { id: t.p.id } },
    { confirmation: true },
  );
  r.phase = 'closed';
  await expect(
    actions['mesh.avis.baseline-absent'].executer(p, { confirmation: true }),
  ).rejects.toThrow();
  r.phase = 'positions';
  await actions['mesh.avis.baseline-absent'].executer(p, { confirmation: true });
  expect(t.appels.at(-1)).toContain(RAISON_BASELINE_ABSENT);
});

async function routes() {
  const t = await ouverte();
  const app = Fastify();
  nettoyage.push(() => {
    void app.close();
  });
  app.setErrorHandler((e, _req, reply) =>
    reply.code(e instanceof AidHttpError ? e.status : 500).send({ error: (e as Error).message }),
  );
  const demander = vi.fn(async () => ({ confirmation: 'confirmation-test' }));
  registerAvisMeshRoutes(app, { avis: t.avis, porte: { demander } as unknown as Porte });
  return { ...t, app, demander };
}
test('routes : deux en-têtes obligatoires, question refusée, famille en double', async () => {
  const t = await routes();
  for (const url of ['/api/avis-mesh', `/api/avis-mesh/${t.p.id}/baseline-absent`]) {
    expect((await t.app.inject({ method: 'POST', url, payload: demande() })).statusCode).toBe(403);
  }
  const envoyer = (payload: ReturnType<typeof demande>) =>
    t.app.inject({
      method: 'POST',
      url: '/api/avis-mesh',
      headers: { 'x-aid-confirm': 'avis' },
      payload: { ...payload, mesh: 'principal' },
    });
  expect((await envoyer({ ...demande(), question: '<<<QUESTION mauvais' })).statusCode).toBe(422);
  expect((await envoyer({ ...demande(), cells: ['alpha', 'alpha'] })).statusCode).toBe(400);
  // Une famille du chair ne peut être réutilisée par un siège.
  const autre = new AvisMeshService({
    db: t.db,
    config: { ...config, avis: { baseline: 'lab', familles: { ...familles, beta: familles.lab } } },
    lecteur: t.lecteur,
    ecrivain: t.ecrivain,
  });
  const app = Fastify();
  nettoyage.push(() => {
    void app.close();
  });
  app.setErrorHandler((e, _req, reply) =>
    reply.code(e instanceof AidHttpError ? e.status : 500).send({ error: (e as Error).message }),
  );
  registerAvisMeshRoutes(app, { avis: autre, porte: { demander: t.demander } as unknown as Porte });
  const r = await app.inject({
    method: 'POST',
    url: '/api/avis-mesh',
    headers: { 'x-aid-confirm': 'avis' },
    payload: { ...demande(), mesh: 'principal' },
  });
  expect(r.statusCode).toBe(400);
  expect(r.json().error).toMatch(/lab, beta/);
  expect(t.demander).not.toHaveBeenCalled();
});

test('six routes : contrat, aperçu exact, config limitée, liste et baseline-absent', async () => {
  const t = await routes();
  const r = await t.app.inject({
    method: 'POST',
    url: '/api/avis-mesh',
    headers: { 'x-aid-confirm': 'avis' },
    payload: { ...demande(), mesh: 'principal' },
  });
  expect(r.statusCode).toBe(202);
  expect(r.json()).toMatchObject({
    cells: ['alpha', 'beta'],
    etat: 'confirmation',
    confirmation: 'confirmation-test',
    apercu: { carte: 42, sieges: siegesAvis(entree) },
  });
  const params = (
    t.demander.mock.calls as unknown as [string, { params: { texte: string } }][]
  )[0]![1].params;
  expect(r.json().apercu.texte).toBe(params.texte);
  expect((await t.app.inject('/api/avis-mesh/config')).json()).toEqual({
    cellAid: 'aid',
    baseline: 'lab',
    familles,
  });
  expect((await t.app.inject('/api/avis-mesh')).json().demandes).toHaveLength(2);
  expect((await t.app.inject(`/api/avis-mesh/${t.p.id}`)).json()).toMatchObject({
    format: 'aid-avis-mesh/1',
    phase: 'positions',
    baseline: { cell: 'lab', etat: 'attendu' },
  });
  const absent = await t.app.inject({
    payload: { mesh: 'principal' },
    method: 'POST',
    url: `/api/avis-mesh/${t.p.id}/baseline-absent`,
    headers: { 'x-aid-confirm': 'avis' },
  });
  expect(absent.statusCode).toBe(202);
  expect(absent.json()).toEqual({ confirmation: 'confirmation-test' });
  t.resultats().phase = 'closed';
  expect(
    (
      await t.app.inject({
        payload: { mesh: 'principal' },
        method: 'POST',
        url: `/api/avis-mesh/${t.p.id}/baseline-absent`,
        headers: { 'x-aid-confirm': 'avis' },
      })
    ).statusCode,
  ).toBe(409);
});

test('porte réelle : toujours confirmée, aperçu signé, aucune exécution directe', async () => {
  const t = faux();
  const pda = preparerPda();
  nettoyage.push(pda.nettoyer);
  const avis = new AvisMeshService({
    db: pda.db,
    config,
    lecteur: t.lecteur,
    ecrivain: t.ecrivain,
  });
  const actions = creerActionsConfirmation({
    db: pda.db,
    config: { ...DEFAULT_CONFIG, mesh: config },
    avis,
  });
  const porte = creerPorte({
    db: pda.db,
    config: { ...DEFAULT_CONFIG, mesh: config },
    actions,
    file: () => null,
  });
  const p = avis.preparer(demande());
  avis.enregistrer(p);
  const app = Fastify();
  nettoyage.push(() => {
    void app.close();
  });
  app.addHook('preHandler', async (req) => {
    req.principal = { kind: 'admin', via: 'cookie' };
  });
  app.setErrorHandler((e, _req, reply) =>
    reply.code(e instanceof AidHttpError ? e.status : 500).send({ error: (e as Error).message }),
  );
  app.post('/demander', (req) =>
    porte.demander('mesh.avis', { params: p, mesh: 'principal' }, req),
  );
  expect((await app.inject({ method: 'POST', url: '/demander' })).json().error).toBe(
    'confirmation_requise',
  );
  pda.db.prepare('UPDATE confirmations_armement SET arme = 1 WHERE id = 1').run();
  expect((await app.inject({ method: 'POST', url: '/demander' })).json().error).toBe(
    'confirmation_impossible',
  );
  await expect(porte.executer('mesh.avis', { params: p }, {})).rejects.toThrow(
    'confirmation_requise',
  );
  const prepares = await actions['mesh.avis'].preparer({ params: p }, { confirmation: true });
  expect(jsonCanonique(prepares)).toBe(
    jsonCanonique({
      params: {
        id: p.id,
        nom: p.nom,
        sieges: p.sieges,
        carte: p.carte,
        echeances: p.echeances,
        texte: p.texte,
      },
    }),
  );
  expect(resumeAction('mesh.avis', prepares)).toContain(p.nom);
  expect(prepares.params).toMatchObject({
    texte: p.texte,
    sieges: p.sieges,
    carte: p.carte,
    echeances: p.echeances,
  });
  expect(t.appels).toHaveLength(0);
});

test('porte : confirmation signée consommée, altération refusée et salle ouverte une fois', async () => {
  const t = faux();
  const pda = preparerPda();
  nettoyage.push(pda.nettoyer);
  const { FilePda } = await import('../src/daemon/pda/file.js');
  const avis = new AvisMeshService({
    db: pda.db,
    config,
    lecteur: t.lecteur,
    ecrivain: t.ecrivain,
  });
  const actions = creerActionsConfirmation({ db: pda.db, avis });
  const file = new FilePda({
    ...pda,
    relais: {
      publierAutorises: async () => true,
      publierResultat: async () => true,
      deposer: async () => true,
      retirer: async () => {},
      tirer: async () => [],
    },
    actif: () => true,
    contexte: () => ({ origine: 'https://aid-e2e.ts.net', rpId: 'aid-e2e.ts.net' }),
    signaler: () => {},
  });
  nettoyage.push(() => file.arreter());
  const porte = creerPorte({
    db: pda.db,
    config: { ...DEFAULT_CONFIG, mesh: config },
    actions,
    file: () => file,
  });
  const p = avis.preparer(demande());
  avis.enregistrer(p);
  const signes = await actions['mesh.avis'].preparer({ params: p }, { confirmation: true });
  const { id } = await file.creerDemande({
    action: 'mesh.avis',
    params: signes,
    mesh: signatureMesh({ config: { ...DEFAULT_CONFIG, mesh: config } }, 'principal'),
  });
  const ligne = pda.db
    .prepare(
      "SELECT id, h_demande AS hDemande, CASE WHEN classe = 'toujours' THEN NULL ELSE numero END AS numero, numero_mac, action, params, classe, echeance FROM pda_demandes WHERE id = ?",
    )
    .get(id) as import('../src/daemon/pda/file.js').LigneDemande;
  await porte.executerConfirmee({
    ...ligne,
    params: JSON.stringify({ params: { ...p, texte: 'altération' } }),
  });
  expect(t.appels).toHaveLength(0);
  expect(pda.db.prepare('SELECT resultat FROM pda_demandes WHERE id = ?').get(id)).toEqual({
    resultat: 'perimee',
  });
  await porte.executerConfirmee(ligne);
  expect(avis.ligne(p.id)).toMatchObject({ etat: 'ouverte', canal: 'avis-test', motion: 42 });
  expect(pda.db.prepare('SELECT resultat FROM pda_demandes WHERE id = ?').get(id)).toEqual({
    resultat: 'executee',
  });
  await porte.executerConfirmee(ligne);
  expect(t.appels).toHaveLength(2);
});

const instant = Date.parse('2026-11-12T12:00:00Z');
test('trois échéances : défauts 24 h, puis 1 h, puis 1 h', () => {
  const e = echeancesAvisParDefaut(instant);
  expect(e).toEqual({
    positions: '2026-11-13T12:00:00.000Z',
    rebuttal: '2026-11-13T13:00:00.000Z',
    vote: '2026-11-13T14:00:00.000Z',
  });
  expect(() => validerEcheancesAvis(e, instant)).not.toThrow();
  const t = faux();
  const avant = Date.now();
  const { echeances: ignorees, ...sansEcheances } = demande();
  void ignorees;
  const p = t.avis.preparer(sansEcheances);
  expect(Date.parse(p.echeances.positions) - avant).toBeGreaterThanOrEqual(86400000);
  expect(Date.parse(p.echeances.rebuttal) - Date.parse(p.echeances.positions)).toBe(3600000);
  expect(Date.parse(p.echeances.vote) - Date.parse(p.echeances.rebuttal)).toBe(3600000);
});
test.each(['positions', 'rebuttal', 'vote'] as const)('échéance %s manquante refusée', (tour) => {
  const e: Partial<ReturnType<typeof echeances>> = echeancesAvisParDefaut(instant);
  delete e[tour];
  expect(() => validerEcheancesAvis(e as ReturnType<typeof echeances>, instant)).toThrow(
    /Échéance/,
  );
});
test.each(['positions', 'rebuttal', 'vote'] as const)(
  'durée %s bornée et strictement croissante',
  (tour) => {
    for (const duree of [0, -3600000, 3599999, 7 * 86400000 + 1]) {
      const e = echeancesAvisParDefaut(instant);
      const precedente =
        tour === 'positions'
          ? instant
          : Date.parse(e[tour === 'rebuttal' ? 'positions' : 'rebuttal']);
      e[tour] = new Date(precedente + duree).toISOString();
      expect(() => validerEcheancesAvis(e, instant)).toThrow(new RegExp(tour));
    }
  },
);
test('familles normalisées, chair orchestrator sans config, Claude et claude en double', () => {
  const normalisees = siegesAvis({
    ...entree,
    familles: { lab: 'Claude', alpha: 'Gemini', beta: 'GPT' },
  });
  expect(normalisees.map((s) => s.family)).toEqual(['orchestrator', 'claude', 'gemini', 'gpt']);
  expect(() =>
    siegesAvis({ ...entree, familles: { ...familles, alpha: 'Claude', beta: 'claude' } }),
  ).toThrow(/lab, alpha/);
  expect(() => siegesAvis({ ...entree, familles: { ...familles, beta: 'inconnue' } })).toThrow(
    /beta/,
  );
});
test('baseline : vote visible ignoré, absence non inventée', async () => {
  const t = await ouverte();
  const r = t.resultats();
  r.phase = 'closed';
  const bulletin = (round: string, verdict: string, message_id: number) => ({
    peer: 'lab',
    round,
    created_at: new Date().toISOString(),
    voided: false,
    placeholder: 'exemple',
    message_id,
    outcome: 'pass',
    body: JSON.stringify({ reponses: [{ n: 1, verdict, justification: 'Exemple' }] }),
  });
  r.ballots = [bulletin('positions', 'oui', 1), bulletin('vote', 'non', 2)];
  const lu = await t.avis.lire(t.p.id);
  expect(lu.baseline).toMatchObject({
    etat: 'ok',
    vote: null,
    reponses: [{ n: 1, verdict: 'oui', justification: 'Exemple' }],
  });
  r.ballots = [bulletin('vote', 'non', 2)];
  expect((await t.avis.lire(t.p.id)).baseline).toMatchObject({ etat: 'absent' });
});
test('reprise de motion : état requis, nouvelle confirmation, aucune réouverture de salle, une seule exécution', async () => {
  const t = faux();
  const p = t.avis.preparer(demande());
  t.avis.enregistrer(p);
  expect(() => t.avis.preparerMotion(p.id, echeances())).toThrow(/salle-sans-motion/);
  t.echouer('--open');
  await expect(t.avis.ouvrir(p)).rejects.toThrow();
  t.echouer('');
  const actions = creerActionsAvis(t.avis);
  const reprise = await actions['mesh.avis.motion'].preparer(
    { params: { id: p.id, echeances: echeances() } },
    { confirmation: true },
  );
  await expect(
    actions['mesh.avis.motion'].executer(reprise, { confirmation: false }),
  ).rejects.toThrow('confirmation_requise');
  const avant = t.appels.length;
  const executions = await Promise.allSettled([
    actions['mesh.avis.motion'].executer(reprise, { confirmation: true }),
    actions['mesh.avis.motion'].executer(reprise, { confirmation: true }),
  ]);
  expect(executions.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(t.appels.slice(avant)).toHaveLength(2);
  expect(t.appels[avant]).toEqual(['committee', 'motion', 'avis-test', '--json', '--as', 'aid']);
  expect(t.appels[avant + 1]).toEqual([
    'committee',
    'motion',
    'avis-test',
    '--open',
    '--text',
    p.texte,
    '--options',
    'avis,objection',
    '--positions-deadline',
    reprise.params.echeances.positions,
    '--rebuttal-deadline',
    reprise.params.echeances.rebuttal,
    '--vote-deadline',
    reprise.params.echeances.vote,
    '--json',
    '--as',
    'aid',
  ]);
  expect(t.appels.slice(avant).flat()).not.toContain('rooms');
  expect(t.avis.ligne(p.id)).toMatchObject({ etat: 'ouverte', motion: 42 });
  expect(() => t.avis.preparerMotion(p.id, echeances())).toThrow(/salle-sans-motion/);
});
test('route motion : en-tête, état et trois échéances exigés', async () => {
  const t = await routes();
  const url = `/api/avis-mesh/${t.p.id}/motion`;
  expect(
    (await t.app.inject({ method: 'POST', url, payload: { echeances: echeances() } })).statusCode,
  ).toBe(403);
  const poster = (payload: object) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: { 'x-aid-confirm': 'avis' },
      payload: { ...payload, mesh: 'principal' },
    });
  expect((await poster({ echeances: echeances() })).statusCode).toBe(409);
  t.db
    .prepare("UPDATE avis_mesh SET etat = 'salle-sans-motion', motion = NULL WHERE id = ?")
    .run(t.p.id);
  expect((await poster({ echeances: { positions: echeances().positions } })).statusCode).toBe(400);
  expect((await poster({ echeances: echeances() })).statusCode).toBe(202);
  expect(t.demander).toHaveBeenLastCalledWith(
    'mesh.avis.motion',
    {
      mesh: 'principal',
      params: expect.objectContaining({
        id: t.p.id,
        canal: 'avis-test',
        echeances: expect.any(Object),
      }),
    },
    expect.anything(),
  );
});

test('gateway 409 : message nettoyé, limité à 300 caractères et accessible au client', async () => {
  const t = await routes();
  const detail = 'baseline déjà déclaré absent, ' + 'exemple '.repeat(60);
  t.echouer('baseline-absent', `swarph committee baseline-absent: gateway 409: ${detail}`);
  await expect(t.avis.declarerAbsent(t.p.id)).rejects.toMatchObject({
    status: 409,
    message: detail.slice(0, 300),
  });
  expect((await t.app.inject('/api/avis-mesh')).json().demandes[0].erreur).toEqual({
    status: 409,
    message: detail.slice(0, 300),
  });
  // Le nettoyeur du 35 refuse ce contenu : aucun texte suspect n'est renvoyé.
  t.echouer(
    'baseline-absent',
    'swarph committee baseline-absent: gateway 409: exemple.aid-e2e.ts.net',
  );
  await expect(t.avis.declarerAbsent(t.p.id)).rejects.toMatchObject({
    status: 409,
    message: 'Refus gateway : hôte privé',
  });
  const ctx: import('../src/daemon/confirmations/porte.js').ContexteAction = { confirmation: true };
  const actions = creerActionsAvis(t.avis);
  const p = await actions['mesh.avis.baseline-absent'].preparer({ params: { id: t.p.id } }, ctx);
  await actions['mesh.avis.baseline-absent'].executer(p, ctx);
  expect(ctx.envoi).toMatchObject({
    code: 'upstream_error',
    status: 409,
    detail: 'Refus gateway : hôte privé',
  });
  t.echouer('baseline-absent', 'panne interne confidentielle');
  await expect(t.avis.declarerAbsent(t.p.id)).rejects.toThrow('committee : écriture échouée');
});

async function confirmationSignee() {
  const t = faux();
  const pda = preparerPda();
  nettoyage.push(pda.nettoyer);
  const { FilePda } = await import('../src/daemon/pda/file.js');
  const avis = new AvisMeshService({
    db: pda.db,
    config,
    lecteur: t.lecteur,
    ecrivain: t.ecrivain,
  });
  const actions = creerActionsConfirmation({ db: pda.db, avis });
  const file = new FilePda({
    ...pda,
    relais: {
      publierAutorises: async () => true,
      publierResultat: async () => true,
      deposer: async () => true,
      retirer: async () => {},
      tirer: async () => [],
    },
    actif: () => true,
    contexte: () => ({ origine: 'https://aid-e2e.ts.net', rpId: 'aid-e2e.ts.net' }),
    signaler: () => {},
  });
  nettoyage.push(() => file.arreter());
  const porte = creerPorte({
    db: pda.db,
    config: { ...DEFAULT_CONFIG, mesh: config },
    actions,
    file: () => file,
  });
  const p = avis.preparer(demande());
  avis.enregistrer(p);
  const signes = await actions['mesh.avis'].preparer({ params: p }, { confirmation: true });
  const { id } = await file.creerDemande({
    action: 'mesh.avis',
    params: signes,
    mesh: signatureMesh({ config: { ...DEFAULT_CONFIG, mesh: config } }, 'principal'),
  });
  avis.lierConfirmation(p.id, id);
  return { ...t, pda, avis, actions, file, porte, p, id };
}
test.each(['refusee', 'expiree', 'ouverte-perimee'])(
  'confirmation %s : abandonnee calculé à la lecture, demande conservée',
  async (etat) => {
    const t = await confirmationSignee();
    if (etat === 'ouverte-perimee')
      t.pda.db
        .prepare('UPDATE pda_demandes SET echeance = ? WHERE id = ?')
        .run(Date.now() - 1, t.id);
    else t.pda.db.prepare('UPDATE pda_demandes SET etat = ? WHERE id = ?').run(etat, t.id);
    expect(t.avis.ligne(t.p.id).etat).toBe('abandonnee');
    expect(t.avis.liste().demandes).toEqual([
      expect.objectContaining({ id: t.p.id, etat: 'abandonnee' }),
    ]);
    expect(() => t.avis.verifier(t.p)).toThrow('déjà exécutée');
    expect(t.pda.db.prepare('SELECT COUNT(*) AS n FROM avis_mesh').get()).toEqual({ n: 1 });
    expect(t.appels).toHaveLength(0);
  },
);
test('refus gateway pendant confirmation : statut et détail conservés dans la porte et exposés', async () => {
  const t = await confirmationSignee();
  t.echouer('--open', 'swarph committee motion open: gateway 409: motion déjà ouverte');
  const ligne = t.pda.db
    .prepare(
      "SELECT id, h_demande AS hDemande, CASE WHEN classe = 'toujours' THEN NULL ELSE numero END AS numero, numero_mac, action, params, classe, echeance FROM pda_demandes WHERE id = ?",
    )
    .get(t.id) as import('../src/daemon/pda/file.js').LigneDemande;
  await t.porte.executerConfirmee(ligne);
  const stockee = t.pda.db
    .prepare('SELECT resultat, envoi FROM pda_demandes WHERE id = ?')
    .get(t.id) as { resultat: string; envoi: string };
  expect(stockee.resultat).toBe('echouee');
  expect(JSON.parse(stockee.envoi)).toMatchObject({
    code: 'upstream_error',
    status: 409,
    detail: 'motion déjà ouverte',
  });
  const app = Fastify();
  nettoyage.push(() => {
    void app.close();
  });
  app.addHook('preHandler', async (req) => {
    req.principal = { kind: 'admin', via: 'cookie' };
  });
  const { registerConfirmationRoutes } = await import('../src/daemon/routes/confirmations.js');
  registerConfirmationRoutes(app, t.pda.db, t.porte, () => t.file);
  const lu = (await app.inject('/api/confirmations')).json();
  expect(lu.ouvertes[0].envoi).toMatchObject({ status: 409, detail: 'motion déjà ouverte' });
  expect(t.avis.ligne(t.p.id).etat).toBe('salle-sans-motion');
});

test('transport CLI : read transmet une écriture sans filtre de verbes, délai commun de 30 s', async () => {
  const t = faux();
  const { MeshService } = await import('../src/daemon/mesh/service.js');
  const { EventStore } = await import('../src/daemon/events/store.js');
  const execution = vi.fn<import('../src/daemon/mesh/exec.js').MeshExec>(
    async (bin, args, options) => {
      expect(options.timeoutMs).toBe(30000);
      return meshExec(bin, args, options);
    },
  );
  const mesh = new MeshService({
    config: { ...config, bin: join(t.dossier, 'swarph'), proxyLectureSeule: true },
    home: t.dossier,
    db: t.db,
    store: new EventStore(t.db),
    log: () => {},
    exec: execution,
  });
  const writer = new CommitteeWriter({ mesh, cell: 'aid' });
  expect(await writer.ouvrirSalle(t.avis.preparer(demande()))).toBe('avis-test');
  expect(execution).toHaveBeenCalledOnce();
  expect(execution.mock.calls[0]![1]).toContain('open');
  expect(execution.mock.calls[0]![1].slice(-2)).toEqual(['--as', 'aid']);
});

test('refus gateway 4xx en lecture : HTTP et détail nettoyé conservés', async () => {
  const t = await routes();
  t.echouer('results', 'swarph committee results: gateway 403: not a seat');
  const r = await t.app.inject(`/api/avis-mesh/${t.p.id}`);
  expect(r.statusCode).toBe(403);
  expect(r.json()).toEqual({ error: 'not a seat' });
});

test('baseline : attendu après échéance sans position, déclaré absent seulement sur parole du gateway', async () => {
  const t = await ouverte();
  const r = t.resultats();
  expect(r.phase).toBe('positions');
  expect(Date.parse(r.positions_deadline)).toBeLessThan(Date.now());
  const attendu = (await t.avis.lire(t.p.id)).baseline;
  expect(attendu).toMatchObject({ cell: 'lab', etat: 'attendu' });
  expect(attendu).not.toHaveProperty('reason');
  const declaration = {
    reason: 'absence déclarée pour cet exemple',
    by: 'aid',
    at: '2026-11-12T12:00:00Z',
  };
  r.baseline_absent = declaration;
  const declare = (await t.avis.lire(t.p.id)).baseline;
  expect(declare).toMatchObject({
    cell: 'lab',
    etat: 'declare_absent',
    ...declaration,
    reponses: [],
    brut: null,
    vote: null,
  });
  r.baseline_absent = null;
  expect((await t.avis.lire(t.p.id)).baseline).toMatchObject({ etat: 'attendu' });
});
test.each(['positions', 'closed'])(
  'positions_absent prime sur les bulletins et exclut le siège de l’accord : %s',
  async (phase) => {
    const t = await ouverte();
    const r = t.resultats();
    r.phase = phase;
    r.ballots = ['alpha', 'beta'].map((peer, i) => ({
      peer,
      round: 'positions',
      created_at: '2026-11-12T12:00:00Z',
      voided: false,
      placeholder: 'exemple',
      message_id: i + 1,
      outcome: 'pass',
      body: JSON.stringify({ reponses: [{ n: 1, verdict: 'oui', justification: 'Exemple' }] }),
    }));
    expect((await t.avis.lire(t.p.id)).accord[0]).toMatchObject({
      accord: 'unanime',
      compte: { oui: 2 },
    });
    r.positions_absent = ['alpha'];
    r.ballots.push({
      peer: 'alpha',
      round: 'vote',
      created_at: '2026-11-12T12:00:00Z',
      voided: false,
      placeholder: 'exemple',
      message_id: 3,
      body: 'avis',
      outcome: 'pass',
    });
    const resultat = await t.avis.lire(t.p.id);
    expect(resultat.avis[0]).toMatchObject({
      cell: 'alpha',
      etat: 'absent',
      vote: phase === 'closed' ? 'avis' : null,
      reponses: [],
      brut: null,
    });
    expect(resultat.avis[1]).toMatchObject({ cell: 'beta', etat: 'ok' });
    expect(resultat.accord[0]).toMatchObject({ accord: 'insuffisant', compte: { oui: 1 } });
  },
);

test('baseline déjà déclaré absent : refus local 409 sans écriture gateway', async () => {
  const t = await routes();
  t.resultats().baseline_absent = { reason: 'Exemple', by: 'aid', at: '2026-11-12T12:00:00Z' };
  const ecrire = vi.spyOn(t.ecrivain, 'baselineAbsent');
  const reponse = await t.app.inject({
    payload: { mesh: 'principal' },
    method: 'POST',
    url: `/api/avis-mesh/${t.p.id}/baseline-absent`,
    headers: { 'x-aid-confirm': 'avis' },
  });
  expect(reponse.statusCode).toBe(409);
  expect(reponse.json()).toEqual({ error: 'baseline déjà déclaré absent' });
  await expect(t.avis.declarerAbsent(t.p.id)).rejects.toMatchObject({
    status: 409,
    message: 'baseline déjà déclaré absent',
  });
  expect(ecrire).not.toHaveBeenCalled();
  expect(t.demander).not.toHaveBeenCalled();
  expect(t.appels.some((a) => a[1] === 'baseline-absent')).toBe(false);
});

test('position du baseline scellée ou visible : refus local 409 sans écriture gateway', async () => {
  const t = await routes();
  const ecrire = vi.spyOn(t.ecrivain, 'baselineAbsent');
  for (const body of [null, '{"reponses":[]}']) {
    t.resultats().ballots = [
      {
        peer: 'lab',
        round: 'positions',
        created_at: '2026-11-12T12:00:00Z',
        voided: false,
        placeholder: 'exemple',
        message_id: 1,
        body,
        outcome: 'pass',
      },
    ];
    const reponse = await t.app.inject({
      payload: { mesh: 'principal' },
      method: 'POST',
      url: `/api/avis-mesh/${t.p.id}/baseline-absent`,
      headers: { 'x-aid-confirm': 'avis' },
    });
    expect(reponse.statusCode).toBe(409);
    expect(reponse.json()).toEqual({ error: 'le baseline a déjà posté' });
    await expect(t.avis.declarerAbsent(t.p.id)).rejects.toMatchObject({
      status: 409,
      message: 'le baseline a déjà posté',
    });
  }
  expect(ecrire).not.toHaveBeenCalled();
  expect(t.demander).not.toHaveBeenCalled();
  expect(t.appels.some((a) => a[1] === 'baseline-absent')).toBe(false);
});

test('salle en minuscules, id de demande conservé', () => {
  const t = faux();
  const p = t.avis.preparer(demande());
  expect(p.nom).toBe(`avis-${p.id.toLowerCase()}`);
  expect(p.nom).toMatch(/^[a-z0-9_-]{1,64}$/);
  expect(p.id).toMatch(/T.*Z/);
});

test('position annulée du baseline ignorée et siège annulé écarté', async () => {
  const t = await ouverte();
  const r = t.resultats();
  r.ballots = [
    {
      peer: 'lab',
      round: 'positions',
      created_at: new Date().toISOString(),
      voided: true,
      placeholder: 'exemple',
      message_id: 1,
    },
  ];
  await expect(t.avis.verifierAbsence(t.p.id)).resolves.toMatchObject({ motion: 42 });
  r.seats[2]!.voided = true;
  r.seats[2]!.recast_from = 'ancien';
  expect((await t.avis.lire(t.p.id)).avis.map((a) => a.cell)).toEqual(['beta']);
});

test('reprise récupère une motion déjà ouverte sans écriture', async () => {
  const t = await ouverte();
  t.db
    .prepare("UPDATE avis_mesh SET etat = 'salle-sans-motion', motion = NULL WHERE id = ?")
    .run(t.p.id);
  const p = t.avis.preparerMotion(t.p.id, echeances());
  const echeancesGateway = {
    positions: '2026-11-13T10:00:00Z',
    rebuttal: '2026-11-13T11:00:00Z',
    vote: '2026-11-13T12:00:00Z',
  };
  expect(echeancesGateway).not.toEqual(p.echeances);
  const espion = vi.spyOn(t.lecteur, 'motionOuverte').mockResolvedValue({
    ok: true,
    readAt: new Date().toISOString(),
    data: {
      id: 43,
      text: 'Question',
      options: ['avis', 'objection'],
      phase: 'positions',
      positions_deadline: echeancesGateway.positions,
      rebuttal_deadline: echeancesGateway.rebuttal,
      vote_deadline: echeancesGateway.vote,
    },
  });
  const avant = t.appels.length;
  await t.avis.reprendreMotion(p);
  expect(JSON.parse(t.avis.ligne(t.p.id)!.echeances)).toEqual(echeancesGateway);
  expect(espion).toHaveBeenCalledWith('avis-test');
  expect(t.appels).toHaveLength(avant);
  expect(t.avis.ligne(t.p.id)).toMatchObject({ etat: 'ouverte', motion: 43 });
});

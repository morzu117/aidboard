import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { preparerPda, assertionPda } from './helpers/pda.js';
import { makeOriginAndClone, commitFile, sh } from './helpers/git.js';
import { FilePda } from '../src/daemon/pda/file.js';
import type { RelaisPda, ReponseRelais } from '../src/daemon/pda/relais.js';
import {
  creerPorte,
  type ActionPorte,
  type EntreeAction,
} from '../src/daemon/confirmations/porte.js';
import { creerActionsConfirmation } from '../src/daemon/confirmations/actions.js';
import { creerReglage } from '../src/daemon/confirmations/reglage.js';
import { registerConfirmationRoutes } from '../src/daemon/routes/confirmations.js';
import { registerTopicRoutes } from '../src/daemon/routes/topics.js';
import { registerWorkspaceRoutes } from '../src/daemon/routes/workspaces.js';
import { createAuthState, registerSecurity, SESSION_COOKIE } from '../src/daemon/security.js';
import { AidHttpError } from '../src/daemon/errors.js';
import { EventStore } from '../src/daemon/events/store.js';
import { WorkspaceQueue } from '../src/daemon/actions/queue.js';
import { resolvePaths, ensureHome } from '../src/daemon/paths.js';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import { StructuralService } from '../src/daemon/structural/service.js';
import { Indexer } from '../src/daemon/topics/index.js';
import { runScript } from '../src/daemon/actions/runner.js';
import { jsonCanonique, verifierEnveloppe } from '../src/shared/pda.js';

vi.mock('../src/daemon/actions/runner.js', () => ({ runScript: vi.fn() }));
const nettoyages: Array<() => unknown | Promise<unknown>> = [];
beforeEach(() => {
  vi.mocked(runScript)
    .mockReset()
    .mockResolvedValue({ outcome: 'succeeded', exitCode: 0, result: {}, tail: [] });
});
afterEach(async () => {
  for (const nettoyer of nettoyages.splice(0).reverse()) await nettoyer();
});

type ActionGit = Exclude<ActionPorte, 'appairage' | 'pda.activer' | 'host.option' | 'desarmement'>;
async function preparer(action: ActionGit = 'push', arme = true) {
  const t = preparerPda();
  nettoyages.push(t.nettoyer);
  const dossier = mkdtempSync(join(tmpdir(), 'aid-confirmations-'));
  nettoyages.push(() => rmSync(dossier, { recursive: true, force: true }));
  const { clone } = makeOriginAndClone(dossier);
  sh(clone, 'checkout', '-qb', 'feat/test');
  commitFile(clone, 'test.txt', 'Exemple');
  const tete = sh(clone, 'rev-parse', 'HEAD');
  sh(clone, 'remote', 'set-url', 'origin', 'https://example.com/exemple/projet.git');
  const paths = resolvePaths(join(dossier, 'aid'));
  ensureHome(paths);
  t.db
    .prepare(
      "INSERT INTO workspaces (id, name, root, base_branch, worktrees_dir, created_at, remote) VALUES ('ws','Test',?,'main',?,'t0','origin')",
    )
    .run(clone, dossier);
  t.db
    .prepare(
      "INSERT INTO topics (id, workspace_id, slug, title, type, branch, base, worktree, state, pr_number, index_state, created_at, updated_at) VALUES ('tp','ws','test','Test','feat','feat/test','main',?,'active',42,'disabled','t0','t0')",
    )
    .run(clone);
  t.db
    .prepare(
      "INSERT INTO workspaces (id, name, root, base_branch, worktrees_dir, created_at) VALUES ('retirer','Vide',?,'main',?,'t0')",
    )
    .run(join(dossier, 'vide'), dossier);
  t.db
    .prepare(
      "INSERT INTO actions (id,workspace_id,topic_id,action,state,result,started_at) VALUES ('pr','ws','tp','pr.rafraichir','succeeded',?,'t0')",
    )
    .run(JSON.stringify({ number: 42, headRefOid: tete }));
  const appareil = await t.appareil();
  const reglage = creerReglage(t.db);
  if (arme) reglage.armer();
  const store = new EventStore(t.db);
  const engine = new StructuralService({ engine: 'off' });
  const config = structuredClone(DEFAULT_CONFIG);
  const actions = { store, paths, queue: new WorkspaceQueue() };
  const definitions = creerActionsConfirmation({ db: t.db, actions, engine, config });
  let reponses: ReponseRelais[] = [];
  let heure = Date.now();
  let actif = true;
  const relais = {
    publierAutorises: vi.fn<RelaisPda['publierAutorises']>(async () => true),
    deposer: vi.fn<RelaisPda['deposer']>(async () => true),
    retirer: vi.fn<RelaisPda['retirer']>(async () => {}),
    tirer: vi.fn<RelaisPda['tirer']>(async () => reponses),
  };
  const porte = creerPorte({
    db: t.db,
    actions: definitions,
    file: () => file,
    signaler: () => store.emitEphemeral({ kind: 'ephemeral', type: 'confirmation.change' }),
  });
  const file = new FilePda({
    ...t,
    relais,
    actif: () => actif,
    contexte: () => ({ origine: 'https://aid-e2e.ts.net', rpId: 'aid-e2e.ts.net' }),
    maintenant: () => heure,
    signaler: vi.fn(),
    executer: (ligne) => porte.executerConfirmee(ligne),
    preparerConsommation: (ligne) => porte.preparerConsommation(ligne),
  });
  nettoyages.push(() => file.arreter());
  const logs: string[] = [];
  const app = Fastify({
    logger: {
      stream: new Writable({
        write(chunk, _encoding, cb) {
          logs.push(String(chunk));
          cb();
        },
      }),
    },
  });
  nettoyages.push(() => app.close());
  await app.register(cookie);
  const auth = createAuthState();
  registerSecurity(app, auth, { getPort: () => 12345 });
  app.setErrorHandler((e, _req, reply) => {
    if (e instanceof AidHttpError)
      return reply.code(e.status).send({ error: e.message, ...e.extra });
    throw e;
  });
  registerConfirmationRoutes(app, t.db, porte, () => file);
  registerTopicRoutes(app, {
    db: t.db,
    config,
    engine,
    actions,
    indexer: new Indexer({ store, paths, engine }),
    porte,
  });
  registerWorkspaceRoutes(app, { db: t.db, paths, engine, porte });
  const headers = { host: '127.0.0.1:12345', authorization: `Bearer ${auth.adminToken}` };
  const cookies = {
    host: headers.host,
    cookie: `${SESSION_COOKIE}=${auth.sessionToken}`,
    'sec-fetch-site': 'same-origin',
  };
  const entrees: Record<ActionGit, EntreeAction> = {
    merge: { strategy: 'squash', cleanupAfter: true },
    push: {},
    nettoyage: { confirmUnmerged: 3, dirtyAction: 'force', confirmed: true },
    'projet.retirer': {},
    reglage: { action: 'merge', actif: false },
  };
  const demander = (extra: EntreeAction = {}) => {
    const entree = { ...entrees[action], ...extra };
    if (action === 'reglage')
      return app.inject({
        method: 'PUT',
        url: '/api/confirmations/reglage',
        headers,
        payload: entree,
      });
    if (action === 'projet.retirer')
      return app.inject({ method: 'DELETE', url: '/api/workspaces/retirer', headers });
    const route = { merge: 'topic.merge', push: 'git.pousser', nettoyage: 'topic.cleanup' }[action];
    return app.inject({
      method: 'POST',
      url: `/api/topics/tp/actions/${route}`,
      headers,
      payload: entree,
    });
  };
  const ligne = (id: string) =>
    t.db.prepare('SELECT * FROM pda_demandes WHERE id = ?').get(id) as Record<string, unknown>;
  async function repondre(
    id: string,
    valeur: 'oui' | 'non' = 'oui',
    doubler = false,
    fauxNumero = false,
    signatureFausse = false,
  ) {
    const numero = ligne(id).numero_mac;
    const numeroInitial = ligne(id).numero;
    if (numero === null && fauxNumero)
      t.db
        .prepare('UPDATE pda_demandes SET numero = ? WHERE id = ?')
        .run(numeroInitial === '0000' ? '0001' : '0000', id);
    // L'outil du 43 lit numero : son adaptation reste locale à cette fausse passkey.
    if (numero !== null)
      t.db
        .prepare('UPDATE pda_demandes SET numero = ? WHERE id = ?')
        .run(fauxNumero ? (numero === '0000' ? '0001' : '0000') : numero, id);
    const corps = await assertionPda(t.db, id, appareil, valeur);
    if (signatureFausse) {
      const signature = Buffer.from(corps.signature, 'base64url');
      signature[signature.length - 1]! ^= 1;
      corps.signature = signature.toString('base64url');
    }
    if (numero === null && fauxNumero)
      t.db.prepare('UPDATE pda_demandes SET numero = ? WHERE id = ?').run(numeroInitial, id);
    if (numero !== null) t.db.prepare("UPDATE pda_demandes SET numero = '' WHERE id = ?").run(id);
    const reponse = {
      id,
      appareil: appareil.id,
      curseur: 1,
      corps: Buffer.from(JSON.stringify(corps)).toString('base64url'),
    };
    reponses = doubler ? [reponse, { ...reponse, curseur: 2 }] : [reponse];
    await file.tour();
  }
  return {
    ...t,
    app,
    reglage,
    porte,
    file,
    relais,
    appareil,
    store,
    clone,
    tete,
    definitions,
    headers,
    cookies,
    logs,
    demander,
    ligne,
    repondre,
    expirer: () => {
      heure += 15 * 60_000 + 1;
    },
    couper: () => {
      actif = false;
    },
    allumer: () => {
      actif = true;
    },
    perimer: () => {
      if (action === 'merge')
        t.db
          .prepare("UPDATE actions SET result = ? WHERE id = 'pr'")
          .run(JSON.stringify({ number: 42, headRefOid: 'a'.repeat(40) }));
      if (action === 'push' || action === 'nettoyage') commitFile(clone, 'suite.txt', 'Suite');
      if (action === 'projet.retirer')
        t.db.prepare("UPDATE workspaces SET root = root || '/autre' WHERE id = 'retirer'").run();
      if (action === 'reglage') reglage.couperConfirme('merge');
    },
  };
}
for (const action of ['merge', 'push', 'nettoyage', 'projet.retirer', 'reglage'] as const) {
  for (const cas of ['oui', 'non', 'expiree', 'annulee', 'perimee'] as const) {
    test(`${action} : ${cas}`, async () => {
      const t = await preparer(action);
      const executer = vi.spyOn(t.definitions[action], 'executer');
      const r = await t.demander();
      expect(r.statusCode).toBe(202);
      const { confirmation: id } = r.json<{ confirmation: string }>();
      expect(t.ligne(id)).toMatchObject({
        etat: 'ouverte',
        classe: action === 'reglage' ? 'toujours' : 'defaut',
      });
      const corps = await verifierEnveloppe(
        t.relais.deposer.mock.calls[0]![1],
        t.fournisseur.clePubliqueRaw(),
      );
      expect(corps).toMatchObject({
        v: 2,
        action,
        params: JSON.parse(t.ligne(id).params as string),
      });
      expect(corps!.echeance - corps!.emise).toBe(900000);
      if (action === 'reglage') expect(corps!.numero).toBeNull();
      else expect(corps!.numero).toMatch(/^\d{4}$/);
      expect(t.ligne(id).params).toBe(jsonCanonique(JSON.parse(t.ligne(id).params as string)));

      if (cas === 'annulee') {
        expect(
          (
            await t.app.inject({
              method: 'DELETE',
              url: `/api/confirmations/${id}`,
              headers: t.headers,
            })
          ).statusCode,
        ).toBe(204);
        expect(t.relais.retirer).toHaveBeenCalledWith(id);
      }
      if (cas === 'expiree') t.expirer();
      if (cas === 'perimee') t.perimer();
      await t.repondre(id, cas === 'non' ? 'non' : 'oui', true);
      expect(executer).toHaveBeenCalledTimes(cas === 'oui' ? 1 : 0);
      expect(t.ligne(id).resultat).toBe(
        cas === 'oui' ? 'executee' : cas === 'annulee' || cas === 'perimee' ? cas : null,
      );
      expect(t.ligne(id).etat).toBe(
        cas === 'non'
          ? 'refusee'
          : cas === 'annulee' || cas === 'expiree'
            ? 'expiree'
            : 'confirmee',
      );
      if (cas === 'perimee') expect(t.ligne(id).raison).toBe('perime');
      if (action === 'nettoyage' && cas !== 'oui')
        expect(t.db.prepare("SELECT state FROM topics WHERE id = 'tp'").get()).toEqual({
          state: 'active',
        });
      if (cas === 'oui' && action === 'projet.retirer')
        expect(t.db.prepare("SELECT 1 FROM workspaces WHERE id = 'retirer'").get()).toBeUndefined();
      if (cas === 'oui' && action === 'reglage') expect(t.reglage.exige('merge')).toBe(false);
    });
  }
}
for (const action of ['merge', 'push', 'nettoyage'] as const) {
  test(`${action} : attendus signés transmis au script`, async () => {
    const t = await preparer(action);
    const { confirmation: id } = (await t.demander()).json<{ confirmation: string }>();
    await t.repondre(id);
    const appels = vi.mocked(runScript).mock.calls.map(([spec]) => spec.env);
    if (action === 'merge') {
      expect(appels[0]).toMatchObject({ AID_MERGE_EXIGER_TETE: '1', AID_MERGE_HEAD: t.tete });
      expect(appels[1]).toMatchObject({ AID_CLEANUP_TETE: t.tete });
    }
    if (action === 'push')
      expect(appels[0]).toMatchObject({ AID_PUSH_TETE: t.tete, AID_PUSH_DISTANTE: '' });
    if (action === 'nettoyage')
      expect(appels[0]).toMatchObject({
        AID_CLEANUP_TETE: t.tete,
        AID_CONFIRM_UNMERGED: '3',
        AID_DIRTY_ACTION: 'force',
      });
  });
}
test('numéro toujours : corps signé, journaux, événements et liste sans numéro ; cookie seul ; faux numéro signé annulé', async () => {
  const t = await preparer('reglage');
  const evenements: unknown[] = [];
  t.store.on('ephemeral', (e) => evenements.push(e));
  const { confirmation: id } = (await t.demander()).json<{ confirmation: string }>();
  const numero = t.ligne(id).numero_mac as string;
  expect(numero).toMatch(/^\d{4}$/);
  const enveloppe = t.relais.deposer.mock.calls[0]![1];
  const corps = await verifierEnveloppe(enveloppe, t.fournisseur.clePubliqueRaw());
  expect(corps).toMatchObject({
    v: 2,
    numero: null,
    action: 'reglage',
    echeance: (corps?.emise ?? 0) + 900000,
  });
  expect(
    (await t.app.inject({ url: `/api/confirmations/${id}/numero`, headers: t.headers })).statusCode,
  ).toBe(403);
  const r = await t.app.inject({ url: `/api/confirmations/${id}/numero`, headers: t.cookies });
  expect(r.json()).toEqual({ numero });
  expect(r.headers['cache-control']).toBe('no-store');
  const liste = await t.app.inject({ url: '/api/confirmations', headers: t.headers });
  expect(liste.json().ouvertes).toHaveLength(1);
  expect(Object.keys(liste.json().ouvertes[0]).sort()).toEqual(
    ['id', 'action', 'classe', 'resume', 'etat', 'resultat', 'raison', 'cree_a', 'echeance'].sort(),
  );
  await t.repondre(id, 'oui', true, true);
  expect(t.ligne(id)).toMatchObject({ etat: 'expiree', resultat: 'annulee', raison: 'numero' });
  expect(t.reglage.exige('merge')).toBe(true);
  expect(t.journal).toHaveBeenCalledWith('pda.numero_faux', { id, appareil: t.appareil.id });
  expect(t.relais.retirer).toHaveBeenCalledWith(id);
  expect(runScript).not.toHaveBeenCalled();
  expect(t.journal).toHaveBeenCalledWith('pda.tardive', { id });
  expect(t.journal.mock.calls.filter(([type]) => type === 'pda.numero_faux')).toHaveLength(1);
  expect(
    jsonCanonique([
      t.logs,
      t.journal.mock.calls,
      evenements,
      t.store.since(null),
      JSON.parse(liste.body),
      corps,
    ]),
  ).not.toContain(JSON.stringify(numero));
  const suivant = (await t.demander()).json<{ confirmation: string }>().confirmation;
  await t.repondre(suivant);
  expect(t.ligne(suivant).resultat).toBe('executee');
  expect(
    (await t.app.inject({ url: `/api/confirmations/${id}/numero`, headers: t.cookies })).statusCode,
  ).toBe(404);
});
test('non armée : réponse historique, sans demande', async () => {
  const t = await preparer('push', false);
  const r = await t.demander();
  expect(r.statusCode).toBe(202);
  expect(r.json()).toEqual({ actionId: expect.any(String) });
  expect(t.db.prepare('SELECT 1 FROM pda_demandes').get()).toBeUndefined();
});
test('armée sans appareil actif ou PDA coupé : refus fermé', async () => {
  const t = await preparer();
  t.couper();
  expect((await t.demander()).json()).toEqual({
    error: 'confirmation_impossible',
    message: 'Allume le PDA et active un téléphone pour cette action',
  });
  t.allumer();
  t.registre.revoquer(t.appareil.id);
  const r = await t.demander();
  expect(r.statusCode).toBe(409);
  expect(r.json().error).toBe('confirmation_impossible');
  expect(runScript).not.toHaveBeenCalled();
});
for (const reason of [undefined, 'timeout'] as const) {
  test(`échec script ${reason ?? 'sortie'} : résultat sans contenu, sans rejeu`, async () => {
    const t = await preparer();
    vi.mocked(runScript).mockResolvedValue({
      outcome: 'failed',
      exitCode: 1,
      result: {},
      tail: ['contenu privé'],
      reason,
    });
    const { confirmation: id } = (await t.demander()).json<{ confirmation: string }>();
    await t.repondre(id, 'oui', true);
    expect(t.ligne(id)).toMatchObject({
      resultat: 'echouee',
      raison: reason === 'timeout' ? 'delai' : 'script',
    });
    expect(runScript).toHaveBeenCalledTimes(1);
  });
}
test('merge : message refusé sous confirmation, tête obligatoire et relecture du nettoyage', async () => {
  const t = await preparer('merge');
  expect((await t.demander({ message: 'personnalisé' })).statusCode).toBe(422);
  t.db.prepare("DELETE FROM actions WHERE id = 'pr'").run();
  const r = await t.demander();
  expect(r.statusCode).toBe(409);
  expect(r.json().error).toBe('tête de la PR inconnue : rafraîchis la PR');
  const { confirmation: id } = (await t.demander({ head: t.tete })).json<{
    confirmation: string;
  }>();
  commitFile(t.clone, 'suite.txt', 'Suite');
  await t.repondre(id);
  expect(t.ligne(id).resultat).toBe('perimee');
  expect(runScript).not.toHaveBeenCalled();
});
test('annulation : deuxième annulation en 409, liste récente bornée à 20', async () => {
  const t = await preparer();
  for (let n = 0; n < 22; n++) {
    const { confirmation: id } = (await t.demander()).json<{ confirmation: string }>();
    expect(await t.file.annuler(id)).toBe(true);
    if (n === 0)
      expect(
        (
          await t.app.inject({
            method: 'DELETE',
            url: `/api/confirmations/${id}`,
            headers: t.headers,
          })
        ).statusCode,
      ).toBe(409);
  }
  const liste = (await t.app.inject({ url: '/api/confirmations', headers: t.headers })).json();
  expect(liste.ouvertes).toEqual([]);
  expect(liste.recentes).toHaveLength(20);
});
test('nettoyage : consommation et archivage dans la même transaction', async () => {
  const t = await preparer('nettoyage');
  const initiale = t.porte.preparerConsommation;
  const atomique = vi.spyOn(t.porte, 'preparerConsommation').mockImplementation(async (ligne) => {
    const consommer = await initiale(ligne);
    return () => {
      expect(t.db.inTransaction).toBe(true);
      expect(t.ligne(ligne.id).etat).toBe('confirmee');
      expect(t.db.prepare("SELECT state FROM topics WHERE id = 'tp'").get()).toEqual({
        state: 'active',
      });
      consommer();
      expect(t.db.prepare("SELECT state FROM topics WHERE id = 'tp'").get()).toEqual({
        state: 'archived',
      });
    };
  });
  const { confirmation: id } = (await t.demander()).json<{ confirmation: string }>();
  await t.repondre(id);
  expect(atomique).toHaveBeenCalledOnce();
  expect(t.ligne(id).resultat).toBe('executee');
});
test('retrait : un sujet ouvert après la préparation empêche toute suppression', async () => {
  const t = await preparer('projet.retirer');
  const initiale = t.definitions['projet.retirer'].preparer;
  const { confirmation: id } = (await t.demander()).json<{ confirmation: string }>();
  vi.spyOn(t.definitions['projet.retirer'], 'preparer').mockImplementation(async (entree, ctx) => {
    const params = await initiale(entree, ctx);
    t.db.prepare("UPDATE topics SET workspace_id = 'retirer' WHERE id = 'tp'").run();
    return params;
  });
  await t.repondre(id);
  expect(t.ligne(id)).toMatchObject({ resultat: 'perimee', raison: 'perime' });
  expect(t.db.prepare("SELECT id FROM workspaces WHERE id = 'retirer'").get()).toEqual({
    id: 'retirer',
  });
  expect(t.db.prepare("SELECT id FROM topics WHERE id = 'tp'").get()).toEqual({ id: 'tp' });
});
for (const action of ['merge', 'nettoyage', 'projet.retirer', 'reglage'] as const) {
  test(`${action} : chemin direct avant armement`, async () => {
    const t = await preparer(action, false);
    const r = await t.demander(action === 'merge' ? { message: 'personnalisé' } : {});
    expect(r.statusCode).toBe(action === 'projet.retirer' ? 204 : action === 'reglage' ? 200 : 202);
    expect(t.db.prepare('SELECT 1 FROM pda_demandes').get()).toBeUndefined();
    if (action === 'merge')
      expect(vi.mocked(runScript).mock.calls[0]![0].env.AID_MERGE_MESSAGE).toBe('personnalisé');
  });
}
test('réglage dispensé : direct même armé, rallumage immédiat', async () => {
  const t = await preparer();
  t.reglage.couperConfirme('push');
  expect((await t.demander()).json()).toEqual({ actionId: expect.any(String) });
  const r = await t.app.inject({
    method: 'PUT',
    url: '/api/confirmations/reglage',
    headers: t.headers,
    payload: { action: 'push', actif: true },
  });
  expect(r.statusCode).toBe(200);
  expect(t.reglage.exige('push')).toBe(true);
  expect(t.db.prepare('SELECT 1 FROM pda_demandes').get()).toBeUndefined();
});
test('numéro : une demande par défaut ne possède pas de numéro Mac accessible', async () => {
  const t = await preparer();
  const { confirmation: id } = (await t.demander()).json<{ confirmation: string }>();
  expect(t.ligne(id).numero_mac).toBeNull();
  const r = await t.app.inject({ url: `/api/confirmations/${id}/numero`, headers: t.cookies });
  expect(r.statusCode).toBe(404);
});
test('redémarrage : les ouvertes expirent sans résultat ni exécution', async () => {
  const t = await preparer();
  const { confirmation: id } = (await t.demander()).json<{ confirmation: string }>();
  await t.file.arreter();
  const executer = vi.fn();
  const file = new FilePda({
    ...t,
    relais: t.relais,
    actif: () => true,
    contexte: () => null,
    signaler: vi.fn(),
    executer,
  });
  nettoyages.push(() => file.arreter());
  expect(t.ligne(id)).toMatchObject({ etat: 'expiree', resultat: null });
  expect(executer).not.toHaveBeenCalled();
});
test('un retrait du relais en échec ne perd pas une confirmation consommée', async () => {
  const t = await preparer();
  const { confirmation: id } = (await t.demander()).json<{ confirmation: string }>();
  t.relais.retirer.mockRejectedValueOnce(new Error('indisponible'));
  await t.repondre(id, 'oui', true);
  expect(t.ligne(id).resultat).toBe('executee');
  expect(runScript).toHaveBeenCalledOnce();
});
test('une demande reste annulable et retirée du relais après coupure du PDA', async () => {
  const t = await preparer();
  const { confirmation: id } = (await t.demander()).json<{ confirmation: string }>();
  t.couper();
  await t.file.arreter();
  const r = await t.app.inject({
    method: 'DELETE',
    url: `/api/confirmations/${id}`,
    headers: t.headers,
  });
  expect(r.statusCode).toBe(204);
  expect(t.relais.retirer).toHaveBeenCalledWith(id);
  expect(t.ligne(id)).toMatchObject({ etat: 'expiree', resultat: 'annulee' });
  expect(runScript).not.toHaveBeenCalled();
});
test('récentes : une ancienne demande annulée maintenant reste en tête des résultats', async () => {
  const t = await preparer();
  for (let n = 0; n < 21; n++) {
    const { confirmation: id } = (await t.demander()).json<{ confirmation: string }>();
    await t.file.annuler(id);
  }
  t.db.prepare("UPDATE pda_demandes SET consomme_a = '2020-01-01T00:00:00.000Z'").run();
  const { confirmation: id } = (await t.demander()).json<{ confirmation: string }>();
  t.db.prepare("UPDATE pda_demandes SET cree_a = '2019-01-01T00:00:00.000Z' WHERE id = ?").run(id);
  await t.file.annuler(id);
  const liste = (await t.app.inject({ url: '/api/confirmations', headers: t.headers })).json();
  expect(liste.recentes).toHaveLength(20);
  expect(liste.recentes[0].id).toBe(id);
});

for (const cas of ['signature', 'revoque', 'echeance', 'defaut'] as const) {
  test(`faux numéro signé : ${cas}`, async () => {
    const t = await preparer(cas === 'defaut' ? 'push' : 'reglage');
    const { confirmation: id } = (await t.demander()).json<{ confirmation: string }>();
    if (cas === 'revoque') t.registre.revoquer(t.appareil.id);
    if (cas === 'echeance') t.expirer();
    await t.repondre(id, 'oui', false, true, cas === 'signature');
    if (cas === 'defaut') {
      expect(t.ligne(id)).toMatchObject({ etat: 'expiree', resultat: 'annulee', raison: 'numero' });
      expect(t.journal).toHaveBeenCalledWith('pda.numero_faux', { id, appareil: t.appareil.id });
      expect(t.relais.retirer).toHaveBeenCalledWith(id);
    } else {
      expect(t.ligne(id).resultat).not.toBe('annulee');
      if (cas !== 'echeance') expect(t.ligne(id).etat).toBe('ouverte');
      expect(t.journal).not.toHaveBeenCalledWith('pda.numero_faux', expect.anything());
      expect(t.journal).toHaveBeenCalledWith('pda.refus', {
        appareil: t.appareil.id,
        raison: { signature: 'signature', revoque: 'appareil', echeance: 'echeance' }[cas],
      });
    }
    expect(runScript).not.toHaveBeenCalled();
  });
}

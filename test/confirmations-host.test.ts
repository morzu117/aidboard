import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, expect, test, vi } from 'vitest';
import { preparerPda, assertionPda } from './helpers/pda.js';
import { FilePda } from '../src/daemon/pda/file.js';
import type { RelaisPda, ReponseRelais } from '../src/daemon/pda/relais.js';
import { creerPorte, type Action } from '../src/daemon/confirmations/porte.js';
import { creerActionsConfirmation } from '../src/daemon/confirmations/actions.js';
import { creerReglage } from '../src/daemon/confirmations/reglage.js';
import { registerConfirmationRoutes } from '../src/daemon/routes/confirmations.js';
import { registerHostRoutes } from '../src/daemon/routes/host.js';
import { createAuthState, registerSecurity, SESSION_COOKIE } from '../src/daemon/security.js';
import { AidHttpError } from '../src/daemon/errors.js';
import { resolvePaths, ensureHome } from '../src/daemon/paths.js';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import { Appairages } from '../src/daemon/host/appairage.js';
import { RegistreAppareils } from '../src/daemon/host/appareils.js';
import type { ModeHost } from '../src/daemon/host/controleur.js';

const nettoyages: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const nettoyer of nettoyages.splice(0).reverse()) await nettoyer();
});
async function preparer(arme = true, avecAppareil = true) {
  const t = preparerPda();
  nettoyages.push(t.nettoyer);
  const dossier = mkdtempSync(join(tmpdir(), 'aid-confirmations-host-'));
  nettoyages.push(() => rmSync(dossier, { recursive: true, force: true }));
  const paths = resolvePaths(dossier);
  ensureHome(paths);
  const config = structuredClone(DEFAULT_CONFIG);
  config.modeHost.actif = true;
  config.modeHost.pda = true;
  const appareil = avecAppareil ? await t.appareil() : null;
  const candidat = await t.appareil();
  t.db.prepare("UPDATE pda_appareils SET etat = 'attente' WHERE id = ?").run(candidat.id);
  const empreinte = (await t.registre.lister()).find((a) => a.id === candidat.id)!.empreinte;
  let heure = Date.now();
  const appairages = new Appairages(() => heure);
  const registre = new RegistreAppareils(t.db);
  const modeHost = {
    appairages,
    registre,
    fournisseurPush: { obtenir: vi.fn(), couper: vi.fn() },
    etat: () => ({ disponible: true }),
    portOuvert: () => null,
    nomLu: () => 'aid-e2e.ts.net',
    noterNom: vi.fn(),
  } as unknown as ModeHost;
  const logs: string[] = [];
  const app = Fastify({
    logger: {
      stream: new Writable({
        write(chunk, _enc, cb) {
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
  let reponses: ReponseRelais[] = [];
  const relais = {
    publierAutorises: vi.fn<RelaisPda['publierAutorises']>(async () => true),
    deposer: vi.fn<RelaisPda['deposer']>(async () => true),
    retirer: vi.fn<RelaisPda['retirer']>(async () => {}),
    tirer: vi.fn<RelaisPda['tirer']>(async () => reponses),
  };
  const pda = { obtenir: () => file, synchroniser: vi.fn(async () => {}) };
  const definitions = creerActionsConfirmation({
    db: t.db,
    config,
    paths,
    modeHost,
    pda,
    journal: (type, donnees) => app.log.info(donnees, type),
  });
  const porte = creerPorte({ db: t.db, actions: definitions, file: () => file });
  const file = new FilePda({
    ...t,
    relais,
    actif: () => config.modeHost.pda,
    contexte: () => ({ origine: 'https://aid-e2e.ts.net', rpId: 'aid-e2e.ts.net' }),
    maintenant: () => heure,
    signaler: vi.fn(),
    executer: (ligne) => porte.executerConfirmee(ligne),
  });
  nettoyages.push(() => file.arreter());
  const reglage = creerReglage(t.db);
  if (arme) reglage.armer();
  registerConfirmationRoutes(app, t.db, porte, () => file);
  registerHostRoutes(app, {
    config,
    paths,
    db: t.db,
    getPort: () => 12345,
    modeHost,
    pda,
    porte,
    tailscaleExec: async () => ({ stdout: '', code: 'ENOENT' }),
  });
  const headers = { host: '127.0.0.1:12345', authorization: `Bearer ${auth.adminToken}` };
  const cookies = {
    host: headers.host,
    origin: 'http://127.0.0.1:12345',
    cookie: `${SESSION_COOKIE}=${auth.sessionToken}`,
    'sec-fetch-site': 'same-origin',
  };
  const envoyer = (
    url: string,
    payload: object = {},
    ui = false,
    method: 'POST' | 'PUT' | 'DELETE' = 'POST',
  ) =>
    app.inject({
      method,
      url,
      headers: ui ? cookies : headers,
      ...(method !== 'DELETE' && { payload }),
    });
  const ligne = (id: string) =>
    t.db.prepare('SELECT * FROM pda_demandes WHERE id = ?').get(id) as Record<string, unknown>;
  const activer = (ui = false, marque: unknown = empreinte) =>
    envoyer(`/api/host/pda/appareils/${candidat.id}/activer`, { empreinte: marque }, ui);
  const apparier = (identite: string | null = null) => {
    const d = appairages.creer();
    appairages.reclamer({ code: d.code, nom: 'Téléphone', identite, source: '' });
    return envoyer(`/api/host/appairages/${d.id}/approuver`, { sansIdentite: true });
  };
  async function repondre(id: string, valeur: 'oui' | 'non' = 'oui') {
    t.db.prepare('UPDATE pda_demandes SET numero = numero_mac WHERE id = ?').run(id);
    const corps = await assertionPda(t.db, id, appareil!, valeur);
    t.db.prepare("UPDATE pda_demandes SET numero = '' WHERE id = ?").run(id);
    reponses = [
      {
        id,
        appareil: appareil!.id,
        curseur: 1,
        corps: Buffer.from(JSON.stringify(corps)).toString('base64url'),
      },
    ];
    await file.tour();
  }
  const bandeau = async () =>
    (await app.inject({ url: '/api/confirmations/reglage', headers })).json().bandeau;
  return {
    ...t,
    config,
    paths,
    definitions,
    app,
    porte,
    reglage,
    appareil,
    candidat,
    empreinte,
    appairages,
    registreHost: registre,
    logs,
    relais,
    headers,
    cookies,
    envoyer,
    activer,
    apparier,
    repondre,
    ligne,
    bandeau,
    expirer: () => {
      heure += 5 * 60_000 + 1;
    },
  };
}

for (const action of ['appairage', 'pda.activer', 'code', 'push'] as const) {
  for (const cas of ['oui', 'non', 'perimee', 'direct'] as const) {
    if (cas === 'perimee' && (action === 'code' || action === 'push')) continue;
    test(`${action} : ${cas}`, async () => {
      const t = await preparer(cas !== 'direct');
      const r =
        action === 'appairage'
          ? await t.apparier()
          : action === 'pda.activer'
            ? await t.activer(cas === 'direct')
            : await t.envoyer(`/api/host/${action}`, { actif: true }, false, 'PUT');
      if (cas === 'direct') {
        expect(r.statusCode).toBe(200);
        expect(t.db.prepare('SELECT 1 FROM pda_demandes').get()).toBeUndefined();
      } else {
        expect(r.statusCode).toBe(202);
        const id = r.json().confirmation;
        expect(t.ligne(id)).toMatchObject({
          classe: 'toujours',
          numero_mac: expect.stringMatching(/^\d{4}$/),
        });
        if (cas === 'perimee') {
          if (action === 'appairage') t.expirer();
          else t.registre.revoquer(t.candidat.id);
        }
        await t.repondre(id, cas === 'non' ? 'non' : 'oui');
        expect(t.ligne(id)).toMatchObject(
          cas === 'non'
            ? { etat: 'refusee', resultat: null }
            : { resultat: cas === 'oui' ? 'executee' : 'perimee' },
        );
      }
      if (cas === 'oui' || cas === 'direct') {
        if (action === 'appairage') expect(t.appairages.vueMac()?.etat).toBe('approuvee');
        else if (action === 'pda.activer')
          expect(t.registre.actif(t.candidat.id)?.actif).toBe(true);
        else expect(t.config.modeHost[action]).toBe(true);
      }
    });
  }
}

test('identité : seul le SHA-256 UTF-8 passe dans la demande ; changement périmé', async () => {
  const t = await preparer();
  const identite = 'é'.repeat(100);
  const r = await t.apparier(identite);
  expect(r.statusCode).toBe(202);
  const id = r.json().confirmation;
  expect(JSON.parse(t.ligne(id).params as string)).toEqual({
    appairageId: t.appairages.vueMac()!.id,
    nom: 'Téléphone',
    hIdentite: createHash('sha256').update(identite, 'utf8').digest('base64url'),
    sansIdentite: true,
  });
  expect(t.ligne(id).params).not.toContain(identite);
  const vue = t.appairages.vueMac.bind(t.appairages);
  vi.spyOn(t.appairages, 'vueMac').mockImplementation(() => ({
    ...vue()!,
    identite: 'autre@example.com',
  }));
  await t.repondre(id);
  expect(t.ligne(id).resultat).toBe('perimee');
  expect(t.logs.join('')).not.toContain(identite);
});

for (const arme of [false, true]) {
  test(`amorçage cookie seul, empreinte exigée, journal minimal (armé=${arme})`, async () => {
    const t = await preparer(arme, false);
    expect((await t.activer()).statusCode).toBe(403);
    expect((await t.activer()).json()).toEqual({ error: 'amorcage_ui_seulement' });
    expect((await t.activer(true, 'FAUX')).statusCode).toBe(409);
    expect((await t.activer(true, null)).statusCode).toBe(409);
    expect(
      (await t.envoyer(`/api/host/pda/appareils/${t.candidat.id}/activer`, {}, true)).statusCode,
    ).toBe(409);
    expect((await t.activer(true)).statusCode).toBe(200);
    expect(t.reglage.arme()).toBe(true);
    expect(t.registre.actif(t.candidat.id)?.actif).toBe(true);
    expect(await t.bandeau()).toBe('amorcage');
    const evenement = t.logs.map((l) => JSON.parse(l)).find((l) => l.msg === 'pda.amorcage');
    expect(evenement.appareil).toBe(t.candidat.id);
    expect(
      Object.keys(evenement).filter(
        (k) => !['level', 'time', 'pid', 'hostname', 'msg'].includes(k),
      ),
    ).toEqual(['appareil']);
  });
}

test('installation 43 : un appareil actif sans armement impose encore le cookie et arme', async () => {
  const t = await preparer(false);
  expect((await t.activer()).statusCode).toBe(403);
  expect((await t.activer(true)).statusCode).toBe(200);
  expect(t.reglage.arme()).toBe(true);
  expect(await t.bandeau()).toBeNull();
});

test('attaque du lab : révoquer tous les PDA ne rouvre aucune action ; seul le cookie réamorce', async () => {
  const t = await preparer();
  expect((await t.envoyer(`/api/host/pda/appareils/${t.appareil!.id}/revoquer`)).statusCode).toBe(
    200,
  );
  for (const r of [
    await t.apparier(),
    await t.envoyer('/api/host/code', { actif: true }, false, 'PUT'),
    await t.envoyer('/api/host/push', { actif: true }, false, 'PUT'),
    await t.envoyer('/api/confirmations/reglage', { action: 'merge', actif: false }, false, 'PUT'),
  ]) {
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('confirmation_impossible');
  }
  expect((await t.activer()).statusCode).toBe(403);
  expect((await t.activer(true)).statusCode).toBe(200);
  expect(t.reglage.arme()).toBe(true);
});

test('désarmement : cookie, phrase exacte, confirmation avec appareil, puis réarmement idempotent', async () => {
  const t = await preparer();
  expect((await t.envoyer('/api/confirmations/desarmer', { phrase: 'DÉSARMER' })).statusCode).toBe(
    403,
  );
  expect(
    (await t.envoyer('/api/confirmations/desarmer', { phrase: 'désarmer' }, true)).statusCode,
  ).toBe(400);
  const r = await t.envoyer('/api/confirmations/desarmer', { phrase: 'DÉSARMER' }, true);
  expect(r.statusCode).toBe(202);
  expect(t.reglage.arme()).toBe(true);
  await t.repondre(r.json().confirmation);
  expect(t.ligne(r.json().confirmation).resultat).toBe('executee');
  expect(t.reglage.arme()).toBe(false);
  expect(await t.bandeau()).toBe('desarme');
  expect(
    (await t.envoyer('/api/confirmations/desarmer', { phrase: 'DÉSARMER' }, true)).statusCode,
  ).toBe(409);
  expect((await t.envoyer('/api/confirmations/armer')).statusCode).toBe(200);
  const avant = t.reglage.lireArmement();
  await t.envoyer('/api/confirmations/armer');
  expect(t.reglage.lireArmement()).toEqual(avant);
  expect(await t.bandeau()).toBe('amorcage');
});

test('sans appareil : désarmement direct, journal sans contenu et bandeau jusqu’au réarmement', async () => {
  const t = await preparer(true, false);
  expect(
    (await t.envoyer('/api/confirmations/desarmer', { phrase: 'DÉSARMER' }, true)).statusCode,
  ).toBe(200);
  expect(t.db.prepare('SELECT 1 FROM pda_demandes').get()).toBeUndefined();
  expect(await t.bandeau()).toBe('desarme');
  const evenement = t.logs.map((l) => JSON.parse(l)).find((l) => l.msg === 'pda.desarmement');
  expect(
    Object.keys(evenement).filter((k) => !['level', 'time', 'pid', 'hostname', 'msg'].includes(k)),
  ).toEqual([]);
  await t.envoyer('/api/confirmations/armer');
  expect(await t.bandeau()).toBeNull();
});

for (const retrait of ['revoquer', 'couper', 'code', 'push', 'pda'] as const) {
  test(`retrait ${retrait} : immédiat une fois armé`, async () => {
    const t = await preparer();
    t.config.modeHost.code = true;
    t.config.modeHost.push = true;
    const acces = t.registreHost.emettre({ nom: 'Exemple', identite: null });
    const url =
      retrait === 'revoquer'
        ? `/api/host/pda/appareils/${t.appareil!.id}/revoquer`
        : `/api/host/${retrait}`;
    const r = await t.envoyer(
      url,
      { actif: false },
      false,
      ['code', 'push', 'pda'].includes(retrait) ? 'PUT' : 'POST',
    );
    expect(r.statusCode).toBe(200);
    expect(t.db.prepare('SELECT 1 FROM pda_demandes').get()).toBeUndefined();
    expect(t.reglage.arme()).toBe(true);
    if (retrait === 'revoquer') expect(t.registre.actif(t.appareil!.id)?.actif).toBe(false);
    else if (retrait === 'couper')
      expect(t.registreHost.authentifier(acces.jeton)).toEqual({ ok: false, raison: 'revoque' });
    else expect(t.config.modeHost[retrait]).toBe(false);
  });
}

for (const action of ['appairage', 'pda.activer'] as const) {
  test(`${action} : état changé entre preparer et executer, aucun effet`, async () => {
    const t = await preparer();
    const r = action === 'appairage' ? await t.apparier() : await t.activer();
    const definition = t.definitions[action] as Action<'appairage' | 'pda.activer'>;
    const initiale = definition.preparer;
    vi.spyOn(definition, 'preparer').mockImplementation(async (entree, ctx) => {
      const params = await initiale(entree, ctx);
      if (action === 'appairage') t.expirer();
      else t.registre.revoquer(t.candidat.id);
      return params;
    });
    await t.repondre(r.json().confirmation);
    expect(t.ligne(r.json().confirmation).resultat).toBe('perimee');
    if (action === 'appairage') expect(t.appairages.vueMac()?.etat).toBe('expiree');
    else expect(t.registre.actif(t.candidat.id)?.actif).toBe(false);
  });
}

test('host.option actif false : aucune demande même via la porte', async () => {
  const t = await preparer();
  await expect(
    t.porte.demander('host.option', { option: 'code', actif: false }, {
      principal: { kind: 'admin', via: 'bearer' },
    } as never),
  ).rejects.toMatchObject({ status: 400 });
  expect(t.db.prepare('SELECT 1 FROM pda_demandes').get()).toBeUndefined();
});

test('host.option : configuration invalide refusée avant demande et périmée au rejeu', async () => {
  const t = await preparer();
  const r = await t.envoyer('/api/host/code', { actif: true }, false, 'PUT');
  expect(r.statusCode).toBe(202);
  writeFileSync(t.paths.config, 'modeHost: false\n');
  expect((await t.envoyer('/api/host/push', { actif: true }, false, 'PUT')).statusCode).toBe(409);
  await t.repondre(r.json().confirmation);
  expect(t.ligne(r.json().confirmation).resultat).toBe('perimee');
  expect(t.config.modeHost.code).toBe(false);
  expect(t.db.prepare('SELECT count(*) AS n FROM pda_demandes').get()).toEqual({ n: 1 });
});

test('révocation d’un accès host : immédiate même armé', async () => {
  const t = await preparer();
  const acces = t.registreHost.emettre({ nom: 'Exemple', identite: null });
  const r = await t.envoyer(`/api/host/appareils/${acces.appareil.id}`, {}, false, 'DELETE');
  expect(r.statusCode).toBe(200);
  expect(t.registreHost.authentifier(acces.jeton)).toEqual({ ok: false, raison: 'revoque' });
  expect(t.reglage.arme()).toBe(true);
  expect(t.db.prepare('SELECT 1 FROM pda_demandes').get()).toBeUndefined();
});

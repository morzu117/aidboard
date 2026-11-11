import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import type { Server } from 'node:https';
import { createServer } from 'node:net';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { expect, test } from '@playwright/test';
import { appairerHost, demarrerHost, ORIGINE_APPAREIL } from './host-helpers.js';
import { createTopic, fermerContextes, newRepo, node, registerWorkspace } from './helpers.js';
import { NOM_E2E, ouvrirServeLocal } from './serve-local.js';

const PORT = Number(process.env.AID_E2E_PORT ?? 4871) + 9;
const FRONTAL = PORT + 30;
const FRONTAL_RELAIS = PORT + 31;
const RELAIS = 'https://relais.aid-e2e.example';
const CLI = join(import.meta.dirname, '../dist/cli/aid.js');
test.use({
  launchOptions: {
    args: [
      `--host-resolver-rules=MAP ${NOM_E2E}:443 127.0.0.1:${FRONTAL}, MAP relais.aid-e2e.example:443 127.0.0.1:${FRONTAL_RELAIS}`,
      '--ignore-certificate-errors',
      '--no-proxy-server',
    ],
  },
});

async function portLibre() {
  const serveur = createServer();
  await new Promise<void>((resolve) => serveur.listen(0, '127.0.0.1', resolve));
  const port = (serveur.address() as { port: number }).port;
  await new Promise<void>((resolve) => serveur.close(() => resolve()));
  return port;
}
async function fermer(serveur?: Server) {
  if (!serveur) return;
  serveur.closeAllConnections();
  await new Promise<void>((resolve) => serveur.close(() => resolve()));
}
async function arreter(relais?: ChildProcess) {
  if (!relais || relais.exitCode !== null) return;
  const fin = once(relais, 'exit');
  relais.kill('SIGTERM');
  await fin;
}

test('A-I-D : sujets reliés, création et déplacement confirmé sur un faux proxy', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  let home = '';
  let frontal: Server | undefined;
  let frontalRelais: Server | undefined;
  let relais: ChildProcess | undefined;
  let base: Database.Database | undefined;
  const portRelais = await portLibre();
  const fixtures = join(import.meta.dirname, '../test/fixtures/board');
  const lire = (nom: string) => JSON.parse(readFileSync(join(fixtures, nom), 'utf8'));
  const cartes = lire('cards-list-42.json');
  const mouvements: Record<string, unknown>[] = [];
  const verbes: string[] = [];
  let interdit = false;
  const proxy = createServer((connexion) => {
    let tampon = '';
    connexion.on('error', () => undefined);
    connexion.on('data', (morceau) => {
      tampon += morceau.toString();
      if (!tampon.includes('\n')) return;
      const requete = JSON.parse(tampon.split('\n')[0]!);
      const { verb, args } = requete;
      verbes.push(verb);
      let body: unknown = {};
      if (verb === 'board.cards.move') mouvements.push(requete);
      else if (verb === 'board.projects.list') body = lire('projects-list.json');
      else if (verb === 'board.cards.list')
        body = args.q
          ? {
              ...cartes,
              cards: cartes.cards.filter((c: { body: string }) => c.body.includes('AID: ')),
              searched: cartes.cards.length,
            }
          : cartes;
      else if (verb === 'board.card.get')
        body = {
          ...lire(`cards-show-${args.id === 103 ? 101 : args.id}.json`),
          ...cartes.cards.find((c: { id: number }) => c.id === args.id),
        };
      else if (verb === 'board.cards.graph')
        body = lire(`cards-graph-${args.id === 103 ? 101 : args.id}.json`);
      else if (verb === 'board.cards.thread')
        body = lire(`cards-thread-${args.id === 103 ? 101 : args.id}.json`);
      else if (verb === 'board.obligations.list') body = { obligations: [] };
      const refus = verb === 'board.cards.move' && interdit;
      connexion.end(
        JSON.stringify({
          request_id: requete.request_id,
          ...(refus
            ? {
                ok: false,
                error: 'upstream_error',
                status: 403,
                detail: 'execute requis ; swarph board cards confirm-flow',
              }
            : { ok: true, status: 200, body }),
        }) + '\n',
      );
    });
  });
  const socket = join('/tmp', `aid-board-42-${process.pid}.sock`);
  await new Promise<void>((resolve) => proxy.listen(socket, resolve));
  try {
    const ancienGh = process.env.AID_GH_BIN;
    process.env.AID_GH_BIN = join(import.meta.dirname, '../test/fixtures/fake-gh.sh');
    const ancien = process.env.NODE_OPTIONS;
    const ancienPort = process.env.AID_E2E_RELAIS_PORT;
    let instance: ReturnType<typeof demarrerHost>;
    try {
      process.env.NODE_OPTIONS = `${ancien ?? ''} --import ${pathToFileURL(join(import.meta.dirname, 'pda-fetch.mjs')).href}`;
      process.env.AID_E2E_RELAIS_PORT = String(portRelais);
      instance = demarrerHost(
        PORT,
        `  bin: ${join(import.meta.dirname, '../test/fixtures/fake-swarph.sh')}
  cell: peer-a
  gateway: https://example.com
  proxySocket: ${socket}
  inboxLog: ${socket}.inbox
  proxyLectureSeule: false`,
      );
      home = instance.home;
    } finally {
      if (ancienGh === undefined) delete process.env.AID_GH_BIN;
      else process.env.AID_GH_BIN = ancienGh;
      if (ancien === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = ancien;
      if (ancienPort === undefined) delete process.env.AID_E2E_RELAIS_PORT;
      else process.env.AID_E2E_RELAIS_PORT = ancienPort;
    }
    base = new Database(join(home, 'state.db'));
    frontal = await ouvrirServeLocal({ dir: home, port: FRONTAL, versPort: PORT + 20 });
    frontalRelais = await ouvrirServeLocal({
      dir: home,
      port: FRONTAL_RELAIS,
      versPort: portRelais,
    });
    const mac = await (await browser.newContext()).newPage();
    await mac.goto(`http://127.0.0.1:${PORT}/?token=${instance.token}`);
    await mac.goto(`http://127.0.0.1:${PORT}/machines`);
    const lancerRelais = async () => {
      const cle = await mac.evaluate(
        async () => (await (await fetch('/api/host/pda/cle')).json()).clePublique as string,
      );
      relais = spawn(
        process.execPath,
        [
          CLI,
          'relais',
          '--hote',
          '127.0.0.1',
          '--port',
          String(portRelais),
          '--origine',
          ORIGINE_APPAREIL,
          '--cle-daemon',
          cle,
        ],
        { stdio: 'ignore' },
      );
      await expect
        .poll(async () => {
          try {
            return (await fetch(`http://127.0.0.1:${portRelais}/`)).status;
          } catch {
            return 0;
          }
        })
        .toBe(404);
    };
    await lancerRelais();
    await mac.getByLabel('Adresse du relais').fill(RELAIS);
    mac.once('dialog', (d) => d.accept());
    await mac.getByRole('switch', { name: 'PDA :' }).click();
    await expect(mac.getByRole('switch', { name: 'PDA :' })).toBeChecked();
    const telephone = await appairerHost(browser, mac, PORT, 'Téléphone PDA');
    const cdp = await telephone.context().newCDPSession(telephone);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
      },
    });
    const enregistrer = async (nom: string) => {
      await telephone.goto(`${ORIGINE_APPAREIL}/pda/enregistrer`);
      await telephone.getByLabel('Nom de cet appareil').fill(nom);
      await telephone
        .getByRole('button', { name: 'Enregistrer cet appareil', exact: true })
        .click();
      await expect(telephone.locator('.pda-empreinte')).toBeVisible();
      const empreinte = (await telephone.locator('.pda-empreinte').textContent())!;
      await mac.reload();
      const ligne = mac.getByRole('listitem').filter({ hasText: nom });
      await expect(ligne.locator('code')).toHaveText(empreinte);
      mac.once('dialog', async (d) => {
        expect(d.message()).toContain(empreinte);
        await d.accept();
      });
      await ligne.getByRole('button', { name: 'Activer', exact: true }).click();
      await expect(ligne.getByText('actif', { exact: true })).toBeVisible();
      await telephone.goto(`${ORIGINE_APPAREIL}/pda`);
    };
    const macUrl = `http://127.0.0.1:${PORT}`;
    await mac.context().addInitScript(() => localStorage.setItem('aid-e2e', '1'));
    await mac.goto(macUrl);
    await mac.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const depot = newRepo('depot');
    await registerWorkspace(mac, depot);
    const lie = await createTopic(mac, 'Sujet relié');
    await mac.goto(`${macUrl}/sujets/nouveau`);
    const sans = await createTopic(mac, 'Sujet sans carte');
    await mac.goto(`${macUrl}/sujets/nouveau`);
    const nonAssigne = await createTopic(mac, 'Sujet non assigné');
    // Le dépôt reste local pour créer les worktrees ; seul get-url lit cette URL documentaire.
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/exemple/depot.git'], {
      cwd: depot,
    });
    const slug = (id: string) =>
      (base!.prepare('SELECT slug FROM topics WHERE id = ?').get(id) as { slug: string }).slug;
    Object.assign(cartes.cards[0], {
      body: `AID: exemple/depot#${slug(lie)}`,
      stage: 'build',
      stage_version: 7,
      assignee: 'peer-a',
    });
    Object.assign(cartes.cards[1], {
      body: `AID: exemple/depot#${slug(nonAssigne)}`,
      stage: 'build',
      stage_version: 3,
      assignee: null,
    });
    const relire = async () => {
      // Le cache réel du daemon expire après cinq secondes.
      await expect(async () => {
        const r = await mac.request.get(`${macUrl}/api/aid/board`, {
          headers: { origin: macUrl, 'sec-fetch-site': 'same-origin' },
        });
        expect(
          (await r.json()).sujets.find((s: { sujetId: string }) => s.sujetId === lie).carte,
        ).toBe(101);
      }).toPass({ timeout: 15_000, intervals: [1000] });
    };
    await relire();
    await mac.goto(`${macUrl}/board`);
    await expect(node(mac, 'board.carte-101')).toContainText('A-I-D · actif');
    await node(mac, 'board.carte-101').click();
    const bloc = mac
      .locator('section')
      .filter({ has: mac.getByRole('heading', { name: 'A-I-D', exact: true }) });
    await expect(bloc).toContainText('depot');
    await expect(bloc).toContainText('feat/sujet-relie');
    await expect(bloc).toContainText('0 en marche, 0 en attente, 0 terminé');
    await bloc.getByRole('link', { name: 'Ouvrir le sujet' }).click();
    await expect(mac).toHaveURL(`${macUrl}/sujets/${lie}`);
    await expect(node(mac, '1-3.entete.titre')).toHaveText('Sujet relié');
    await mac.goto(macUrl);
    const section = mac.locator('details').filter({ hasText: 'Sujets sans carte' });
    await expect(section.locator('summary')).toHaveText('Sujets sans carte (1)');
    await expect(section).not.toHaveAttribute('open');
    await section.locator('summary').click();
    await section.getByRole('button', { name: 'Copier la ligne' }).click();
    await expect
      .poll(() => mac.evaluate(() => navigator.clipboard.readText()))
      .toBe(`AID: exemple/depot#${slug(sans)}`);
    // Une carte supplémentaire sans lien permet la création, sans écrire au proxy.
    const neuve = {
      ...cartes.cards[0],
      id: 103,
      body: '',
      title: 'Titre de carte',
      assignee: null,
    };
    cartes.cards.push(neuve);
    // La fiche 103 emprunte la structure synthétique de la carte 101.
    await mac.goto(`${macUrl}/board/cartes/103`);
    await mac.getByRole('link', { name: 'Nouveau sujet', exact: true }).click();
    await expect(mac.getByLabel('Titre', { exact: true })).toHaveValue('Titre de carte');
    await node(mac, 'nouveau-sujet.travail.agent').selectOption('aucun');
    await mac.getByRole('button', { name: 'Créer le sujet', exact: true }).click();
    await expect(mac.getByRole('heading', { name: 'Sujet créé' })).toBeVisible();
    await expect(mac.locator('pre')).toHaveText('AID: exemple/depot#titre-de-carte');
    expect(mouvements).toEqual([]);
    await mac.goto(`${macUrl}/boite`);
    expect(
      await (
        await mac.request.get(`${macUrl}/api/aid/propositions`, {
          headers: { origin: macUrl, 'sec-fetch-site': 'same-origin' },
        })
      ).json(),
    ).toEqual([]);
    base.prepare("UPDATE topics SET phase = 'review' WHERE id IN (?, ?)").run(lie, nonAssigne);
    await mac.request.get(`${macUrl}/api/aid/board`, {
      headers: { origin: macUrl, 'sec-fetch-site': 'same-origin' },
    });
    await mac.reload();
    const proposition = mac.locator('article').filter({
      has: mac.getByRole('heading', { name: 'Déplacer la carte #101 vers review', exact: true }),
    });
    await expect(proposition).toHaveCount(1);
    const propositions = await (
      await mac.request.get(`${macUrl}/api/aid/propositions`, {
        headers: { origin: macUrl, 'sec-fetch-site': 'same-origin' },
      })
    ).json();
    expect(propositions).toHaveLength(1);
    await mac.reload();
    await expect(proposition).toHaveCount(1);
    await mac.goto(`${macUrl}/board/cartes/102`);
    await expect(
      mac.getByText('Déplacement non proposé : carte non assignée à peer-a'),
    ).toBeVisible();
    await mac.goto(`${macUrl}/machines`);
    await enregistrer('Téléphone de recette');
    const envoyer = async () => {
      await mac.goto(`${macUrl}/boite`);
      await proposition.getByRole('button', { name: 'Ouvrir', exact: true }).click();
      const dialogue = mac.getByRole('dialog');
      await expect(dialogue).toContainText(
        'Déplace la carte #101 de build vers review. Aucune obligation ni message.',
      );
      const reponse = mac.waitForResponse(
        (r) => r.url().endsWith('/api/swarph/etat/envoyer') && r.request().method() === 'POST',
      );
      await dialogue.getByRole('button', { name: 'Envoyer', exact: true }).click();
      expect((await reponse).status()).toBe(202);
      await expect(dialogue.getByText('En attente de confirmation sur le téléphone')).toBeVisible();
      return dialogue;
    };
    const oui = async () => {
      const numero = mac.locator('strong').filter({ hasText: /^\d{4}$/ });
      await expect(numero).toBeVisible();
      const valeur = (await numero.textContent())!;
      await telephone.goto(`${ORIGINE_APPAREIL}/pda`);
      await telephone.getByRole('button', { name: 'Actualiser' }).click();
      await telephone.getByLabel(/^Retape le numéro/).fill(valeur);
      await telephone.getByRole('button', { name: 'Confirmer', exact: true }).click();
    };
    await envoyer();
    expect(mouvements).toEqual([]);
    await oui();
    await expect.poll(() => mouvements.length, { timeout: 30_000 }).toBe(1);
    expect(mouvements[0]).toEqual({
      verb: 'board.cards.move',
      args: { id: 101, stage: 'review', expect_stage: 'build', expect_stage_version: 7 },
      request_id: expect.any(String),
    });
    await expect(proposition).toHaveCount(0, { timeout: 30_000 });
    await mac.reload();
    expect(
      await (
        await mac.request.get(`${macUrl}/api/aid/propositions`, {
          headers: { origin: macUrl, 'sec-fetch-site': 'same-origin' },
        })
      ).json(),
    ).toEqual([]);
    expect(mouvements).toHaveLength(1);
    // Nouveau changement local : le proxy refuse cette fois l'écriture.
    interdit = true;
    base.prepare("UPDATE topics SET state = 'merged' WHERE id = ?").run(lie);
    await mac.request.get(`${macUrl}/api/aid/board`, {
      headers: { origin: macUrl, 'sec-fetch-site': 'same-origin' },
    });
    await mac.goto(`${macUrl}/boite`);
    const refus = mac.locator('article').filter({ hasText: 'Déplacer la carte #101 vers ready' });
    await refus.getByRole('button', { name: 'Ouvrir', exact: true }).click();
    await mac.getByRole('dialog').getByRole('button', { name: 'Envoyer', exact: true }).click();
    await oui();
    await expect(
      mac.getByRole('dialog').getByRole('status').filter({ hasText: 'Droit manquant' }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(mac.getByRole('dialog')).not.toContainText(
      'execute requis ; swarph board cards confirm-flow',
    );
    await expect(mac.getByRole('button', { name: /confirm-flow/ })).toHaveCount(0);
    await expect(mac.getByRole('link', { name: /confirm-flow/ })).toHaveCount(0);
    expect(mouvements).toHaveLength(2);
    expect(
      verbes.every((v) =>
        [
          'board.projects.list',
          'board.cards.list',
          'board.card.get',
          'board.cards.graph',
          'board.cards.thread',
          'board.obligations.list',
          'board.cards.move',
        ].includes(v),
      ),
    ).toBe(true);
  } finally {
    await Promise.allSettled([
      fermerContextes(browser),
      arreter(relais),
      fermer(frontalRelais),
      fermer(frontal),
    ]);
    base?.close();
    if (home)
      execFileSync(process.execPath, [CLI, 'stop', '--force'], {
        env: { ...process.env, AID_HOME: home },
        timeout: 30_000,
      });
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    rmSync(socket, { force: true });
    if (home) rmSync(home, { recursive: true, force: true });
  }
});

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { node, openApp } from './helpers.js';
import { fermerContextes } from './helpers.js';

// 24.9 : le board swarph en lecture seule, de bout en bout sur le faux swarph et les fixtures synthétiques
// (global-setup : FAKE_SWARPH_BOARD, FAKE_SWARPH_BOARD_ERROR_FILE). Aucun réseau, aucun vrai swarph.

const CLI = join(import.meta.dirname, '../dist/cli/aid.js');
const home = () => process.env.AID_E2E_HOME!;
const swarphLog = () => join(home(), 'swarph.log');
const inboxLog = () => join(home(), 'swarph_state', 'morzu-mac', 'mesh-sidecar', 'inbox.log');
const erreur = (kind: string | null) => {
  const f = join(home(), 'board-error');
  if (kind) writeFileSync(f, `${kind}\n`);
  else rmSync(f, { force: true });
};
const lignes = () =>
  existsSync(swarphLog()) ? readFileSync(swarphLog(), 'utf8').split('\n').filter(Boolean) : [];
// inbox.log n'est jamais écrit ici : un DM ajouté fausserait les compteurs de mesh.spec
const inbox = () => (existsSync(inboxLog()) ? readFileSync(inboxLog(), 'utf8') : null);

let avant: { log: number; inbox: string | null };
test.beforeAll(() => {
  erreur(null);
  avant = { log: lignes().length, inbox: inbox() };
});
test.afterAll(() => erreur(null));
test.afterAll(({ browser }) => fermerContextes(browser));

test('le board du projet de test : lien dans la barre, colonnes dans l’ordre reçu, cartes', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext());
  await node(page, '1-1.barre.nav-board').click();
  await expect(page).toHaveURL(/\/board$/);
  await expect(node(page, 'board.identite')).toContainText('morzu-mac');
  await expect(node(page, 'board.projet')).toContainText('projet-test');
  await expect(page.locator('.board-colonne-titre')).toHaveText(['idea 1', 'build 1']);
  await expect(node(page, 'board.carte-101')).toContainText('projet-test · #101');
  await expect(node(page, 'board.carte-101')).toContainText('sans responsable');
  await expect(node(page, 'board.carte-102')).toContainText('peer-b');
  await expect(node(page, 'board.pastille')).toHaveText(/Board lu il y a \d+ s/);
});

test('la fiche : corps brut, graphe, fil, obligation retirée fermée', async ({ browser }) => {
  const page = await openApp(await browser.newContext());
  await node(page, '1-1.barre.nav-board').click();
  await node(page, 'board.carte-101').click();
  await expect(page).toHaveURL(/\/board\/cartes\/101$/);
  await expect(node(page, 'carte-board.titre')).toHaveText('Carte de test sans responsable');
  await expect(node(page, 'carte-board.corps.texte')).toContainText('<b>pas du HTML</b>');
  await expect(node(page, 'carte-board.corps.texte').locator('b')).toHaveCount(0);
  await expect(node(page, 'carte-board.graphe.manque')).toHaveText('build, validate');
  await expect(node(page, 'carte-board.graphe.etape-0')).toContainText(/unstaffable .* then ask\)/);
  await expect(node(page, 'carte-board.fil').locator('.carte-board-auteur')).toHaveText([
    'peer-a',
    'peer-b',
  ]);
  await expect(page.locator('.carte-board-fil script')).toHaveCount(0);
  await expect(node(page, 'carte-board.obligation-9101')).toContainText('withdrawn');
  await node(page, 'carte-board.retour').click();
  // retour au projet de la carte
  await expect(page).toHaveURL(/\/board\?projet=42$/);
});

test('403 : « Tu ne peux pas lire cette carte », retour au board', async ({ browser }) => {
  const page = await openApp(await browser.newContext());
  erreur('forbidden');
  // carte jamais lue dans ce fichier : pas de cache du daemon
  await page.goto(`${process.env.AID_E2E_URL}/board/cartes/102`);
  await expect(node(page, 'carte-board.corps.message')).toContainText(
    'Tu ne peux pas lire cette carte',
  );
  erreur(null);
  await node(page, 'carte-board.corps.message.retour').click();
  await expect(page).toHaveURL(/\/board$/);
});

test('la carte 102 : chronologie décroissante, filtre Fil et lignes antérieures', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext());
  await node(page, '1-1.barre.nav-board').click();
  await node(page, 'board.carte-102').click();
  await node(page, 'carte-board.relire').click();
  const chronologie = node(page, 'carte-board.chronologie');
  await expect(chronologie.getByRole('heading', { name: 'Chronologie' })).toBeVisible();
  const textes = chronologie.locator('li .carte-board-texte');
  const attendus = [
    'Obligation build fermée : PASS',
    'Obligation build modifiée',
    'Obligation build prise',
    'Étape → build (déduite par le gateway, ligne 9000)',
    'Build commencé.',
    'Étape → idea',
    'Obligation build ouverte pour peer-b',
  ];
  await expect(textes).toHaveText(attendus);
  for (const source of ['etape', 'obligation', 'fil']) {
    await expect(node(page, `carte-board.chronologie.filtre-${source}`)).toBeChecked();
  }
  await expect(node(page, 'carte-board.chronologie.limites')).toHaveText(
    '2 lignes antérieures, sans leurs événements',
  );
  await node(page, 'carte-board.chronologie.filtre-fil').uncheck();
  await expect(textes).toHaveText(attendus.filter((texte) => texte !== 'Build commencé.'));
  await expect(node(page, 'carte-board.fil')).toContainText('Build commencé.');
  await node(page, 'carte-board.chronologie.filtre-fil').check();
  await expect(textes).toHaveText(attendus);
});

test('gateway injoignable puis rétabli : tout revient après Relire', async ({ browser }) => {
  const page = await openApp(await browser.newContext());
  await node(page, '1-1.barre.nav-board').click();
  await expect(node(page, 'board.carte-101')).toBeVisible();
  erreur('unreachable');
  await node(page, 'board.relire').click();
  await expect(node(page, 'board.message')).toContainText('Le gateway ne répond pas');
  erreur(null);
  await node(page, 'board.message.relire').click();
  await expect(node(page, 'board.message')).toHaveCount(0);
  await expect(node(page, 'board.carte-101')).toBeVisible();
});

test('swarph trop ancien (code 2) : « Mets à jour swarph » et aid doctor', async ({ browser }) => {
  const page = await openApp(await browser.newContext());
  await node(page, '1-1.barre.nav-board').click();
  await expect(node(page, 'board.carte-101')).toBeVisible();
  erreur('too-old');
  await node(page, 'board.relire').click();
  await expect(node(page, 'board.message')).toContainText('Mets à jour swarph');
  await expect(node(page, 'board.message.doctor')).toContainText('aid doctor');
  erreur(null);
});

test('aucune lecture ne consomme : inbox.log identique, journal limité au board en --json --as', () => {
  expect(inbox()).toBe(avant.inbox);
  const nouvelles = lignes().slice(avant.log);
  const board = nouvelles.filter((l) => l.startsWith('board '));
  expect(board.length).toBeGreaterThan(0);
  for (const l of board) expect(l).toMatch(/ --json --as morzu-mac$/);
  for (const l of nouvelles) expect(l).not.toMatch(/\binbox\b|--consume|--no-redact|--token-file/);
});

test('sans mesh.cell : ni lien Board ni route', async ({ browser }) => {
  // un second daemon, sans mesh, sur le port suivant ; arrêté à la fin quoi qu'il arrive
  const port = Number(process.env.AID_E2E_PORT ?? 4871) + 1;
  const autre = realpathSync(mkdtempSync(join(tmpdir(), 'aid-e2e-sans-mesh-')));
  writeFileSync(join(autre, 'config.yaml'), `port: ${port}\nagents:\n  transport: pty\n`, {
    mode: 0o600,
  });
  const env = {
    ...process.env,
    AID_HOME: autre,
    AID_NO_BROWSER: '1',
    SHELL: '/bin/sh',
    PATH: `${join(import.meta.dirname, '../test/fixtures/bin')}${delimiter}${process.env.PATH}`,
  };
  execFileSync(process.execPath, [CLI], { env, timeout: 40_000 });
  try {
    const { token } = JSON.parse(readFileSync(join(autre, 'daemon.json'), 'utf8')) as {
      token: string;
    };
    const page = await (await browser.newContext()).newPage();
    await page.goto(`http://127.0.0.1:${port}/?token=${token}`);
    await expect(node(page, '1-1.barre.marque')).toBeVisible();
    await expect(node(page, '1-1.barre.nav-consignes')).toBeVisible();
    await expect(node(page, '1-1.barre.nav-board')).toHaveCount(0);
    await page.goto(`http://127.0.0.1:${port}/board`);
    await expect(page).toHaveURL(new RegExp(`127\\.0\\.0\\.1:${port}/$`));
    // chantier 30 (D165, lab 91283) : hors navigateur, le cookie seul vaut 403 ; la marque du cockpit
    const r = await page.request.get(`http://127.0.0.1:${port}/api/board/projects`, {
      headers: { 'x-aid-cockpit': '1' },
    });
    expect(r.status()).toBe(404);
  } finally {
    execFileSync(process.execPath, [CLI, 'stop', '--force'], { env, timeout: 30_000 });
  }
});

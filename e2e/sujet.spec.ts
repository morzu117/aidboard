import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { createTopic, newRepo, node, registerWorkspace } from './helpers.js';
import { fermerContextes } from './helpers.js';

test.afterAll(({ browser }) => fermerContextes(browser));

// Chantier 26 : l'écran Sujet de bout en bout, sur un agent `stream`. Comme commandes-slash.spec, ce spec lance
// son propre daemon, en `stream`, devant le faux claude structuré (test/fixtures/bin-stream), sur le port qui
// suit celui des e2e ; il l'arrête à la fin. AID_HOME temporaire, jamais le vrai claude, aucun réseau.
const PORT = Number(
  process.env.AID_E2E_STREAM_PORT ?? Number(process.env.AID_E2E_PORT ?? 4871) + 1,
);
const CLI = join(import.meta.dirname, '../dist/cli/aid.js');
const FIXTURES = join(import.meta.dirname, '../test/fixtures');
const DN = '1-3.conversation.composer';

let home = '';
let page: Page;
let topicId = '';

function demarrer(): { url: string; token: string } {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'aid-e2e-sujet-')));
  writeFileSync(join(home, 'config.yaml'), `port: ${PORT}\nagents:\n  transport: stream\n`, {
    mode: 0o600,
  });
  const env = {
    ...process.env,
    AID_HOME: home,
    AID_NO_BROWSER: '1',
    SHELL: '/bin/sh',
    PATH: `${join(FIXTURES, 'bin-stream')}${delimiter}${process.env.PATH}`,
  };
  execFileSync(process.execPath, [CLI], { env, timeout: 40_000 });
  const info = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as { token: string };
  return { url: `http://127.0.0.1:${PORT}`, token: info.token };
}

async function ouvrir(browser: Browser): Promise<Page> {
  const { url, token } = demarrer();
  const context = await browser.newContext();
  await context.addInitScript(() => localStorage.setItem('aid-e2e', '1'));
  const p = await context.newPage();
  await p.goto(`${url}/?token=${token}`);
  await expect(node(p, '1-1.barre.marque')).toBeVisible();
  return p;
}

const champ = () => node(page, `${DN}.champ`);
const menuPlus = () => node(page, '1-3.actions.plus');

async function taper(text: string): Promise<void> {
  await champ().fill('');
  await champ().pressSequentially(text);
}

test.describe.serial('écran Sujet (chantier 26)', () => {
  test.beforeAll(async ({ browser }) => {
    page = await ouvrir(browser);
    await registerWorkspace(page, newRepo('depot-sujet'));
    topicId = await createTopic(page, 'Écran sujet');
    await node(page, '1-3.vide.lancer-claude').click();
    await expect(champ()).toBeVisible();
  });

  test.afterAll(async () => {
    await page?.context().close();
    if (!home) return;
    execFileSync(process.execPath, [CLI, 'stop', '--force'], {
      env: { ...process.env, AID_HOME: home },
      timeout: 30_000,
    });
  });

  test('D113-D115 : sans phase, pas de barre ; la prochaine chose ; l’onglet dit l’état, sans rôle', async () => {
    await expect(node(page, '1-3.entete.prochaine')).toBeVisible();
    await expect(node(page, '1-3.entete.etape.ligne')).toHaveCount(0);
    // un claude `stream` neuf est au travail jusqu'à la fin de son premier tour
    await taper('bonjour');
    await champ().press('Enter');
    await expect(node(page, '1-3.conversation.fil')).toContainText('echo: bonjour');
    await expect(node(page, '1-3.terminaux.onglet-1.etat')).toHaveText('libre');
    await expect(node(page, '1-3.terminaux.onglet-1.role')).toHaveCount(0);
  });

  test('D111, D112 : renommer depuis l’en-tête, le nom atteint la barre ; épingler, archiver, et revenir', async () => {
    await menuPlus().click();
    await node(page, '1-3.actions.renommer').click();
    const nom = node(page, '1-3.entete.titre.champ');
    await nom.fill('Nom court');
    await nom.press('Enter');
    await expect(node(page, '1-3.entete.titre')).toHaveText('Nom court');
    await expect(node(page, `1-3.barre-gauche.etat.sujet-${topicId}`)).toContainText('Nom court');

    await menuPlus().click();
    await node(page, '1-3.actions.epingler').click();
    await menuPlus().click();
    await expect(node(page, '1-3.actions.epingler')).toHaveText('Désépingler');
    await node(page, '1-3.actions.epingler').click();
    await menuPlus().click();
    await expect(node(page, '1-3.actions.epingler')).toHaveText('Épingler');

    await node(page, '1-3.actions.archiver').click();
    await menuPlus().click();
    await expect(node(page, '1-3.actions.archiver')).toHaveText('Désarchiver');
    await node(page, '1-3.actions.archiver').click();
    await menuPlus().click();
    await expect(node(page, '1-3.actions.archiver')).toHaveText('Archiver');
    await menuPlus().click();

    // le nom est un placement de la barre : le titre du sujet n'a pas changé
    const nav = await page.evaluate(async () =>
      (await fetch('/api/nav', { credentials: 'same-origin' })).json(),
    );
    const p = (nav as { placements: Array<Record<string, unknown>> }).placements.find(
      (x) => x.topicId === topicId,
    );
    expect(p).toMatchObject({ displayName: 'Nom court', pinned: false, archived: false });
  });

  test('D116, D117, D120 : Permissions, Profil « Mac local » ; un tour se lit « Mac local » et s’interrompt', async () => {
    await expect(node(page, `${DN}.mode`)).toHaveText("▸▸ Demander avant d'écrire");
    await expect(node(page, `${DN}.profil`)).toContainText('claude');
    await expect(node(page, `${DN}.profil.machine`)).toHaveText('Mac local');
    await taper('tour long');
    await champ().press('Enter');
    await expect(node(page, '1-3.conversation.fil')).toContainText('tour long démarré');
    await expect(page.locator('.message-agent-serveur').last()).toHaveText('Mac local');
    await expect(node(page, `${DN}.arreter`)).toHaveText('Interrompre');
    await node(page, `${DN}.arreter`).click();
    await expect(node(page, `${DN}.arreter`)).toHaveCount(0);
  });

  test('D118 : @ liste les fichiers du worktree ; Entrée insère le chemin', async () => {
    await taper('voir @READ');
    await expect(node(page, `${DN}.mention`)).toContainText('@README.md');
    await champ().press('Enter');
    await expect(champ()).toHaveValue('voir @README.md ');
    await expect(node(page, `${DN}.mention`)).toHaveCount(0);
    await champ().fill('');
  });

  test('D119 : l’onglet Sujet montre la question en attente ; l’index est en tête de Fichiers', async () => {
    await expect(node(page, '1-3.onglets.plan')).toHaveText('Sujet');
    await expect(node(page, '1-3.panneau.decision.aucune')).toBeVisible();
    await taper('demande questions');
    await champ().press('Enter');
    await expect(node(page, '1-3.panneau.decision.question')).toBeVisible();
    await expect(node(page, '1-3.entete.prochaine')).toHaveClass(/est-attente/);
    await expect(node(page, '1-3.terminaux.onglet-1.etat')).toHaveText('attend ta réponse');
    await node(page, '1-3.panneau.decision.voir').click();
    await expect(node(page, '1-3.terminaux.onglet-1')).toHaveAttribute('aria-selected', 'true');

    await expect(node(page, '1-3.entete.index')).toHaveCount(0);
    await node(page, '1-3.onglets.fichiers').click();
    await expect(node(page, '3-4.index')).toHaveText('index absent : lecture directe');
  });
});

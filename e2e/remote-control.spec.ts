import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { createTopic, newRepo, node, registerWorkspace, fermerContextes } from './helpers.js';

test.afterAll(({ browser }) => fermerContextes(browser));

// Chantier 23 (B.1) : le chip « Remote » du composer, sur un agent claude `stream`. Comme commandes-slash.spec.ts,
// ce spec lance ses daemons, en `stream`, devant le faux claude structuré (test/fixtures/bin-stream), qui répond au
// `remote_control` sans réseau (url `https://claude.ai/code/session_fake<n>`). Le second daemon porte
// FAKE_CLAUDE_RC_REFUSE dans son environnement : son faux claude refuse. AID_HOME temporaire, jamais le vrai claude.
const BASE = Number(process.env.AID_E2E_PORT ?? 4871) + 2;
const CLI = join(import.meta.dirname, '../dist/cli/aid.js');
const FIXTURES = join(import.meta.dirname, '../test/fixtures');
const DN = '1-3.conversation.composer';
const REFUS = 'remote-control désactivé par l’organisation';

interface Daemon {
  home: string;
  page: Page;
}

function demarrer(
  port: number,
  extra: Record<string, string>,
): { home: string; url: string; token: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'aid-e2e-rc-')));
  writeFileSync(join(home, 'config.yaml'), `port: ${port}\nagents:\n  transport: stream\n`, {
    mode: 0o600,
  });
  const env = {
    ...process.env,
    ...extra,
    AID_HOME: home,
    AID_NO_BROWSER: '1',
    SHELL: '/bin/sh',
    PATH: `${join(FIXTURES, 'bin-stream')}${delimiter}${process.env.PATH}`,
  };
  execFileSync(process.execPath, [CLI], { env, timeout: 40_000 });
  const info = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as { token: string };
  return { home, url: `http://127.0.0.1:${port}`, token: info.token };
}

/** Un daemon, un dépôt, un sujet, un agent claude lancé : le composer est prêt. */
async function ouvrir(
  browser: Browser,
  port: number,
  depot: string,
  extra: Record<string, string> = {},
): Promise<Daemon> {
  const { home, url, token } = demarrer(port, extra);
  const context = await browser.newContext();
  await context.addInitScript(() => localStorage.setItem('aid-e2e', '1'));
  const page = await context.newPage();
  await page.goto(`${url}/?token=${token}`);
  await expect(node(page, '1-1.barre.marque')).toBeVisible();
  await registerWorkspace(page, newRepo(depot));
  await createTopic(page, 'Remote-control');
  await node(page, '1-3.vide.lancer-claude').click();
  await expect(node(page, `${DN}.champ`)).toBeVisible();
  return { home, page };
}

async function arreter(d: Daemon | undefined): Promise<void> {
  if (!d) return;
  await d.page.context().close();
  execFileSync(process.execPath, [CLI, 'stop', '--force'], {
    env: { ...process.env, AID_HOME: d.home },
    timeout: 30_000,
  });
}

test.describe.serial('chip Remote du composer (23 B.1)', () => {
  let d: Daemon | undefined;
  const chip = () => node(d!.page, `${DN}.remote`);
  const lien = () => node(d!.page, `${DN}.remote-lien`);
  const bascule = () => node(d!.page, `${DN}.remote-bascule`);

  test.beforeAll(async ({ browser }) => {
    d = await ouvrir(browser, BASE, 'depot-remote');
  });

  test.afterAll(async () => {
    await arreter(d);
  });

  test('le chip « Remote » est à droite du modèle, éteint', async () => {
    await expect(chip()).toHaveText('Remote');
    await expect(chip()).toHaveAttribute('data-etat', 'off');
    const modele = await node(d!.page, `${DN}.modele`).boundingBox();
    const remote = await chip().boundingBox();
    expect(remote!.x).toBeGreaterThan(modele!.x);
  });

  test('Activer → « Remote · connecté » et le lien vers la session', async () => {
    await chip().click();
    await expect(lien()).toHaveCount(0);
    await expect(bascule()).toHaveText('Activer');
    await bascule().click();
    // `connecting` à la réponse, `connected` relu au plus tard 3 s après
    await expect(chip()).toHaveText('Remote · connecté');
    await expect(chip()).toHaveAttribute('data-etat', 'connected');
    await expect(lien()).toHaveAttribute('href', /^https:\/\/claude\.ai\/code\/session_fake\d+$/);
    await expect(lien()).toHaveAttribute('target', '_blank');
    await expect(bascule()).toHaveText('Désactiver');
  });

  test('Désactiver → « Remote », plus de lien ; Échap ferme le menu', async () => {
    await bascule().click();
    await expect(chip()).toHaveText('Remote');
    await expect(lien()).toHaveCount(0);
    await expect(bascule()).toHaveText('Activer');
    await d!.page.keyboard.press('Escape');
    await expect(bascule()).toHaveCount(0);
  });
});

test.describe.serial('chip Remote : claude refuse (23 B.1)', () => {
  let d: Daemon | undefined;

  test.beforeAll(async ({ browser }) => {
    d = await ouvrir(browser, BASE + 1, 'depot-remote-refus', { FAKE_CLAUDE_RC_REFUSE: REFUS });
  });

  test.afterAll(async () => {
    await arreter(d);
  });

  test('le refus s’affiche dans le composer, le chip passe en erreur, « Réessayer »', async () => {
    const page = d!.page;
    await node(page, `${DN}.remote`).click();
    await node(page, `${DN}.remote-bascule`).click();
    await expect(node(page, `${DN}.erreur`)).toContainText(REFUS);
    await expect(node(page, `${DN}.remote`)).toHaveText('Remote · erreur');
    await expect(node(page, `${DN}.remote-etat`)).toHaveText(REFUS);
    await expect(node(page, `${DN}.remote-lien`)).toHaveCount(0);
    await expect(node(page, `${DN}.remote-bascule`)).toHaveText('Réessayer');
  });
});

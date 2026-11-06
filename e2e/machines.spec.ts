import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { fermerContextes, node } from './helpers.js';

test.afterAll(({ browser }) => fermerContextes(browser));

// Chantier 29 (29.7) : l'écran Machines de bout en bout. Ce spec lance son propre daemon, en `stream`, devant les
// faux claude et codex (test/fixtures/bin-stream). AID_HOME et CODEX_HOME temporaires, aucune clé d'API dans
// l'environnement du daemon, jamais le vrai claude ni le vrai codex, aucun réseau, aucun serveur.
const PORT = Number(
  process.env.AID_E2E_STREAM_PORT ?? Number(process.env.AID_E2E_PORT ?? 4871) + 1,
);
const CLI = join(import.meta.dirname, '../dist/cli/aid.js');
const FIXTURES = join(import.meta.dirname, '../test/fixtures');
const CLES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
];

let home = '';
let page: Page;

function demarrer(): { url: string; token: string } {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'aid-e2e-machines-')));
  writeFileSync(join(home, 'config.yaml'), `port: ${PORT}\nagents:\n  transport: stream\n`, {
    mode: 0o600,
  });
  // des identifiants de codex dans un fichier : l'alerte de secret, sans que la valeur sorte
  const codex = join(home, 'codex');
  mkdirSync(codex);
  writeFileSync(join(codex, 'auth.json'), '{"token":"synthetique-e2e-0000"}', { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AID_HOME: home,
    AID_NO_BROWSER: '1',
    CODEX_HOME: codex,
    SHELL: '/bin/sh',
    PATH: `${join(FIXTURES, 'bin-stream')}${delimiter}${process.env.PATH}`,
  };
  for (const cle of CLES) delete env[cle];
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

const ligne = (id: string) => `machines.combinaisons.ligne-${id}`;

test.describe.serial('Machines (chantier 29)', () => {
  test.beforeAll(async ({ browser }) => {
    page = await ouvrir(browser);
  });

  test.afterAll(async () => {
    await page?.context().close();
    if (!home) return;
    execFileSync(process.execPath, [CLI, 'stop', '--force'], {
      env: { ...process.env, AID_HOME: home },
      timeout: 30_000,
    });
  });

  test('D151, D152 : l’entrée Machines de la barre, Ton cockpit', async () => {
    await page.locator('[data-node$=".barre.nav-machines"]').click();
    await page.waitForURL(/\/machines$/);
    await expect(node(page, 'machines.entete.titre')).toHaveText('Machines');
    await expect(node(page, 'machines.cockpit.mode')).toHaveText('Mode host inactif');
    await expect(node(page, 'machines.cockpit.appareil-local')).toContainText('Héberge le cockpit');
    await expect(page.locator('[data-node$=".barre.nav-machines"]')).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('D154, D157 : la carte du Mac, agents et versions synthétiques, mémoire mesurée, Diagnostiquer', async () => {
    const carte = 'machines.machine-local';
    await expect(node(page, `${carte}.agents`)).toContainText('claude 2.1.0 · codex 0.50.0');
    await expect(node(page, `${carte}.reprise`)).toContainText('session persistante');
    await expect(node(page, `${carte}.memoire`)).toContainText(/\d+,\d Go · mesurée à/);
    await expect(node(page, `${carte}.configurer`)).toHaveCount(0);
    await node(page, `${carte}.diagnostiquer`).click();
    await expect(node(page, `${carte}.diagnostiquer`)).toHaveText('Diagnostiquer');
    await expect(node(page, `${carte}.agents`)).toContainText('claude 2.1.0');
  });

  test('D153, D158 : la matrice du Mac, images et contrôle distant', async () => {
    await expect(node(page, `${ligne('local:claude')}.etat`)).toHaveText('Prêt');
    await expect(node(page, `${ligne('local:claude')}.images`)).toHaveText('✓');
    await expect(node(page, `${ligne('local:claude')}.distant`)).toHaveText('✓');
    await expect(node(page, `${ligne('local:codex')}.distant`)).toHaveText('–');
    await expect(node(page, `${ligne('local:codex')}.etat`)).toHaveText('Prêt, limité');
    await expect(node(page, `${ligne('local:claude')}.conso`)).toHaveText('–');
  });

  test('D159 : Anthropic par l’abonnement, l’alerte des identifiants de codex sans leur valeur', async () => {
    await expect(node(page, 'machines.fournisseur-anthropic.acces')).toHaveText(
      'Abonnement · claude CLI · repli payant désactivé',
    );
    await expect(node(page, 'machines.fournisseur-openai.secret')).toHaveText(
      'Identifiants dans un fichier',
    );
    const alerte = 'machines.alerte-codex:auth.json';
    await expect(node(page, alerte)).toContainText('Identifiants de codex dans un fichier');
    await node(page, `${alerte}.deplacer`).click();
    await expect(node(page, `${alerte}.etapes`)).toContainText('cli_auth_credentials_store');
    await expect(page.locator('body')).not.toContainText('synthetique-e2e-0000');
  });
});

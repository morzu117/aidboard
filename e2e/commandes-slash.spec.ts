import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { createTopic, newRepo, node, registerWorkspace, fermerContextes } from './helpers.js';

test.afterAll(({ browser }) => fermerContextes(browser));

// Chantier 22 (B.1) : le menu des commandes `/` du composer, sur un agent `stream`. Le daemon commun des e2e
// joue claude en PTY (global-setup) : ce spec lance le sien, en `stream`, devant le faux claude structuré
// (test/fixtures/bin-stream). AID_HOME temporaire, jamais le vrai claude, aucun réseau.
const PORT = Number(
  process.env.AID_E2E_STREAM_PORT ?? Number(process.env.AID_E2E_PORT ?? 4871) + 1,
);
const CLI = join(import.meta.dirname, '../dist/cli/aid.js');
const FIXTURES = join(import.meta.dirname, '../test/fixtures');
const DN = '1-3.conversation.composer';

let home = '';
let page: Page;

function demarrer(): { url: string; token: string } {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'aid-e2e-stream-')));
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
const menu = () => node(page, `${DN}.commandes`);
const nomsProposes = () => menu().locator('.composer-commande-nom');
const avis = () => node(page, `${DN}.avis`);
const erreur = () => node(page, `${DN}.erreur`);
const fil = () => node(page, '1-3.conversation.fil');

/** Vide le champ, puis tape le texte touche par touche, comme l'opérateur. */
async function taper(text: string): Promise<void> {
  await champ().fill('');
  await champ().pressSequentially(text);
}

test.describe.serial('commandes `/` du composer (22 B.1)', () => {
  test.beforeAll(async ({ browser }) => {
    page = await ouvrir(browser);
    await registerWorkspace(page, newRepo('depot-commandes'));
    await createTopic(page, 'Commandes slash');
    await node(page, '1-3.vide.lancer-claude').click();
    await expect(champ()).toBeVisible();
    await expect(node(page, `${DN}.modele`)).toHaveText('Par défaut');
  });

  test.afterAll(async () => {
    await page?.context().close();
    if (!home) return;
    execFileSync(process.execPath, [CLI, 'stop', '--force'], {
      env: { ...process.env, AID_HOME: home },
      timeout: 30_000,
    });
  });

  test('`/` ouvre le menu, les commandes d’A-I-D en tête, la première choisie', async () => {
    await expect(menu()).toHaveCount(0);
    await taper('/');
    await expect(menu()).toBeVisible();
    await expect(menu()).toHaveAttribute('role', 'listbox');
    await expect(nomsProposes()).toHaveText([
      '/model <id>',
      '/effort <niveau>',
      '/mode <id>',
      '/compact',
      '/stop',
      '/aide',
    ]);
    await expect(menu().getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    await expect(menu().locator('.composer-commande-source').first()).toHaveText('A-I-D');
  });

  test('`/mo` filtre ; ↓ puis Tab complète la seconde', async () => {
    await taper('/mo');
    await expect(nomsProposes()).toHaveText(['/model <id>', '/mode <id>']);
    await champ().press('ArrowDown');
    await expect(menu().getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(menu().getByRole('option').first()).toHaveAttribute('aria-selected', 'false');
    await champ().press('Tab');
    await expect(champ()).toHaveValue('/mode ');
    await expect(champ()).toBeFocused();
    await expect(menu()).toHaveCount(0);
  });

  test('Entrée sur un nom partiel complète, sans rien envoyer', async () => {
    await taper('/mod');
    await expect(nomsProposes()).toHaveText(['/model <id>', '/mode <id>']);
    await champ().press('Enter');
    await expect(champ()).toHaveValue('/model ');
    await expect(menu()).toHaveCount(0);
    await expect(avis()).toHaveCount(0);
    await expect(erreur()).toHaveCount(0);
  });

  test('Échap ferme le menu sans toucher au texte ; une touche de plus le rouvre', async () => {
    await taper('/');
    await expect(menu()).toBeVisible();
    await champ().press('Escape');
    await expect(menu()).toHaveCount(0);
    await expect(champ()).toHaveValue('/');
    await champ().press('e');
    await expect(nomsProposes().first()).toHaveText('/effort <niveau>');
  });

  test('un clic sur une commande la complète', async () => {
    await taper('/');
    await menu().getByRole('option').filter({ hasText: '/stop' }).click();
    await expect(champ()).toHaveValue('/stop');
    await expect(champ()).toBeFocused();
  });

  test('`/model <id>` change le chip modèle et l’annonce sous le champ', async () => {
    await taper('/model opus');
    await expect(menu()).toHaveCount(0);
    await champ().press('Enter');
    await expect(avis()).toHaveText('Modèle : Opus 5.5');
    await expect(node(page, `${DN}.modele`)).toHaveText('Opus 5.5');
    await expect(champ()).toHaveValue('');
    // par libellé aussi, puis retour au défaut
    await taper('/model Sonnet 5.5');
    await champ().press('Enter');
    await expect(node(page, `${DN}.modele`)).toHaveText('Sonnet 5.5');
    await taper('/model défaut');
    await champ().press('Enter');
    await expect(avis()).toHaveText('Modèle : par défaut');
    await expect(node(page, `${DN}.modele`)).toHaveText('Par défaut');
  });

  test('`/model inconnu` affiche l’erreur avec les possibles, le texte reste', async () => {
    await taper('/model inconnu');
    await champ().press('Enter');
    await expect(erreur()).toHaveText(
      'Modèle inconnu : inconnu. Possibles : défaut, fable, opus, sonnet, haiku',
    );
    await expect(champ()).toHaveValue('/model inconnu');
    await expect(node(page, `${DN}.modele`)).toHaveText('Par défaut');
  });

  test('`/mode plan` change le chip mode', async () => {
    await taper('/mode plan');
    await champ().press('Enter');
    await expect(avis()).toHaveText('Mode : Plan');
    await expect(node(page, `${DN}.mode`)).toHaveText('▸▸ Plan');
    await taper('/mode default');
    await champ().press('Enter');
    await expect(node(page, `${DN}.mode`)).toHaveText('▸▸ Demander');
  });

  test('`/aide` liste les commandes d’A-I-D ; Entrée sur le nom complet exécute', async () => {
    await taper('/aide');
    await expect(nomsProposes()).toHaveText(['/aide']);
    await champ().press('Enter');
    await expect(avis()).toContainText('/model <id> — Changer de modèle');
    await expect(avis()).toContainText('/aide — Lister les commandes');
    await expect(avis()).toContainText('L’agent n’a pas encore annoncé de commandes');
    await expect(champ()).toHaveValue('');
  });

  test('`/stop` hors tour : « Aucun tour en cours »', async () => {
    await taper('/stop');
    await champ().press('Enter');
    await expect(avis()).toHaveText('Aucun tour en cours');
    await expect(champ()).toHaveValue('');
  });

  test('`/stop` pendant un tour l’interrompt', async () => {
    await taper('tour long');
    await champ().press('Enter');
    await expect(fil()).toContainText('tour long démarré');
    await expect(node(page, `${DN}.arreter`)).toBeVisible();
    await taper('/stop');
    await champ().press('Enter');
    await expect(avis()).toHaveText('Tour interrompu');
    await expect(node(page, `${DN}.arreter`)).toHaveCount(0);
  });

  test('`/inconnu` : le menu dit qu’il part tel quel, et il part à l’agent', async () => {
    await taper('/inconnu');
    await expect(node(page, `${DN}.commandes.vide`)).toHaveText(
      'Aucune commande connue : le message part tel quel à claude.',
    );
    await champ().press('Enter');
    await expect(fil()).toContainText('echo: /inconnu');
    await expect(champ()).toHaveValue('');
    // les commandes d'A-I-D, exécutées plus haut, ne sont jamais parties à l'agent
    for (const t of ['/model', '/mode', '/aide', '/stop']) await expect(fil()).not.toContainText(t);
  });

  test('`/compact` part à l’agent, et l’avis le dit', async () => {
    await taper('/compact');
    await champ().press('Enter');
    await expect(fil()).toContainText('echo: /compact');
    await expect(avis()).toHaveText('Compaction demandée à l’agent');
  });

  test('après le tour `commandes`, celles de claude suivent celles d’A-I-D dans le menu', async () => {
    await taper('commandes');
    await champ().press('Enter');
    await expect(fil()).toContainText('commandes annoncées');
    await taper('/');
    await expect(nomsProposes()).toHaveText([
      '/model <id>',
      '/effort <niveau>',
      '/mode <id>',
      '/compact',
      '/stop',
      '/aide',
      '/context',
      '/deep-research',
      '/databricks:doctor',
    ]);
    await expect(menu().locator('.composer-commande-source')).toHaveCount(6);
    // préfixe d'abord : deep-research passe devant model, mode et aide
    await champ().pressSequentially('de');
    await expect(nomsProposes()).toHaveText([
      '/deep-research',
      '/model <id>',
      '/mode <id>',
      '/aide',
    ]);
    // une commande de l'agent se complète avec une espace, puis part telle quelle
    await champ().press('Tab');
    await expect(champ()).toHaveValue('/deep-research ');
    await champ().press('Enter');
    await expect(fil()).toContainText('echo: /deep-research');
    await taper('/aide');
    await champ().press('Enter');
    await expect(avis()).toContainText('Et 3 commandes de l’agent');
  });
});

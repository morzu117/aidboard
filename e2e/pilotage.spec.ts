import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  card,
  createTopic,
  launchClaude,
  launchShell,
  newRepo,
  node,
  openApp,
  registerWorkspace,
  state,
  terminalText,
  typeInTerminal,
  url,
} from './helpers.js';

test('une permission passe du hook à l’Accueil et à la boîte, on y répond sans ouvrir le terminal', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext());
  await registerWorkspace(page, newRepo('depot-hooks'));
  await createTopic(page, 'Chaîne des hooks');
  // le faux claude joue « PermissionRequest » avec la fixture : PTY → hook → daemon → UI
  const agent = await launchClaude(page);
  await expect.poll(() => terminalText(page, agent)).toContain('PRÊT');
  await typeInTerminal(page, 'perm');

  const c = await card(page, 'Chaîne des hooks');
  await expect(c('statut')).toHaveText('Attend une réponse');
  await expect(c('demande.question')).toContainText('autoriser Bash(npm test -- pty) ?');
  await expect(c('terminal')).toContainText('Do you want to proceed?');
  await expect(node(page, '1-1.barre.nav-boite.compte')).toHaveText('1');

  await node(page, '1-1.barre.nav-boite').click();
  await expect(page).toHaveURL(/\/boite$/);
  await expect(node(page, '1-2.liste.groupe-attente.compte')).toHaveText('1');
  await expect(node(page, '1-2.liste.element-1.question')).toHaveText(
    'autoriser Bash(npm test -- pty) ?',
  );
  await node(page, '1-2.liste.element-1.option-1').click();
  await expect(node(page, '1-2.barre.nav-boite.compte')).toHaveCount(0);

  // la touche « 1 » est arrivée au faux claude ; un message par la carte lui fait finir son tour
  const d = await card(page, 'Chaîne des hooks');
  await expect(d('terminal')).toContainText('réponse 1');
  await d('message.champ').fill('stop');
  await d('message.envoyer').click();
  await expect(d('statut')).toHaveText('À relire');
  await expect(d('terminal')).toContainText('tour fini');
});

test('un message à un shell par la carte, puis pause et reprise', async ({ browser }) => {
  const page = await openApp(await browser.newContext());
  await registerWorkspace(page, newRepo('depot-pilotage'));
  await createTopic(page, 'Pilotage du shell');
  const agent = await launchShell(page);

  const c = await card(page, 'Pilotage du shell');
  await expect(c('statut')).toHaveText('shell');
  await c('message.champ').fill('echo "ecran-$((6 * 7))"');
  await c('message.envoyer').click();
  await expect(c('terminal')).toContainText('ecran-42');

  await c('actions.pause').click();
  await expect(c('statut')).toHaveText('En pause');
  await expect(c('activite')).toContainText(/^en pause /);
  await expect(c('message.champ')).toBeDisabled();
  const pid = (await state(page)).agents.find((a) => a.id === agent)!.pid;
  const stat = () => execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  expect(stat()).toMatch(/T/);

  await expect(c('actions.pause')).toHaveText('Reprendre');
  await c('actions.pause').click();
  await expect(c('statut')).toHaveText('shell');
  expect(stat()).not.toMatch(/T/);
  await c('message.champ').fill('echo "reprise-$((6 + 7))"');
  await c('message.envoyer').click();
  await expect(c('terminal')).toContainText('reprise-13');
});

test('la palette : ⌘K ouvre, on filtre, Entrée ouvre le sujet, Échap ferme', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext());
  await registerWorkspace(page, newRepo('depot-palette'));
  const id = await createTopic(page, 'Sujet de la palette');

  await page.goto(url());
  await page.keyboard.press('ControlOrMeta+k');
  await expect(node(page, 'palette.champ')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(node(page, 'palette')).toHaveCount(0);

  await node(page, '1-1.barre.recherche').click();
  await node(page, 'palette.champ').fill('palette sujet');
  await expect(node(page, `palette.sujet-${id}`)).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/sujets/${id}$`));
  await expect(node(page, '1-3.entete.titre')).toHaveText('Sujet de la palette');

  await page.keyboard.press('ControlOrMeta+k');
  await expect(node(page, 'palette.champ')).toBeFocused();
  await node(page, 'palette.champ').fill('boite');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/boite$/);
});

test('un dépôt sans origin s’enregistre ; son sujet se crée, tourne et se nettoie', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext());
  await registerWorkspace(
    page,
    newRepo('depot-local', { local: true }),
    /sans remote origin : les sujets partiront de la branche locale main/,
  );
  const id = await createTopic(page, 'Sujet sans remote');
  const worktree = (await node(page, '1-3.entete.worktree').textContent())!;
  expect(existsSync(worktree)).toBe(true);

  const agent = await launchShell(page);
  await typeInTerminal(page, 'git rev-parse --abbrev-ref HEAD; git remote | wc -l');
  await expect.poll(() => terminalText(page, agent)).toMatch(/sujet-sans-remote\s+0/);
  await typeInTerminal(page, 'exit');

  await node(page, '1-3.actions.plus').click();
  await page.getByRole('button', { name: 'Nettoyer le sujet' }).click();
  await expect.poll(() => existsSync(worktree), { timeout: 30_000 }).toBe(false);
  const topics = (await state(page)).topics as Array<{ id: string; state?: string }>;
  expect(topics.find((t) => t.id === id)?.state ?? 'archived').toBe('archived');
});

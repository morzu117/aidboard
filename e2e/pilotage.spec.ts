import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
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
  const id = await createTopic(page, 'Chaîne des hooks');
  // le faux claude joue « PermissionRequest » avec la fixture : PTY → hook → daemon → UI
  const agent = await launchClaude(page);
  await expect.poll(() => terminalText(page, agent)).toContain('PRÊT');
  await typeInTerminal(page, 'perm');
  // le prompt de permission est encore dans le terminal de l'écran Sujet avant toute réponse
  await expect.poll(() => terminalText(page, agent)).toContain('Do you want to proceed?');

  // piste A (D56) : la décision se lit sur le bandeau de l'Accueil, pas sur une carte par sujet
  await page.goto(url());
  await expect(node(page, '1-1.decisions.decision-1.carte.question')).toContainText(
    'autoriser Bash(npm test -- pty) ?',
  );
  await expect(node(page, '1-1.barre.nav-boite.compte')).toHaveText('1');
  // le statut de la ligne de table reflète la même attente (Statut.tsx, Point)
  await expect(node(page, '1-1.table.ligne-1.statut')).toHaveAttribute(
    'aria-label',
    'Attend une réponse',
  );

  await node(page, '1-1.barre.nav-boite').click();
  await expect(page).toHaveURL(/\/boite$/);
  await expect(node(page, '1-2.liste.groupe-attente.compte')).toHaveText('1');
  await expect(node(page, '1-2.liste.element-1.question')).toHaveText(
    'autoriser Bash(npm test -- pty) ?',
  );
  await node(page, '1-2.liste.element-1.option-1').click();
  await expect(node(page, '1-2.barre.nav-boite.compte')).toHaveCount(0);

  // la touche « 1 » est arrivée au faux claude ; on tape « stop » dans son propre terminal (écran Sujet)
  await page.goto(`${url()}/sujets/${id}`);
  await expect.poll(() => terminalText(page, agent)).toContain('réponse 1');
  await typeInTerminal(page, 'stop');
  // le statut est le libellé accessible du point, pas du texte visible (Statut.tsx, Point)
  await expect(node(page, '1-3.terminaux.onglet-1').locator('[role="img"]')).toHaveAttribute(
    'aria-label',
    'À relire',
  );
  await expect.poll(() => terminalText(page, agent)).toContain('tour fini');
});

test('un message à un shell dans son terminal, puis pause et reprise depuis l’écran Sujet', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext());
  await registerWorkspace(page, newRepo('depot-pilotage'));
  const id = await createTopic(page, 'Pilotage du shell');
  const agent = await launchShell(page);

  // le statut est le libellé accessible du point, pas du texte visible (Statut.tsx, Point)
  const point = node(page, '1-3.terminaux.onglet-1').locator('[role="img"]');
  await expect(point).toHaveAttribute('aria-label', 'shell');
  await typeInTerminal(page, 'echo "ecran-$((6 * 7))"');
  await expect.poll(() => terminalText(page, agent)).toContain('ecran-42');

  // pause/reprise (D56) : seule action de l'ancienne carte sans équivalent table, portée par
  // l'écran Sujet depuis le point C (commit « pause et reprise »).
  await node(page, '1-3.terminaux.pied.pause').click();
  await expect(point).toHaveAttribute('aria-label', 'En pause');
  // la ligne de table de l'Accueil montre le même statut (remplace l'ancienne assertion `activite`
  // de la carte portée là-bas avant la table ; son champ de message désactivé pendant la pause n'a
  // plus d'équivalent — rien d'autre à vérifier ici).
  await page.goto(url());
  await expect(node(page, '1-1.table.ligne-1.statut')).toHaveAttribute('aria-label', 'En pause');
  await page.goto(`${url()}/sujets/${id}`);
  const pid = (await state(page)).agents.find((a) => a.id === agent)!.pid;
  const stat = () => execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  expect(stat()).toMatch(/T/);

  await expect(node(page, '1-3.terminaux.pied.pause')).toHaveText('Reprendre');
  await node(page, '1-3.terminaux.pied.pause').click();
  await expect(point).toHaveAttribute('aria-label', 'shell');
  expect(stat()).not.toMatch(/T/);
  await typeInTerminal(page, 'echo "reprise-$((6 + 7))"');
  await expect.poll(() => terminalText(page, agent)).toContain('reprise-13');
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
  // §5.3 : le chemin du worktree a quitté l'en-tête pour le menu ⋯.
  await node(page, '1-3.actions.plus').click();
  const worktree = (await node(page, '1-3.entete.worktree').textContent())!;
  expect(existsSync(worktree)).toBe(true);
  await node(page, '1-3.actions.plus').click();

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

import { expect, test } from '@playwright/test';
import { sh } from '../test/helpers/git.js';
import { createTopic, newRepo, node, openApp, registerWorkspace } from './helpers.js';

// branches-libres (point 2) : la zone « Nouvelle branche depuis <base> » du sélecteur appelle
// branche.creer — le sujet doit basculer sur la nouvelle branche, créée depuis origin/<base>.
test('sélecteur de branche : créer une branche depuis la base, le sujet bascule dessus', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext());
  await registerWorkspace(page, newRepo('depot-branche-creer'));
  await createTopic(page, 'Branche depuis main');

  await node(page, '1-3.actions.plus').click();
  const worktree = (await node(page, '1-3.entete.worktree').textContent())!;
  await node(page, '1-3.actions.plus').click();
  const baseTip = sh(worktree, 'rev-parse', 'origin/main');

  await node(page, '1-3.entete.branche').click();
  const dialogue = page.getByRole('dialog', { name: 'Changer de branche' });
  await expect(dialogue).toBeVisible();
  await page.getByLabel('Nom de la nouvelle branche').fill('feat/nouvelle-depuis-main');
  await page.getByRole('button', { name: 'Créer' }).click();
  await expect(dialogue).toBeHidden();

  // syncTopicBranches rapproche topic.branch de la branche réelle à chaque /api/state.
  await expect(node(page, '1-3.entete.branche')).toHaveText('feat/nouvelle-depuis-main');
  expect(sh(worktree, 'rev-parse', 'HEAD')).toBe(baseTip);

  await page.context().close();
});

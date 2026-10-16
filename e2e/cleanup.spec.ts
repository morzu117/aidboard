import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createTopic, newRepo, node, openApp, registerWorkspace } from './helpers.js';

test('nettoyer un sujet avec des modifications non commitées est refusé, rien n’est supprimé', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext());
  await registerWorkspace(page, newRepo('depot-cleanup'));
  await createTopic(page, 'A nettoyer');
  const worktree = (await node(page, '1-3.entete.worktree').textContent())!;
  writeFileSync(join(worktree, 'brouillon.txt'), 'travail à garder\n');

  await node(page, '1-3.actions.plus').click();
  await page.getByRole('button', { name: 'Nettoyer le sujet' }).click();
  await expect(page.getByRole('alert')).toContainText('non commitées');
  await expect(page.getByRole('button', { name: 'Supprimer quand même' })).toHaveCount(0);
  await expect(node(page, '1-3.entete.etat')).toHaveText('active');
});

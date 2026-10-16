import { expect, test } from '@playwright/test';
import { createTopic, newRepo, node, openApp, registerWorkspace } from './helpers.js';

test('un worktree sans index structurel affiche le repli déclaré', async ({ browser }) => {
  const page = await openApp(await browser.newContext());
  await registerWorkspace(page, newRepo('depot-sans-index'));
  await createTopic(page, 'Sans index');
  await expect(node(page, '1-3.entete.index')).toHaveText('index absent : lecture directe');
});

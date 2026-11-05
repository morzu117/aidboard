import { expect, test } from '@playwright/test';
import { node, openApp } from './helpers.js';

// Dans un vrai navigateur, à l'ouverture de « Nouveau projet », « Aller au dossier » montre le dossier de départ :
// jsdom ne rend pas le focus natif d'un dialogue, qui ferait garder le champ vide.
test('« Nouveau projet » : « Aller au dossier » montre le dossier de départ', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await openApp(context);
  await node(page, '1-1.barre.nouveau-sujet').click();
  const ajouter = page.getByRole('button', { name: 'Ajouter un projet…' });
  if (await ajouter.isVisible({ timeout: 2000 }).catch(() => false)) await ajouter.click();
  await expect(page.getByLabel('Aller au dossier')).toHaveValue(/^\/./);
  await context.close();
});

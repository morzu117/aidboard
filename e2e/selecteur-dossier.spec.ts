import { expect, test } from '@playwright/test';
import { openApp, ouvrirNouveauProjet } from './helpers.js';

// Dans un vrai navigateur, à l'ouverture de « Nouveau projet », « Aller au dossier » montre le dossier de départ :
// jsdom ne rend pas le focus natif d'un dialogue, qui ferait garder le champ vide.
test('« Nouveau projet » : « Aller au dossier » montre le dossier de départ', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await openApp(context);
  await ouvrirNouveauProjet(page);
  await expect(page.getByLabel('Aller au dossier')).toHaveValue(/^\/./);
  await context.close();
});

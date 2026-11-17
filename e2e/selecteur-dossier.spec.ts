import { verifierEcranGarde } from './ecrans-garde.js';
import { expect, test } from './test.js';
import { join } from 'node:path';
import { newRepo, openApp, ouvrirNouveauProjet } from './helpers.js';

// Dans un vrai navigateur, à l'ouverture de « Nouveau projet », « Aller au dossier » montre le dossier de départ :
// jsdom ne rend pas le focus natif d'un dialogue, qui ferait garder le champ vide.
test('« Nouveau projet » : « Aller au dossier » montre le dossier de départ', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await openApp(context);
  await ouvrirNouveauProjet(page);
  await expect(page.getByLabel('Aller au dossier')).toHaveValue(/^\/./);
  const dossier = newRepo('depot-selecteur-captures');
  const lecture = page.waitForResponse((r) => {
    const adresse = new URL(r.url());
    return adresse.pathname === '/api/fs/dirs' && adresse.searchParams.get('path') === dossier;
  });
  await page.getByLabel('Aller au dossier').fill(dossier);
  await page.getByLabel('Aller au dossier').press('Enter');
  expect((await lecture).status()).toBe(200);
  await expect(page.locator('.selecteur-dossier__vide')).toHaveText('Aucun sous-dossier.');
  await expect(page.locator('.selecteur-dossier').getByRole('alert')).toHaveCount(0);
  await verifierEcranGarde(
    page,
    'nouveau-projet-aller',
    page.getByRole('button', { name: 'Aller', exact: true }),
  );
  await context.close();
});

test('56.g D342 : Aller refuse un dossier absent, puis permet de recommencer', async ({
  browser,
}) => {
  const contexte = await browser.newContext();
  const page = await openApp(contexte);
  const dossier = newRepo('depot-selecteur-garde');
  try {
    await ouvrirNouveauProjet(page);
    const champ = page.getByLabel('Aller au dossier');
    const aller = page.getByRole('button', { name: 'Aller', exact: true });
    await expect(champ).toHaveValue(/^\/./);
    for (const taille of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(taille);
      await champ.click();
      await champ.fill(join(dossier, 'dossier-absent'));
      const refus = page.waitForResponse((r) => {
        const adresse = new URL(r.url());
        return (
          adresse.pathname === '/api/fs/dirs' &&
          adresse.searchParams.get('path') === join(dossier, 'dossier-absent')
        );
      });
      await expect(aller).toBeEnabled();
      await aller.click();
      expect((await refus).status()).toBe(404);
      await expect(page.locator('.selecteur-dossier').getByRole('alert')).toBeVisible();
      await champ.fill(dossier);
      const lecture = page.waitForResponse((r) => {
        const adresse = new URL(r.url());
        return adresse.pathname === '/api/fs/dirs' && adresse.searchParams.get('path') === dossier;
      });
      await aller.click();
      const reponse = await lecture;
      expect(reponse.status()).toBe(200);
      expect((await reponse.json()).path).toBe(dossier);
      await expect(champ).toHaveValue(dossier);
      await expect(page.locator('.selecteur-dossier').getByRole('alert')).toHaveCount(0);
    }
  } finally {
    await contexte.close();
  }
});

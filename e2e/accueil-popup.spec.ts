import { expect, test, type Page } from '@playwright/test';
import { createTopic, newRepo, node, openApp, registerWorkspace, url } from './helpers.js';

// recette (chantier 15, point 2) : sous 1280 px, `.accueil-aside` (Activité + État) ne se repliait
// pas — elle restait à côté de la table (flex: 0 0 280px, jamais de media query), qui s'écrasait
// au point que ses en-têtes/cellules se coupaient lettre par lettre (constat opérateur, « P/R/O/
// J/E/T », « r/e/f/a/c/t/o/r »). Mécanisme repris de l'écran Sujet : Volet + bouton flottant.

// noms longs (projet et branche) pour que la vérification « une ligne » soit significative —
// même convention que e2e/sujet-colonnes.spec.ts.
async function deuxSujetsLongs(page: Page): Promise<void> {
  await registerWorkspace(
    page,
    newRepo('depot-accueil-popup-nom-de-projet-vraiment-tres-long-pour-la-recette-un'),
  );
  await createTopic(
    page,
    'Un premier sujet avec une branche vraiment tres longue pour verifier la troncature',
  );
  await page.goto(`${url()}/`);
  await node(page, '1-1.table.lignes').waitFor();

  await registerWorkspace(
    page,
    newRepo('depot-accueil-popup-nom-de-projet-vraiment-tres-long-pour-la-recette-deux'),
  );
  await createTopic(
    page,
    'Un second sujet avec une branche elle aussi vraiment tres longue pour la recette',
  );
  await page.goto(`${url()}/`);
  await node(page, '1-1.table.lignes').waitFor();
}

test("< 1280 px : l'aside est masqué, le bouton « Ouvrir l'activité » ouvre le pop-up, Échap le referme", async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext({ viewport: { width: 1000, height: 800 } }));
  await deuxSujetsLongs(page);

  await expect(node(page, '1-1.aside')).toBeHidden();
  const bouton = page.getByRole('button', { name: "Ouvrir l'activité" });
  await expect(bouton).toBeVisible();

  await bouton.click();
  const dialogue = page.getByRole('dialog', { name: 'Activité' });
  await expect(dialogue).toBeVisible();
  await expect(dialogue.locator('[data-node="1-1.activite"]')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialogue).not.toBeVisible();
});

for (const viewport of [
  { width: 560, height: 900 },
  { width: 1000, height: 800 },
]) {
  test(`${viewport.width}x${viewport.height} : en-têtes et cellules de la table sur une ligne, pas de défilement de page`, async ({
    browser,
  }) => {
    const page = await openApp(await browser.newContext({ viewport }));
    await deuxSujetsLongs(page);

    const uneLigne = async (loc: ReturnType<Page['locator']>) => {
      const lignes = await loc.evaluate((el) => {
        const plage = document.createRange();
        plage.selectNodeContents(el);
        const y = Array.from(plage.getClientRects()).map((r) => Math.round(r.y));
        return new Set(y).size;
      });
      expect(lignes).toBe(1);
    };

    for (const th of await page.locator('[data-node="1-1.table.lignes"] thead th').all()) {
      await uneLigne(th);
    }
    // le nom (span tronqué) et les colonnes Projet/Agent/Activité sont du texte pur ; la colonne
    // Action (un bouton inline-flex) et la ligne d'index sous le nom ne sont pas concernées par
    // la troncature et sortent du périmètre de ce test.
    for (const sel of [
      '[data-bind="sujet.nom_affiche"]',
      '[data-bind="workspace.nom"]',
      '[data-node$=".agent"]',
      '[data-node$=".activite"]',
    ]) {
      for (const el of await page.locator(`[data-node="1-1.table.lignes"] tbody ${sel}`).all()) {
        await uneLigne(el);
      }
    }

    const defilePage = await page.evaluate(
      () => document.scrollingElement!.scrollWidth > window.innerWidth,
    );
    expect(defilePage).toBe(false);
  });
}

test('≥ 1280 px (1440x900) : aside à côté de la table (~280 px), bouton flottant masqué', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext({ viewport: { width: 1440, height: 900 } }));
  await deuxSujetsLongs(page);

  const aside = node(page, '1-1.aside');
  await expect(aside).toBeVisible();
  const largeur = (await aside.boundingBox())!.width;
  expect(largeur).toBeGreaterThan(270);
  expect(largeur).toBeLessThan(290);

  await expect(page.getByRole('button', { name: "Ouvrir l'activité" })).toBeHidden();
});

import { expect, test } from '@playwright/test';
import { createTopic, newRepo, node, openApp, registerWorkspace, url } from './helpers.js';

// C.2 (chantier 15) : fil d'activité récente de l'Accueil — heure en colonne fixe, type et
// contexte sur deux lignes propres (constat recette : « 14:57 » et « topic.state » coupés en deux).
test('la ligne du fil d’activité ne coupe ni l’heure ni le type sur plusieurs lignes', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext({ viewport: { width: 1440, height: 900 } }));
  await registerWorkspace(page, newRepo('depot-activite'));
  // titre long : le slug (48 car. max) qui en sort donne une branche longue, donc un contexte
  // qui déborderait sans le correctif (recette : type et contexte COLLÉS sur une ligne, débord).
  await createTopic(
    page,
    'Sujet avec un nom de branche vraiment très long pour forcer le débordement du contexte',
  );
  await page.goto(url());

  const ligne = node(page, '1-1.activite.ligne-1');
  await expect(ligne).toBeVisible();
  const boiteHeure = await node(page, '1-1.activite.ligne-1.heure').boundingBox();
  const boiteType = await node(page, '1-1.activite.ligne-1.type').boundingBox();
  const boiteContexte = await node(page, '1-1.activite.ligne-1.contexte').boundingBox();
  const boitePanneau = await node(page, '1-1.activite').boundingBox();
  expect(boiteHeure!.height).toBeLessThan(20);
  expect(boiteType!.height).toBeLessThan(20);
  // deux lignes : le contexte commence au bas (ou en dessous) du type, jamais à côté
  expect(boiteContexte!.y).toBeGreaterThanOrEqual(boiteType!.y + boiteType!.height - 1);
  // rien ne déborde à droite du panneau
  expect(boiteType!.x + boiteType!.width).toBeLessThanOrEqual(
    boitePanneau!.x + boitePanneau!.width,
  );
  expect(boiteContexte!.x + boiteContexte!.width).toBeLessThanOrEqual(
    boitePanneau!.x + boitePanneau!.width,
  );
});

import { expect, test } from '@playwright/test';
import { createTopic, newRepo, node, openApp, registerWorkspace, url } from './helpers.js';

// C.2 (chantier 15) : fil d'activité récente de l'Accueil — heure en colonne fixe, type et
// contexte sur deux lignes propres (constat recette : « 14:57 » et « topic.state » coupés en deux).
test('la ligne du fil d’activité ne coupe ni l’heure ni le type sur plusieurs lignes', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext({ viewport: { width: 1440, height: 900 } }));
  await registerWorkspace(page, newRepo('depot-activite'));
  await createTopic(page, 'Sujet pour le fil d’activité');
  await page.goto(url());

  const ligne = node(page, '1-1.activite.ligne-1');
  await expect(ligne).toBeVisible();
  const boiteHeure = await node(page, '1-1.activite.ligne-1.heure').boundingBox();
  const boiteType = await node(page, '1-1.activite.ligne-1.type').boundingBox();
  expect(boiteHeure!.height).toBeLessThan(20);
  expect(boiteType!.height).toBeLessThan(20);
});

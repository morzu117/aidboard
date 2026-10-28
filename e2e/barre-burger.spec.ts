import { expect, test } from '@playwright/test';
import { node, openApp } from './helpers.js';

// recette (chantier 15, point 1) : sous 1280 px, .bouton-volant--nav (position fixed, même coin
// que la marque) recouvrait le logo de la barre (constat opérateur) — la barre réserve sa place.
for (const viewport of [
  { width: 560, height: 900 },
  { width: 1000, height: 800 },
]) {
  test(`${viewport.width}x${viewport.height} : le bouton de navigation ne recouvre pas le logo de la barre`, async ({
    browser,
  }) => {
    const page = await openApp(await browser.newContext({ viewport }));
    const burger = node(page, '1-1.volet.ouvrir-nav');
    const logo = node(page, '1-1.barre.marque');
    await expect(burger).toBeVisible();
    await expect(logo).toBeVisible();
    const b = (await burger.boundingBox())!;
    const l = (await logo.boundingBox())!;
    const chevauchent =
      b.x < l.x + l.width && l.x < b.x + b.width && b.y < l.y + l.height && l.y < b.y + b.height;
    expect(chevauchent).toBe(false);
    expect(l.x).toBeGreaterThanOrEqual(0);
    expect(l.x + l.width).toBeLessThanOrEqual(viewport.width);
  });
}

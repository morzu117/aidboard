import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';

/** D342, règle 4 : captures pour la revue avant un commit d’interface.
 * Activer avec AID_E2E_CAPTURES=<dossier> ; sans cette variable, aucun effet.
 */
export async function capturerBoutons(page: Page, ecran: string, repere: Locator) {
  const dossier = process.env.AID_E2E_CAPTURES;
  if (!dossier) return;
  await mkdir(dossier, { recursive: true });
  const taille = page.viewportSize();
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await repere.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(dossier, `${ecran}-${viewport.width}x${viewport.height}.png`),
    });
  }
  if (taille) await page.setViewportSize(taille);
}

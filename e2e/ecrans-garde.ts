import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Locator, type Page } from './test.js';
import { detecterVisuel } from './visuel.js';

/** D342 : même état réel avant/après, aux deux formats, sans modifier les données. */
export async function verifierEcranGarde(page: Page, nom: string, repere: Locator) {
  const ancienneTaille = page.viewportSize();
  const dossier = process.env.AID_E2E_CAPTURES;
  const mesures = [];
  if (dossier && ancienneTaille && (await repere.isVisible())) {
    await mkdir(dossier, { recursive: true });
    await page.screenshot({
      path: join(
        dossier,
        `56-g-${nom}-initial-${ancienneTaille.width}x${ancienneTaille.height}.png`,
      ),
    });
  }
  try {
    for (const taille of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(taille);
      let panneauOuvert = false;
      if (!(await repere.isVisible())) {
        const ouvrir = page.getByRole('button', { name: 'Ouvrir le panneau du sujet' });
        if (await ouvrir.isVisible()) {
          await ouvrir.click();
          panneauOuvert = true;
        }
      }
      await repere.scrollIntoViewIfNeeded();
      if (dossier) {
        await mkdir(dossier, { recursive: true });
        await page.screenshot({
          path: join(dossier, `56-g-${nom}-${taille.width}x${taille.height}.png`),
        });
      }
      const trouvailles = await detecterVisuel(page);
      mesures.push({ taille, trouvailles });
      if (panneauOuvert) await page.keyboard.press('Escape');
      if (process.env.AID_VISUEL_RELEVE !== '1')
        expect(
          trouvailles,
          `${nom} ${JSON.stringify(taille)} : ${JSON.stringify(trouvailles)}`,
        ).toEqual([]);
    }
    if (dossier)
      await writeFile(join(dossier, `56-g-${nom}.json`), JSON.stringify(mesures, null, 2));
  } finally {
    if (ancienneTaille) await page.setViewportSize(ancienneTaille);
  }
}

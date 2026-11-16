import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { capturerBoutons } from './captures-boutons.js';
import { node } from './helpers.js';
import { demarrerHost } from './host-helpers.js';

test('56.4 D01 D07 : création et configuration, raisons, refus et reprise', async ({ browser }) => {
  test.setTimeout(120_000);
  const port = Number(process.env.AID_E2E_PORT ?? 4871) + 2;
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'aid-e2e-boutons-')));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  // Le test automatique de connexion doit rester local et ne jamais ouvrir SSH.
  writeFileSync(
    join(bin, 'ssh'),
    '#!/bin/sh\necho "Connexion synthétique refusée" >&2\nexit 255\n',
    {
      mode: 0o700,
    },
  );
  const instance = demarrerHost(
    port,
    '',
    `${bin}${delimiter}${join(import.meta.dirname, '../test/fixtures/bin-stream')}${delimiter}${process.env.PATH}`,
    { home },
  );
  const contexte = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await contexte.newPage();
  const style = (bouton: Locator) =>
    bouton.evaluate((element) => {
      const style = getComputedStyle(element);
      return { curseur: style.cursor, fond: style.backgroundColor, texte: style.color };
    });
  const lire = () =>
    page.evaluate(
      async () =>
        (await (await fetch('/api/servers')).json()) as {
          id: string;
          name: string;
          target: string;
        }[],
    );
  try {
    await page.goto(`http://127.0.0.1:${port}/?token=${instance.token}`);
    await page.goto(`http://127.0.0.1:${port}/serveurs/nouveau`);
    const enregistrer = node(page, 'serveur-config.enregistrer');
    const raison = page.locator('#serveur-config-probleme');
    await expect(enregistrer).toBeDisabled();
    await expect(raison).toHaveText('Champs obligatoires manquants : nom affiché, alias.');
    await expect(enregistrer).toHaveAccessibleDescription(await raison.innerText());
    await capturerBoutons(page, 'serveurs-creation-desactive', enregistrer);
    const styles = new Map<string, Awaited<ReturnType<typeof style>>>();
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      const desactive = await style(enregistrer);
      expect(desactive.curseur).toBe('not-allowed');
      expect(desactive.texte).not.toBe(desactive.fond);
      styles.set(colorScheme, desactive);
    }
    await node(page, 'serveur-config.nom').fill('Serveur recette');
    await expect(raison).toHaveText('L’alias est obligatoire.');
    await node(page, 'serveur-config.cible').fill('example.com');
    await expect(enregistrer).toBeEnabled();
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      const actif = await style(enregistrer);
      expect(actif.curseur).toBe('pointer');
      expect(actif.fond).not.toBe(styles.get(colorScheme)!.fond);
    }
    await capturerBoutons(page, 'serveurs-creation-actif', enregistrer);
    await node(page, 'serveur-config.cible').fill('-invalide');
    const refus = page.waitForResponse(
      (r) => r.url().endsWith('/api/servers') && r.request().method() === 'POST',
    );
    await enregistrer.click();
    expect((await refus).status()).toBe(400);
    await expect(node(page, 'serveur-config.erreur')).toContainText('alias SSH invalide');
    await expect(page.getByRole('alert')).toHaveCount(1);
    await expect(raison).toHaveCount(0);
    await expect(enregistrer).not.toHaveAttribute('aria-describedby');
    expect(await lire()).toEqual([]);
    await expect(enregistrer).toBeEnabled();
    await node(page, 'serveur-config.cible').fill('example.com');
    await enregistrer.click();
    await expect(node(page, 'serveur-config.titre')).toHaveText('Configurer Serveur recette');
    const [serveur] = await lire();
    expect(serveur).toMatchObject({ name: 'Serveur recette', target: 'example.com' });
    await expect(enregistrer).toBeDisabled();
    await expect(raison).toHaveText('Aucune modification');
    await expect(enregistrer).toHaveAccessibleDescription('Aucune modification');
    await capturerBoutons(page, 'serveurs-configuration-desactive', enregistrer);
    await node(page, 'serveur-config.cible').fill('aid-e2e.ts.net');
    await expect(enregistrer).toBeEnabled();
    await capturerBoutons(page, 'serveurs-configuration-actif', enregistrer);
    await node(page, 'serveur-config.cible').fill('-invalide');
    const refusModification = page.waitForResponse(
      (r) => r.url().endsWith(`/api/servers/${serveur!.id}`) && r.request().method() === 'PATCH',
    );
    await enregistrer.click();
    expect((await refusModification).status()).toBe(400);
    await expect(node(page, 'serveur-config.erreur')).toContainText('alias SSH invalide');
    await expect(page.getByRole('alert')).toHaveCount(1);
    await expect(raison).toHaveCount(0);
    await expect(enregistrer).not.toHaveAttribute('aria-describedby');
    expect((await lire())[0]!.target).toBe('example.com');
    await node(page, 'serveur-config.cible').fill('aid-e2e.ts.net');
    await enregistrer.click();
    await expect(raison).toHaveText('Aucune modification');
    expect((await lire())[0]!.target).toBe('aid-e2e.ts.net');
    await page.reload();
    await expect(node(page, 'serveur-config.cible')).toHaveValue('aid-e2e.ts.net');
  } finally {
    await contexte.close();
    execFileSync(
      process.execPath,
      [join(import.meta.dirname, '../dist/cli/aid.js'), 'stop', '--force'],
      {
        env: { ...process.env, AID_HOME: home },
        timeout: 30_000,
      },
    );
  }
});

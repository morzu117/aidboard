import { execFileSync } from 'node:child_process';
import type { Server } from 'node:https';
import { delimiter, join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { appairerHost, demarrerHost, ORIGINE_APPAREIL } from './host-helpers.js';
import { createTopic, fermerContextes, newRepo, node, registerWorkspace } from './helpers.js';
import { NOM_E2E, ouvrirServeLocal } from './serve-local.js';

const PORT = Number(process.env.AID_E2E_PORT ?? 4871) + 3;
const FRONTAL = PORT + 30;
const CLI = join(import.meta.dirname, '../dist/cli/aid.js');
test.use({
  viewport: { width: 390, height: 844 },
  launchOptions: {
    args: [
      `--host-resolver-rules=MAP ${NOM_E2E}:443 127.0.0.1:${FRONTAL}`,
      // Le worker doit lui aussi accepter le certificat autosigné du frontal local.
      '--ignore-certificate-errors',
    ],
  },
});
let home = '';
let frontal: Server;
let mac: Page;
let telephone: Page;
let sujet = '';
const composer = () => node(mac, '1-3.conversation.composer.champ');

async function demander(texte: string) {
  await mac.goto(`http://127.0.0.1:${PORT}/sujets/${sujet}`);
  await composer().fill(texte);
  await composer().press('Enter');
}

async function nombreEtats(page: Page) {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const ouverture = indexedDB.open('aid-appareil', 1);
        ouverture.onerror = () => reject(new Error('IndexedDB inaccessible'));
        ouverture.onsuccess = () => {
          const base = ouverture.result;
          if (!base.objectStoreNames.contains('etat')) {
            base.close();
            resolve(0);
            return;
          }
          const compte = base.transaction('etat').objectStore('etat').count();
          compte.onsuccess = () => {
            base.close();
            resolve(compte.result);
          };
          compte.onerror = () => {
            base.close();
            reject(new Error('Lecture impossible'));
          };
        };
      }),
  );
}

test.describe.serial('app mobile (32.11), Chromium', () => {
  test.beforeAll(async ({ browser }) => {
    const instance = demarrerHost(
      PORT,
      'agents:\n  transport: stream',
      `${join(import.meta.dirname, '../test/fixtures/bin-stream')}${delimiter}${process.env.PATH}`,
    );
    home = instance.home;
    frontal = await ouvrirServeLocal({ dir: home, port: FRONTAL, versPort: PORT + 20 });
    const contexte = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await contexte.addInitScript(() => localStorage.setItem('aid-e2e', '1'));
    mac = await contexte.newPage();
    await mac.goto(`http://127.0.0.1:${PORT}/?token=${instance.token}`);
    await registerWorkspace(mac, newRepo('depot-mobile'));
    sujet = await createTopic(mac, 'Recette mobile');
    await node(mac, '1-3.vide.lancer-claude').click();
    await expect(composer()).toBeVisible();
    telephone = await appairerHost(browser, mac, PORT, 'Mobile e2e', { width: 390, height: 844 });
  });
  test.afterAll(async ({ browser }) => {
    await fermerContextes(browser);
    await new Promise<void>((resolve) => (frontal ? frontal.close(() => resolve()) : resolve()));
    if (home)
      execFileSync(process.execPath, [CLI, 'stop', '--force'], {
        env: { ...process.env, AID_HOME: home },
        timeout: 30_000,
      });
  });

  test('installer : manifeste et icônes sur le port des appareils', async () => {
    const manifeste = await telephone.evaluate(async () => {
      const reponse = await fetch('/manifest.webmanifest');
      return {
        statut: reponse.status,
        type: reponse.headers.get('content-type'),
        contenu: await reponse.json(),
      };
    });
    expect(manifeste.statut).toBe(200);
    expect(manifeste.type).toContain('application/manifest+json');
    expect(manifeste.contenu.display).toBe('standalone');
    expect(manifeste.contenu.icons.length).toBeGreaterThan(0);
    for (const icone of manifeste.contenu.icons as { src: string }[]) {
      expect(await telephone.evaluate(async (src) => (await fetch(src)).status, icone.src)).toBe(
        200,
      );
    }
  });

  test('trancher une question et recevoir la réponse sur le Mac', async () => {
    await demander('demande questions');
    await expect(telephone.getByText('(1/2) Où écrire le graphe ?', { exact: true })).toBeVisible();
    await telephone.getByRole('button', { name: 'YAML', exact: true }).click();
    await telephone.getByRole('button', { name: 'Confirmer', exact: true }).click();
    await expect(telephone.getByText('(1/2) Où écrire le graphe ?', { exact: true })).toHaveCount(
      0,
    );
    // Le faux pilote pose deux questions successives dans le même AskUserQuestion.
    await telephone.getByRole('button', { name: 'A', exact: true }).click();
    await telephone.getByRole('button', { name: 'Confirmer', exact: true }).click();
    await expect(node(mac, '1-3.conversation.fil')).toContainText('réponses');
    await expect(node(mac, '1-3.conversation.fil')).toContainText('YAML');
  });

  test('marquer relu retire le tour de la boîte du Mac', async () => {
    await mac.goto(`http://127.0.0.1:${PORT}/boite`);
    await expect(mac.getByRole('button', { name: 'Marquer relu', exact: true })).toBeVisible();
    await telephone.getByRole('button', { name: 'Marquer relu', exact: true }).click();
    await expect(mac.getByRole('button', { name: 'Marquer relu', exact: true })).toHaveCount(0);
    await expect(telephone.getByRole('region', { name: 'À relire' })).toHaveCount(0);
  });

  test('une permission reste sur le Mac sans bouton', async () => {
    await demander('demande permission');
    const decisions = telephone.getByRole('region', { name: 'Décisions' });
    await expect(decisions).toContainText("Une autorisation t'attend, sur le Mac");
    await expect(decisions.getByRole('button')).toHaveCount(0);
  });

  test('largeur : quatre écrans à 320 px et cibles de 44 px', async () => {
    await telephone.setViewportSize({ width: 320, height: 640 });
    for (const [chemin, titre] of [
      ['/', 'À traiter'],
      ['/sujets', 'Sujets'],
      [`/sujets/${sujet}`, 'Recette mobile'],
      [`/sujets/${sujet}/livraison`, 'Autoriser un merge'],
    ]) {
      await telephone.goto(`${ORIGINE_APPAREIL}${chemin}`);
      await expect(telephone.getByRole('heading', { name: titre, exact: true })).toBeVisible();
      expect(
        await telephone.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
      for (const bouton of await telephone.getByRole('button').all()) {
        if (await bouton.isVisible())
          expect((await bouton.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
    }
    await telephone.route('**/api/appareils/sujets/*/livraison', (route) =>
      route.fulfill({
        json: { head: 'a'.repeat(40), fichiers: [{ nom: 'long.ts', ajouts: 1, retraits: 0 }] },
      }),
    );
    await telephone.route('**/api/appareils/sujets/*/fichiers/0/diff?*', (route) =>
      route.fulfill({
        json: { etat: 'ok', lignes: ['+' + 'ligne longue '.repeat(200)] },
      }),
    );
    await telephone.goto(`${ORIGINE_APPAREIL}/sujets/${sujet}/fichiers/0`);
    await expect(telephone.locator('.diff-ajout')).toBeVisible();
    expect(await telephone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      await telephone
        .locator('.appareil-diff')
        .evaluate((bloc) => bloc.scrollWidth > bloc.clientWidth),
    ).toBe(true);
    await telephone.unroute('**/api/appareils/sujets/*/livraison');
    await telephone.unroute('**/api/appareils/sujets/*/fichiers/0/diff?*');
    await telephone.setViewportSize({ width: 390, height: 844 });
  });

  test('Mac coupé : dernier état daté et aucune écriture active après recharge', async () => {
    await telephone.goto(ORIGINE_APPAREIL);
    await expect.poll(() => nombreEtats(telephone)).toBe(1);
    await expect
      .poll(() => telephone.evaluate(() => !!navigator.serviceWorker.controller))
      .toBe(true);
    await telephone.context().setOffline(true);
    await telephone.reload();
    await expect(telephone.getByText(/Mac injoignable/)).toBeVisible();
    await expect(telephone.getByText(/Dernier état connu il y a/)).toBeVisible();
    await expect(telephone.getByText('Recette mobile', { exact: true })).toBeVisible();
    await expect(telephone.locator('main button:enabled')).toHaveCount(0);
    await telephone.context().setOffline(false);
    await telephone.reload();
    await expect(telephone.getByText(/Mac injoignable/)).toHaveCount(0);
  });

  test('révoquer coupe l’accès et vide le stockage', async () => {
    await expect.poll(() => nombreEtats(telephone)).toBe(1);
    await mac.goto(`http://127.0.0.1:${PORT}/machines`);
    await mac
      .locator('[data-node^="host.appareil."]', { hasText: 'Mobile e2e' })
      .locator('[data-node$=".revoquer"]')
      .click();
    await expect(node(telephone, 'appareil.hors-acces.phrase')).toContainText('Accès coupé');
    await expect.poll(() => nombreEtats(telephone)).toBe(0);
    expect(await telephone.evaluate(() => localStorage.getItem('aid.mode'))).toBeNull();
  });
});

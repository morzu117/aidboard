import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  createTopic,
  launchShell,
  newRepo,
  node,
  openApp,
  registerWorkspace,
  rangerLaBarre,
  url,
} from './helpers.js';
import { fermerContextes } from './helpers.js';

// Chantier 25 : la coque de bout en bout sur le daemon partagé des e2e (faux swarph, faux serveur en mode
// commande). Les autres épreuves y laissent leurs sujets : on lit toujours la ligne de son propre sujet.

test.beforeAll(rangerLaBarre('etat'));
test.afterAll(rangerLaBarre('etat'));
test.afterAll(({ browser }) => fermerContextes(browser));

const barre = (page: Parameters<typeof node>[0], rest: string) =>
  node(page, `1-1.barre-gauche.${rest}`);

test('la barre et l’accueil rangent le sujet par état : en pause sans agent, en cours avec un shell', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext());
  await registerWorkspace(page, newRepo('depot-coque'));
  const id = await createTopic(page, 'Coque par état');

  await page.goto(url());
  await expect(barre(page, 'racine')).toHaveAttribute('data-rangement', 'etat');
  // En pause est repliée par défaut (D103)
  const pause = barre(page, 'etat.section-en-pause.bascule');
  await expect(pause).toHaveAttribute('aria-expanded', 'false');
  await pause.click();
  await expect(barre(page, `etat.sujet-${id}`)).toHaveAttribute('data-section', 'en-pause');
  const ligne = (section: string) =>
    node(page, `1-1.table.section-${section}`).locator('tr', {
      has: page.locator(`a[href="/sujets/${id}"]`),
    });
  await expect(ligne('en-pause').locator('[data-node$=".prochaine"]')).toHaveText(
    'Aucun agent sur ce sujet',
  );
  await expect(ligne('en-pause').locator('[data-node$=".action.bouton"]')).toHaveText('Lancer');
  await expect(ligne('en-pause').locator('[data-node$=".lieu"]')).toHaveText('local');

  await page.goto(`${url()}/sujets/${id}`);
  await launchShell(page);
  await page.goto(url());
  await expect(barre(page, `etat.sujet-${id}`)).toHaveAttribute('data-section', 'en-cours');
  await expect(ligne('en-cours').locator('[data-node$=".action.bouton"]')).toHaveText('Suivre');
  await expect(node(page, '1-1.table.tri')).toHaveCount(0);
});

test('« Ranger par mes groupes » dans Réglages, aller et retour', async ({ browser }) => {
  const page = await openApp(await browser.newContext());
  await page.goto(`${url()}/reglages`);
  const caseGroupes = node(page, 'reglages.rangement.groupes');
  await expect(caseGroupes).not.toBeChecked();
  await expect(node(page, 'reglages.barre-gauche.etat.sections')).toBeVisible();

  // case contrôlée : elle ne bascule qu'à la réponse du PATCH, `check()` refuserait d'attendre
  await caseGroupes.click();
  await expect(caseGroupes).toBeChecked();
  await expect(node(page, 'reglages.barre-gauche.etat.sections')).toHaveCount(0);
  await expect(node(page, 'reglages.barre-gauche.groupes')).toBeVisible();
  // la préférence est en base : un rechargement la garde
  await page.reload();
  await expect(node(page, 'reglages.rangement.groupes')).toBeChecked();
  await expect(node(page, 'reglages.barre-gauche.etat.sections')).toHaveCount(0);

  await node(page, 'reglages.rangement.groupes').click();
  await expect(node(page, 'reglages.rangement.groupes')).not.toBeChecked();
  await expect(node(page, 'reglages.barre-gauche.etat.sections')).toBeVisible();
});

test('la pastille mène à Réglages ; connecter, puis déconnecter après confirmation ; /swarph renvoie au réglage', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext());
  const inbox = join(process.env.AID_E2E_HOME!, 'swarph_state', 'morzu-mac', 'mesh-sidecar');
  mkdirSync(inbox, { recursive: true });
  await node(page, '1-1.barre.mesh').click();
  await expect(page).toHaveURL(/\/reglages#mesh$/);
  await expect(node(page, 'reglages.mesh')).toBeInViewport();
  await node(page, 'reglages.mesh.connecter').click();
  await expect(node(page, 'reglages.mesh.etat')).toHaveText(/^monitor actif/);
  await expect(node(page, 'reglages.barre.mesh.texte')).toHaveText(/^monitor actif/);

  await node(page, 'reglages.mesh.deconnecter').click();
  await expect(node(page, 'reglages.mesh.confirmation')).toContainText(
    'Toutes les sessions de cette cell',
  );
  await node(page, 'reglages.mesh.confirmer').click();
  await expect(node(page, 'reglages.barre.mesh.texte')).toHaveText(/^hors mesh/);

  // le mesh de ce daemon est configuré : la page d'explication renvoie au réglage plutôt qu'aux étapes
  await page.goto(`${url()}/swarph`);
  await expect(node(page, 'swarph.configure')).toBeVisible();
  await expect(node(page, 'swarph.configure').locator('a[href="/reglages#mesh"]')).toBeVisible();
});

test('bloc VPS : le faux serveur injoignable a sa carte, Diagnostiquer relance le test', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext());
  // mode commande `true` : aucun ssh, aucun réseau ; son contrôle échoue sans rien lancer
  const serveur = await page.evaluate(async () => {
    const r = await fetch('/api/servers', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'e2e-coque-vps',
        mode: 'command',
        target: 'true',
        loadProfile: false,
      }),
    });
    const { id } = (await r.json()) as { id: string };
    await fetch(`/api/servers/${id}/ping`, { method: 'POST', credentials: 'same-origin' });
    return id;
  });
  await page.goto(url());
  const carte = (rest = '') => barre(page, `vps.serveur-${serveur}${rest}`);
  await expect(carte('.etat')).toHaveText('Injoignable');
  await expect(carte('.action')).toHaveText('Diagnostiquer');
  await carte('.action').click();
  // le test relancé a fini : son étape en échec remplace la raison du contrôle
  await expect
    .poll(
      async () =>
        page.evaluate(
          async (id) =>
            (
              (await (
                await fetch(`/api/servers/${id}/test`, { credentials: 'same-origin' })
              ).json()) as {
                finishedAt?: string | null;
              }
            ).finishedAt ?? null,
          serveur,
        ),
      { timeout: 15_000 },
    )
    .not.toBeNull();
  await expect(carte('.detail')).toContainText(':');

  await page.evaluate(
    (id) => fetch(`/api/servers/${id}?force=1`, { method: 'DELETE', credentials: 'same-origin' }),
    serveur,
  );
});

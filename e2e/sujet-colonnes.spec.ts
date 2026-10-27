import { expect, test } from '@playwright/test';
import {
  createTopic,
  launchShell,
  newRepo,
  node,
  openApp,
  registerWorkspace,
  url,
} from './helpers.js';

// review D (findings 2/3/4, re-dev 2) : jsdom n'applique pas le CSS — seul un e2e vérifie la
// grille 25/50/25 sans défilement de page, et le popup de navigation non vide sous 1180 px.

test('≥ 1280 px : colonnes 25/50/25, la page ne défile pas', async ({ browser }) => {
  const page = await openApp(await browser.newContext({ viewport: { width: 1440, height: 900 } }));
  await registerWorkspace(page, newRepo('depot-sujet-colonnes-large'));
  await createTopic(page, 'Colonnes larges');
  await launchShell(page);

  const mesures = await page.evaluate(() => {
    const largeur = (sel: string) => document.querySelector(sel)!.getBoundingClientRect().width;
    return {
      cote: largeur('.barre-gauche'),
      centre: largeur('.sujet-contenu'),
      panneau: largeur('.panneau-contexte'),
      scrollHeight: document.scrollingElement!.scrollHeight,
      innerHeight: window.innerHeight,
    };
  });
  const total = mesures.cote + mesures.centre + mesures.panneau;
  const part = (w: number) => w / total;
  expect(part(mesures.cote)).toBeGreaterThan(0.23);
  expect(part(mesures.cote)).toBeLessThan(0.27);
  expect(part(mesures.centre)).toBeGreaterThan(0.48);
  expect(part(mesures.centre)).toBeLessThan(0.52);
  expect(part(mesures.panneau)).toBeGreaterThan(0.23);
  expect(part(mesures.panneau)).toBeLessThan(0.27);
  expect(mesures.scrollHeight).toBeLessThanOrEqual(mesures.innerHeight);
});

test('< 1180 px : le popup de navigation n’est pas vide, Échap le referme', async ({ browser }) => {
  const page = await openApp(await browser.newContext({ viewport: { width: 1000, height: 800 } }));
  await registerWorkspace(page, newRepo('depot-sujet-colonnes-popup'));
  await createTopic(page, 'Colonnes popup');
  await launchShell(page);

  await node(page, '1-3.volet.ouvrir-nav').click();
  const dialogue = page.getByRole('dialog', { name: 'Navigation' });
  await expect(dialogue).toBeVisible();
  await expect(dialogue.locator('.barre-gauche-sujet').first()).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialogue).not.toBeVisible();
});

// review B.4 (finding 8) : en rail, la colonne de droite doit rester 25 % de la FENÊTRE (pas
// du reste après le rail de 72 px) ; persistance au rechargement ; la pop-up sous 1280 px montre
// toujours la barre complète même si `reduit` est enregistré à vrai (D58).
test('rail : colonne de droite à 25 % de la fenêtre, persiste, pop-up complète sous 1280 px', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext({ viewport: { width: 1440, height: 900 } }));
  await registerWorkspace(page, newRepo('depot-sujet-colonnes-rail'));
  await createTopic(page, 'Colonnes rail');
  await launchShell(page);

  const mesurer = () =>
    page.evaluate(() => {
      const largeur = (sel: string) => document.querySelector(sel)!.getBoundingClientRect().width;
      return {
        cote: largeur('.barre-gauche'),
        centre: largeur('.sujet-contenu'),
        panneau: largeur('.panneau-contexte'),
        scrollHeight: document.scrollingElement!.scrollHeight,
        innerHeight: window.innerHeight,
      };
    });

  await page.getByRole('button', { name: 'Réduire la barre' }).click();
  let mesures = await mesurer();
  expect(mesures.cote).toBeGreaterThan(70);
  expect(mesures.cote).toBeLessThan(74);
  expect(mesures.panneau).toBeGreaterThan(356);
  expect(mesures.panneau).toBeLessThan(364);
  expect(mesures.cote + mesures.centre + mesures.panneau).toBeGreaterThan(1430);
  expect(mesures.cote + mesures.centre + mesures.panneau).toBeLessThan(1450);
  expect(mesures.scrollHeight).toBeLessThanOrEqual(mesures.innerHeight);

  await page.reload();
  await expect(page.getByRole('button', { name: 'Déplier la barre' })).toBeVisible();
  // le rechargement remonte l'écran Sujet depuis zéro : laisser le panneau de contexte s'attacher
  // avant de mesurer, sinon le premier passage peut tomber sur un DOM encore partiel.
  await expect(page.locator('.panneau-contexte')).toBeVisible();
  mesures = await mesurer();
  expect(mesures.cote).toBeGreaterThan(70);
  expect(mesures.cote).toBeLessThan(74);

  await page.getByRole('button', { name: 'Déplier la barre' }).click();
  mesures = await mesurer();
  const total = mesures.cote + mesures.centre + mesures.panneau;
  expect(mesures.cote / total).toBeGreaterThan(0.23);
  expect(mesures.cote / total).toBeLessThan(0.27);
  expect(mesures.panneau / total).toBeGreaterThan(0.23);
  expect(mesures.panneau / total).toBeLessThan(0.27);

  await page.getByRole('button', { name: 'Réduire la barre' }).click();
  await page.setViewportSize({ width: 1100, height: 800 });
  await node(page, '1-3.volet.ouvrir-nav').click();
  const dialogue = page.getByRole('dialog', { name: 'Navigation' });
  await expect(dialogue).toBeVisible();
  await expect(dialogue.getByRole('button', { name: 'Modifier' })).toBeVisible();
  await page.keyboard.press('Escape');

  // `reduit` est une préférence serveur partagée entre toutes les specs e2e de la suite (un seul
  // daemon) : la remettre à false pour ne pas laisser la barre en rail aux specs suivantes.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('button', { name: 'Déplier la barre' })).toBeVisible();
  await page.getByRole('button', { name: 'Déplier la barre' }).click();
  await expect(page.getByRole('button', { name: 'Réduire la barre' })).toBeVisible();

  // suite e2e à un seul worker, aucun teardown entre fichiers : fermer ce contexte
  // pour ne pas ajouter notre poids à l'état partagé des specs suivantes (finding 9).
  await page.context().close();
});

// B.2 (finding 11, re-dev) : la barre gauche est désormais posée sur tous les écrans — les
// autres écrans ne doivent pas hériter du « page ne défile pas » propre à l'écran Sujet.
test('les autres écrans défilent toujours ; la barre gauche reste visible', async ({ browser }) => {
  const page = await openApp(await browser.newContext({ viewport: { width: 1440, height: 600 } }));
  for (const nom of ['depot-reglages-un', 'depot-reglages-deux', 'depot-reglages-trois']) {
    await registerWorkspace(page, newRepo(nom));
    // registerWorkspace laisse « Nouveau sujet » ouvert ; sans le fermer, le clic du tour suivant
    // sur le bouton d'en-tête tombe derrière l'overlay et n'aboutit jamais (timeout du test).
    await page.getByRole('button', { name: 'Fermer' }).click();
  }
  await page.goto(`${url()}/reglages`);
  await expect(node(page, 'reglages.barre-gauche.racine')).toBeVisible();

  const mesures = await page.evaluate(() => {
    const scrollable = (el: Element) => {
      const style = getComputedStyle(el);
      return el.scrollHeight > el.clientHeight && /auto|scroll/.test(style.overflowY);
    };
    const principal = document.querySelector('main');
    return {
      pageDefile: document.scrollingElement!.scrollHeight > window.innerHeight,
      principalDefile: principal ? scrollable(principal) : false,
    };
  });
  expect(mesures.pageDefile || mesures.principalDefile).toBe(true);
});

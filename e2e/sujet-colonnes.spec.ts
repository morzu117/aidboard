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

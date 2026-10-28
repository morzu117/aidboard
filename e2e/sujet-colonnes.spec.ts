import { expect, test, type Page } from '@playwright/test';
import {
  createTopic,
  launchShell,
  newRepo,
  node,
  openApp,
  registerWorkspace,
  state,
  url,
} from './helpers.js';

// review D (findings 2/3/4, re-dev 2) : jsdom n'applique pas le CSS — seul un e2e vérifie la
// grille 12,5/62,5/25 sans défilement de page, et le popup de navigation non vide sous 1180 px.
// recette (point 2) : barre gauche réduite de moitié (12,5 %), le centre reprend la place
// (62,5 %), le panneau de droite inchangé (25 %) — décision opérateur, chantier 15.

test('≥ 1280 px : colonnes 12,5/62,5/25, la page ne défile pas, la barre gauche ne déborde pas', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext({ viewport: { width: 1440, height: 900 } }));
  await registerWorkspace(page, newRepo('depot-sujet-colonnes-large'));
  await createTopic(page, 'Colonnes larges');
  await launchShell(page);

  const mesures = await page.evaluate(() => {
    const largeur = (sel: string) => document.querySelector(sel)!.getBoundingClientRect().width;
    const bg = document.querySelector('.barre-gauche')!;
    return {
      cote: largeur('.barre-gauche'),
      centre: largeur('.sujet-contenu'),
      panneau: largeur('.panneau-contexte'),
      scrollHeight: document.scrollingElement!.scrollHeight,
      innerHeight: window.innerHeight,
      bgScrollWidth: bg.scrollWidth,
      bgClientWidth: bg.clientWidth,
    };
  });
  const total = mesures.cote + mesures.centre + mesures.panneau;
  const part = (w: number) => w / total;
  expect(part(mesures.cote)).toBeGreaterThan(0.11);
  expect(part(mesures.cote)).toBeLessThan(0.14);
  expect(part(mesures.centre)).toBeGreaterThan(0.6);
  expect(part(mesures.centre)).toBeLessThan(0.65);
  expect(part(mesures.panneau)).toBeGreaterThan(0.23);
  expect(part(mesures.panneau)).toBeLessThan(0.27);
  expect(mesures.scrollHeight).toBeLessThanOrEqual(mesures.innerHeight);
  // barre gauche réduite à 12,5 % : le contenu (bouton, vues, groupes, noms de sujet) doit se
  // tronquer plutôt que déborder horizontalement de la colonne.
  expect(mesures.bgScrollWidth).toBeLessThanOrEqual(mesures.bgClientWidth + 1);
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
  // barre gauche déployée à 12,5 % désormais (recette, point 2) ; le panneau reste à 25 %.
  expect(mesures.cote / total).toBeGreaterThan(0.11);
  expect(mesures.cote / total).toBeLessThan(0.14);
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

// marque le wrapper (masque/pas masque) du <Terminal> d'un agent pour pouvoir l'interroger via
// un Locator Playwright (toBeHidden/toBeVisible) — repéré depuis window.__aidTerminals (D65).
async function marquerWrapperTerminal(page: Page, agentId: string, marque: string): Promise<void> {
  await page.evaluate(
    ({ id, marque }) => {
      const terms = (window as unknown as { __aidTerminals: Record<string, { element: Element }> })
        .__aidTerminals;
      const sortie = terms[id]!.element.closest('.sortie-xterm')!;
      sortie.parentElement!.setAttribute('data-e2e-wrapper', marque);
    },
    { id: agentId, marque },
  );
}

// correctif 3 (recette) : espace agent sans cadre, Arrêter sur la rangée d'onglets, PTY actif
// jusqu'au bas de la colonne, bug .masque corrigé (brief §5.3, §2.1).
test('≥ 1280 px, deux agents PTY : rangée d’onglets plate, Arrêter aligné, sortie jusqu’au bas, agent non actif masqué', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext({ viewport: { width: 1440, height: 900 } }));
  await registerWorkspace(page, newRepo('depot-sujet-agent-espace'));
  const topicId = await createTopic(page, 'Espace agent');
  // state() rend tous les agents du daemon partagé par la suite e2e (un seul worker, aucun
  // teardown entre fichiers) : filtrer sur ce sujet via les runs plutôt que de faire confiance
  // à `.at(-1)`, y compris pour launchShell lui-même — un autre fichier de la suite peut avoir
  // lancé un agent juste après.
  const agentsDuSujet = async () => {
    const s = await state(page);
    const runIds = new Set(s.runs.filter((r) => r.topicId === topicId).map((r) => r.id));
    return s.agents.filter((a) => runIds.has(a.runId));
  };
  await launchShell(page);
  await expect.poll(async () => (await agentsDuSujet()).length).toBe(1);
  const first = (await agentsDuSujet())[0]!.id;
  await node(page, '1-3.terminaux.ajouter-agent').click();
  await page.locator('[data-action="agent.lancer"][data-agent="shell"]').click();
  await expect.poll(async () => (await agentsDuSujet()).length).toBe(2);
  const second = (await agentsDuSujet()).find((a) => a.id !== first)!.id;
  expect(second).not.toBe(first);

  // (b) la boîte .terminaux n'a plus de cadre : plus de bordure, héritée de l'ancien .terminaux.
  const borderTop = await page.evaluate(
    () => getComputedStyle(document.querySelector('.terminaux')!).borderTopWidth,
  );
  expect(borderTop).toBe('0px');

  // (a) « Arrêter » est sur la même ligne que les onglets, à droite du dernier.
  const geom = await page.evaluate(() => {
    const onglets = Array.from(
      document.querySelectorAll('.onglet[data-node^="1-3.terminaux.onglet-"]'),
    );
    const dernier = onglets.at(-1)!.getBoundingClientRect();
    const arreter = document
      .querySelector('[data-node="1-3.terminaux.arreter"]')!
      .getBoundingClientRect();
    return {
      dernierCenterY: dernier.top + dernier.height / 2,
      arreterCenterY: arreter.top + arreter.height / 2,
      dernierRight: dernier.right,
      arreterLeft: arreter.left,
    };
  });
  expect(Math.abs(geom.dernierCenterY - geom.arreterCenterY)).toBeLessThanOrEqual(6);
  expect(geom.arreterLeft).toBeGreaterThan(geom.dernierRight);

  // (d) bug .masque : le wrapper de l'agent non actif (first) n'est pas visible, celui de
  // l'agent actif (second, le dernier lancé) l'est. L'état serveur (state()) devance le montage
  // côté client du second <Terminal> : attendre son inscription dans __aidTerminals avant de le marquer.
  await page.waitForFunction(
    (id) =>
      !!(window as unknown as { __aidTerminals?: Record<string, unknown> }).__aidTerminals?.[id],
    second,
  );
  await marquerWrapperTerminal(page, first, 'w-first');
  await marquerWrapperTerminal(page, second, 'w-second');
  const wFirst = page.locator('[data-e2e-wrapper="w-first"]');
  const wSecond = page.locator('[data-e2e-wrapper="w-second"]');
  await expect(wFirst).toBeHidden();
  await expect(wSecond).toBeVisible();

  // (c) le terminal actif (pied compris) descend jusqu'au bas du viewport, aucun scroll de page.
  const box = (await wSecond.boundingBox())!;
  expect(900 - box.y - box.height).toBeLessThanOrEqual(32);
  expect(
    await page.evaluate(() => document.scrollingElement!.scrollHeight <= window.innerHeight),
  ).toBe(true);

  // (d), suite : changer d'onglet inverse le masquage.
  await node(page, '1-3.terminaux.onglet-1').click();
  await expect(wFirst).toBeVisible();
  await expect(wSecond).toBeHidden();
});

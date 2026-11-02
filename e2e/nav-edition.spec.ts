import { expect, type Page, test } from '@playwright/test';
import { createTopic, newRepo, node, openApp, registerWorkspace, url } from './helpers.js';

// B.3 (chantier 15) : mode édition de la barre gauche — glisser un sujet vers un autre groupe
// (souris) puis la même action par le menu « Déplacer vers… » (alternative clavier, §2.4) ;
// les deux doivent persister après rechargement.

// d'autres sujets/groupes peuvent déjà exister (autres specs du même worker e2e) : on cible
// chaque groupe par son nom plutôt que par position dans la liste.
const groupe = (page: Page, nom: string) =>
  page
    .locator('.barre-gauche-groupe')
    .filter({ has: page.locator('.barre-gauche-groupe-nom', { hasText: nom }) });

test('glisser-déposer un sujet vers un autre groupe persiste après rechargement', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext({ viewport: { width: 1440, height: 900 } }));
  await registerWorkspace(page, newRepo('depot-nav-edition-un'));
  await createTopic(page, 'Sujet un');
  await page.goto(url());
  await registerWorkspace(page, newRepo('depot-nav-edition-deux'));
  await createTopic(page, 'Sujet deux');
  await page.goto(url());

  await node(page, '1-1.barre-gauche.groupes.modifier').click();
  const premier = groupe(page, 'depot-nav-edition-un');
  const second = groupe(page, 'depot-nav-edition-deux');
  await expect(premier.locator('.barre-gauche-sujet')).toHaveCount(1);
  await expect(second.locator('.barre-gauche-sujet')).toHaveCount(1);

  await premier.locator('.barre-gauche-sujet').dragTo(second);
  await expect(premier.locator('.barre-gauche-sujet')).toHaveCount(0);
  await expect(second.locator('.barre-gauche-sujet')).toHaveCount(2);

  await page.reload();
  await expect(groupe(page, 'depot-nav-edition-un').locator('.barre-gauche-sujet')).toHaveCount(0);
  await expect(groupe(page, 'depot-nav-edition-deux').locator('.barre-gauche-sujet')).toHaveCount(
    2,
  );
});

// review B.3 (finding 4) : un navigateur réel peut émettre un `blur` synchrone au démontage du
// champ de renommage — Échap ne doit jamais laisser ce blur valider derrière lui.
test('renommer un sujet, taper, Échap → recharger → nom inchangé (navigateur réel)', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext({ viewport: { width: 1440, height: 900 } }));
  await registerWorkspace(page, newRepo('depot-nav-echap'));
  await createTopic(page, 'Sujet un');
  await page.goto(url());

  await node(page, '1-1.barre-gauche.groupes.modifier').click();
  const nomSujet = groupe(page, 'depot-nav-echap').locator('.barre-gauche-sujet-nom');
  const nomAvant = (await nomSujet.textContent())!;

  await groupe(page, 'depot-nav-echap').locator('.barre-gauche-sujet').dblclick();
  const champ = groupe(page, 'depot-nav-echap').locator('.barre-gauche-renommage');
  await expect(champ).toBeVisible();
  await champ.fill('Nom qui ne doit jamais être enregistré');
  await champ.press('Escape');
  await expect(champ).toBeHidden();

  await page.reload();
  await expect(groupe(page, 'depot-nav-echap').locator('.barre-gauche-sujet-nom')).toHaveText(
    nomAvant,
  );
  // suite e2e à un seul worker, aucun teardown entre fichiers : fermer ce contexte
  // pour ne pas ajouter notre poids à l'état partagé des specs suivantes (finding 9).
  await page.context().close();
});

test('alternative clavier (menu « Déplacer vers… ») persiste après rechargement, focus rendu au ···', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext({ viewport: { width: 1440, height: 900 } }));
  await registerWorkspace(page, newRepo('depot-nav-clavier-un'));
  await createTopic(page, 'Sujet un');
  await page.goto(url());
  await registerWorkspace(page, newRepo('depot-nav-clavier-deux'));
  await createTopic(page, 'Sujet deux');
  await page.goto(url());

  await node(page, '1-1.barre-gauche.groupes.modifier').click();
  const premier = groupe(page, 'depot-nav-clavier-un');
  const second = groupe(page, 'depot-nav-clavier-deux');
  const nomSecond = (await second.locator('.barre-gauche-groupe-nom').textContent())!.trim();

  const ligneSujet = premier.locator('.barre-gauche-sujet-ligne');
  const boutonActions = ligneSujet.getByRole('button', { name: /^Actions pour/ });
  const libelleActions = (await boutonActions.getAttribute('aria-label'))!;
  await boutonActions.click();
  await page.getByRole('menuitem', { name: 'Déplacer vers…' }).click();
  await page.getByRole('menuitem', { name: nomSecond, exact: true }).click();

  await expect(premier.locator('.barre-gauche-sujet')).toHaveCount(0);
  await expect(second.locator('.barre-gauche-sujet')).toHaveCount(2);
  const boutonDeplace = second
    .locator('.barre-gauche-sujet-ligne')
    .getByRole('button', { name: libelleActions, exact: true });
  await expect(boutonDeplace).toBeFocused();

  await page.reload();
  await expect(groupe(page, 'depot-nav-clavier-un').locator('.barre-gauche-sujet')).toHaveCount(0);
  await expect(groupe(page, 'depot-nav-clavier-deux').locator('.barre-gauche-sujet')).toHaveCount(
    2,
  );
});

// Constat opérateur (recette chantier 15) : nom écrasé, temps cassé lettre par lettre sur un nom long.
test('la ligne de sujet tient sur une seule ligne même avec un nom long, en mode normal et en édition', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext({ viewport: { width: 1440, height: 900 } }));
  await registerWorkspace(page, newRepo('depot-nav-ligne-longue'));
  const topicId = await createTopic(
    page,
    'Un sujet avec un nom vraiment très long pour vérifier le débordement de la barre gauche',
  );
  await page.goto(url());

  const verifie = async () => {
    const lien = node(page, `1-1.barre-gauche.sujet-${topicId}`);
    const boiteLien = await lien.boundingBox();
    const boiteNom = await lien.locator('.barre-gauche-sujet-nom').boundingBox();
    const boiteTemps = await lien.locator('.barre-gauche-sujet-temps').boundingBox();
    expect(boiteLien!.height).toBeLessThanOrEqual(40);
    const centreNom = boiteNom!.y + boiteNom!.height / 2;
    const centreTemps = boiteTemps!.y + boiteTemps!.height / 2;
    expect(Math.abs(centreNom - centreTemps)).toBeLessThanOrEqual(4);
  };

  await verifie();
  await node(page, '1-1.barre-gauche.groupes.modifier').click();
  await verifie();
});

// fix/nav-edition-clic : depuis l'accueil, le premier clic du double-clic ouvrait le sujet ; l'écran
// changé remontait Nav, qui perdait le mode édition et le champ de renommage. En mode édition, un
// clic sur un sujet ne navigue plus.
test('depuis l’accueil, double-clic en mode édition : même écran, le champ tient, le nom persiste', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext({ viewport: { width: 1440, height: 900 } }));
  await registerWorkspace(page, newRepo('depot-nav-double-clic'));
  const topicId = await createTopic(page, 'Sujet un');
  await page.goto(url());
  const sujet = node(page, `1-1.barre-gauche.sujet-${topicId}`);
  await expect(sujet).toBeVisible();
  const urlAccueil = page.url();

  // l'écran du sujet lit son journal git dès son montage : aucune de ces requêtes ne doit partir
  const journalGit: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes(`/api/topics/${topicId}/git/log`)) journalGit.push(r.url());
  });

  await node(page, '1-1.barre-gauche.groupes.modifier').click();
  await sujet.dblclick();
  const champ = node(page, `1-1.barre-gauche.sujet-${topicId}.renommer`);
  await expect(champ).toBeVisible();
  await expect(page).toHaveURL(urlAccueil);

  // au-delà d'un changement d'écran : deux frames rendues, puis un aller-retour complet au daemon —
  // tout ce qu'un écran monté entre-temps aurait demandé est parti avant que celui-ci revienne
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
  );
  await page.evaluate(async () =>
    (await fetch('/api/state', { credentials: 'same-origin' })).json(),
  );
  expect(journalGit).toEqual([]);
  await expect(page).toHaveURL(urlAccueil);
  await expect(champ).toBeVisible();
  await expect(node(page, '1-1.barre-gauche.groupes.modifier')).toHaveText('Terminer');

  const enregistre = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && r.url().endsWith(`/api/nav/placements/${topicId}`),
  );
  await champ.fill('Renommé depuis l’accueil');
  await champ.press('Enter');
  expect((await enregistre).ok()).toBe(true);
  await expect(champ).toBeHidden();
  await expect(sujet.locator('.barre-gauche-sujet-nom')).toHaveText('Renommé depuis l’accueil');
  await expect(page).toHaveURL(urlAccueil);

  await page.reload();
  await expect(
    node(page, `1-1.barre-gauche.sujet-${topicId}`).locator('.barre-gauche-sujet-nom'),
  ).toHaveText('Renommé depuis l’accueil');
  // suite e2e à un seul worker, aucun teardown entre fichiers : fermer ce contexte (finding 9)
  await page.context().close();
});

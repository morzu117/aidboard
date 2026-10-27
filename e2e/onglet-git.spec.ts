import { expect, test } from '@playwright/test';
import { commitFile, sh } from '../test/helpers/git.js';
import { createTopic, newRepo, node, openApp, registerWorkspace } from './helpers.js';

// correctif 4 (recette) : jsdom n'applique pas le CSS — seul un e2e vérifie que l'onglet Git
// du panneau (~360 px à 1440 px de fenêtre) ne déborde plus horizontalement et que le détail
// remplace bien la liste au lieu de s'écraser à côté (brief §5.3.3 « Git »).

const MESSAGE_1 =
  'Message de commit numéro un suffisamment long pour vérifier que les lignes ne débordent jamais du panneau étroit';
const MESSAGE_2 =
  'Message de commit numéro deux suffisamment long pour vérifier que le texte ne coupe jamais lettre par lettre';
const MESSAGE_3 =
  'Message de commit numéro trois suffisamment long pour vérifier que chaque ligne garde la même hauteur fixe';
// re-dev 2/2 : étiquette de ref longue (≥ 30 caractères) sur le commit de tête, pour reproduire
// la coupe lettre par lettre constatée en vrai navigateur (brief « re-dev 2/2 », point 1).
const LONG_REF = 'correctif-4-recette-etiquette-de-ref-tres-longue-pour-le-test';

test('onglet Git du panneau à 1440 px : pas de débordement, détail à la place de la liste', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext({ viewport: { width: 1440, height: 900 } }));
  await registerWorkspace(page, newRepo('depot-onglet-git'));
  await createTopic(page, 'Onglet Git');

  await node(page, '1-3.actions.plus').click();
  const worktree = (await node(page, '1-3.entete.worktree').textContent())!;
  await node(page, '1-3.actions.plus').click();
  commitFile(worktree, 'note1.txt', 'contenu 1\n', MESSAGE_1);
  commitFile(worktree, 'note2.txt', 'contenu 2\n', MESSAGE_2);
  commitFile(worktree, 'note3.txt', 'contenu 3\n', MESSAGE_3);
  sh(worktree, 'branch', LONG_REF);

  await page.getByRole('tab', { name: 'Git' }).click();
  const ligne = page.locator('.panneau-contexte .commit', { hasText: MESSAGE_1 });
  await expect(ligne).toBeVisible();

  // (a) rien ne déborde horizontalement de .panneau-contenu.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const el = document.querySelector('.panneau-contenu')!;
        return el.scrollWidth <= el.clientWidth + 1;
      }),
    )
    .toBe(true);

  // (b) la ligne du commit tient en 56 px de haut, message visible.
  const box = (await ligne.boundingBox())!;
  expect(box.height).toBeLessThanOrEqual(56);

  // re-dev 2/2 : géométrie fine de chaque ligne visible — étiquette longue sur le commit de
  // tête, messages ≥ 80 caractères, pour reproduire la coupe lettre par lettre, le chevauchement
  // de lignes et le rognage sans ellipse constatés par l'opérateur en vrai navigateur.
  const lignes = await page.evaluate(() => {
    const commits = Array.from(document.querySelectorAll<HTMLElement>('.panneau-contexte .commit'));
    return commits.map((commit) => {
      const r = commit.getBoundingClientRect();
      const message = commit.querySelector<HTMLElement>('.message')?.textContent ?? '';
      const descendants = Array.from(
        commit.querySelectorAll<HTMLElement>(
          '.etiquette, .message, .commit-meta, .commit-hash, svg.graphe',
        ),
      ).map((el) => {
        const d = el.getBoundingClientRect();
        return {
          // className d'un <svg> est un SVGAnimatedString, pas une chaîne : getAttribute marche pour les deux.
          classe: el.getAttribute('class') ?? '',
          right: d.right,
          bottom: d.bottom,
          width: d.width,
          height: d.height,
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        };
      });
      return { top: r.top, bottom: r.bottom, right: r.right, message, descendants };
    });
  });

  expect(lignes.length).toBeGreaterThanOrEqual(3);
  // les 3 commits de test, dont le message (≥ 80 caractères) doit être tronqué par ellipse.
  const longuesMessages = [MESSAGE_1, MESSAGE_2, MESSAGE_3];
  expect(lignes.filter((r) => longuesMessages.includes(r.message)).length).toBe(3);

  for (const row of lignes) {
    const messageDoitDeborder = longuesMessages.includes(row.message);
    for (const d of row.descendants) {
      // (a) aucun descendant ne dépasse le cadre de sa ligne, ni en largeur ni en hauteur.
      expect(d.right).toBeLessThanOrEqual(row.right + 1);
      expect(d.bottom).toBeLessThanOrEqual(row.bottom + 1);
      // (c) l'étiquette de ref tient sur une seule ligne.
      if (d.classe.includes('etiquette')) expect(d.height).toBeLessThanOrEqual(24);
      // (d) message long tronqué par ellipse, hash jamais rogné.
      if (d.classe === 'message' && messageDoitDeborder) {
        expect(d.scrollWidth).toBeGreaterThan(d.clientWidth);
      }
      if (d.classe === 'commit-hash') expect(d.scrollWidth).toBeLessThanOrEqual(d.clientWidth);
      // (e) graphe étroit (3 voies max), hauteur alignée sur la ligne.
      if (d.classe === 'graphe') {
        expect(d.width).toBeLessThanOrEqual(64);
        expect(Math.abs(d.height - (row.bottom - row.top))).toBeLessThanOrEqual(1);
      }
    }
  }
  // (b) lignes consécutives : jamais de chevauchement.
  for (let i = 1; i < lignes.length; i++) {
    expect(lignes[i]!.top).toBeGreaterThanOrEqual(lignes[i - 1]!.bottom - 1);
  }

  // (c) clic -> détail visible, liste masquée ; Retour -> liste visible.
  await ligne.click();
  await expect(page.locator('.panneau-contexte [data-node="1-3.git.detail.retour"]')).toBeVisible();
  await expect(page.locator('.panneau-contexte [role="list"][aria-label="Commits"]')).toHaveCount(
    0,
  );
  await page.locator('.panneau-contexte [data-node="1-3.git.detail.retour"]').click();
  await expect(page.locator('.panneau-contexte [role="list"][aria-label="Commits"]')).toBeVisible();
});

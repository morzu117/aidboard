import { expect, test } from '@playwright/test';
import { commitFile } from '../test/helpers/git.js';
import { createTopic, newRepo, node, openApp, registerWorkspace } from './helpers.js';

// correctif 4 (recette) : jsdom n'applique pas le CSS — seul un e2e vérifie que l'onglet Git
// du panneau (~360 px à 1440 px de fenêtre) ne déborde plus horizontalement et que le détail
// remplace bien la liste au lieu de s'écraser à côté (brief §5.3.3 « Git »).

const MESSAGE_1 =
  'Message de commit numéro un suffisamment long pour vérifier que les lignes ne débordent jamais du panneau étroit';
const MESSAGE_2 =
  'Message de commit numéro deux suffisamment long pour vérifier que le texte ne coupe jamais lettre par lettre';

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

  // (c) clic -> détail visible, liste masquée ; Retour -> liste visible.
  await ligne.click();
  await expect(page.locator('.panneau-contexte [data-node="1-3.git.detail.retour"]')).toBeVisible();
  await expect(page.locator('.panneau-contexte [role="list"][aria-label="Commits"]')).toHaveCount(
    0,
  );
  await page.locator('.panneau-contexte [data-node="1-3.git.detail.retour"]').click();
  await expect(page.locator('.panneau-contexte [role="list"][aria-label="Commits"]')).toBeVisible();
});

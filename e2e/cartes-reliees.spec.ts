import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { preparerMeshes } from './helpers-multi-mesh.js';
import { demarrerHost } from './host-helpers.js';

const PORT = Number(process.env.AID_E2E_PORT ?? 4871) + 15;
const CLI = join(import.meta.dirname, '../dist/cli/aid.js');

test('même carte sur deux meshes : lien, états, écart, remplacement puis retrait', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const faux = await preparerMeshes();
  const contexte = await browser.newContext();
  let home = '';
  try {
    const instance = demarrerHost(PORT, faux.supplement);
    home = instance.home;
    const page = await contexte.newPage();
    const origine = `http://127.0.0.1:${PORT}`;
    await page.goto(`${origine}/?token=${instance.token}`);
    await page.goto(`${origine}/board/cartes/101?mesh=principal`);
    await page.getByRole('button', { name: 'Relier à une carte d’un autre mesh' }).click();
    const dialogue = page.getByRole('dialog');
    await dialogue.getByLabel('Mesh de la carte').selectOption('perso');
    await dialogue.getByLabel('Numéro de carte').fill('101');
    await dialogue.getByRole('button', { name: 'Aperçu', exact: true }).click();
    const apercu = dialogue.getByLabel('Aperçu des deux cartes');
    await expect(apercu).toContainText('principal #101 · Carte principal · idea');
    await expect(apercu).toContainText('perso #101 · Carte perso · build');
    await dialogue.getByRole('button', { name: 'Confirmer le lien' }).click();
    const section = page.getByRole('region', { name: 'Même carte ailleurs' });
    await expect(section).toContainText('Carte perso');
    await expect(section).toContainText('build');
    await page.goto(`${origine}/board`);
    const liste = page.getByRole('region', { name: 'Cartes reliées' });
    await expect(liste.getByRole('row').filter({ hasText: 'principal #101' })).toContainText(
      'idea',
    );
    await expect(liste.getByRole('row').filter({ hasText: 'perso #101' })).toContainText('build');
    await expect(liste.getByText('écart', { exact: true })).toBeVisible();

    // Même numéro et même date : seul le fil change. Laisser expirer le vrai cache de 60 s.
    faux.meshes[1]!.carte.thread_uuid = '00000000-0000-0000-0000-000000000999';
    faux.meshes[1]!.carte.title = 'Titre de remplacement à masquer';
    await expect(async () => {
      await page.goto(`${origine}/board/cartes/101?mesh=principal`);
      await expect(section.getByText('carte remplacée', { exact: true })).toBeVisible({
        timeout: 1_000,
      });
    }).toPass({ timeout: 80_000, intervals: [5_000] });
    await expect(section.getByRole('row').filter({ hasText: 'perso #101' })).toHaveText(
      'perso #101carte remplacée',
    );
    await expect(section).not.toContainText('Titre de remplacement à masquer');
    await section
      .getByRole('listitem')
      .filter({ hasText: 'perso #101' })
      .getByRole('button', { name: 'Retirer du groupe' })
      .click();
    await expect(dialogue).toContainText('Retirer perso #101 du groupe ?');
    await dialogue.getByRole('button', { name: 'Confirmer le retrait' }).click();
    await expect(section).toHaveCount(0);
    await page.goto(`${origine}/board`);
    await expect(liste).toContainText('Aucune carte reliée.');
    for (const mesh of faux.meshes) {
      expect(mesh.requetes.some((r) => r.verb === 'board.card.get' && r.args.id === 101)).toBe(
        true,
      );
      expect(
        mesh.requetes.filter(
          (r) =>
            ![
              'board.projects.list',
              'board.cards.list',
              'board.card.get',
              'board.cards.graph',
              'board.cards.thread',
              'board.obligations.list',
              'mesh.peers',
              'rights',
              'memory.list',
            ].includes(r.verb),
        ),
      ).toEqual([]);
    }
  } finally {
    await contexte.close();
    try {
      if (home)
        execFileSync(process.execPath, [CLI, 'stop', '--force'], {
          env: { ...process.env, AID_HOME: home },
          timeout: 30_000,
        });
    } finally {
      await faux.fermer();
    }
  }
});

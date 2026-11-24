import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect, test } from './test.js';
import { node } from './helpers.js';

const cli = join(import.meta.dirname, '../dist/cli/aid.js');
const fixtures = join(import.meta.dirname, '../test/fixtures');
const question = '1. Faut-il vérifier les tests ?\n2. Faut-il livrer maintenant ?';

let daemon: { dossier: string; env: NodeJS.ProcessEnv } | null = null;

// Le hook dispose de son propre délai, même après expiration du test ou fermeture du contexte.
test.afterEach(() => {
  if (!daemon) return;
  const { dossier, env } = daemon;
  try {
    execFileSync(process.execPath, [cli, 'stop', '--force'], { env, timeout: 30_000 });
  } finally {
    rmSync(dossier, { recursive: true, force: true });
    daemon = null;
  }
});

// Un daemon par mode : le faux CLI lit son mode dans son environnement au lancement.
for (const [indice, mode] of ['ok', 'refus', 'aucun'].entries()) {
  test(`demande d’avis via le service interne : ${mode}`, async ({ browser }) => {
    const dossier = realpathSync(mkdtempSync(join(tmpdir(), 'aid-e2e-ask-')));
    const port = Number(process.env.AID_E2E_PORT ?? 4871) + 20 + indice;
    const journal = join(dossier, 'avis-cli.log');
    writeFileSync(
      join(dossier, 'config.yaml'),
      `port: ${port}\nswairm:\n  bin: ${join(fixtures, 'fake-swairm.sh')}\nagents:\n  transport: pty\n`,
      { mode: 0o600 },
    );
    const env = {
      ...process.env,
      AID_HOME: dossier,
      AID_NO_BROWSER: '1',
      SHELL: '/bin/sh',
      PATH: `${join(fixtures, 'fake-avis')}${delimiter}${process.env.PATH}`,
      FAKE_AVIS_MODE: mode === 'ok' ? 'partage' : mode === 'aucun' ? 'aucun' : 'ok',
      FAKE_AVIS_LOG: journal,
    };
    daemon = { dossier, env };
    const contexte = await browser.newContext();
    try {
      execFileSync(process.execPath, [cli], { env, timeout: 40_000 });
      const { token } = JSON.parse(readFileSync(join(dossier, 'daemon.json'), 'utf8'));
      const page = await contexte.newPage();
      await page.goto(`http://127.0.0.1:${port}/?token=${token}`);
      await expect(node(page, '1-1.barre.marque')).toBeVisible();
      await page.goto(`http://127.0.0.1:${port}/swarph`);
      await node(page, 'swarph.ask').click();
      const boite = page.getByRole('dialog', { name: 'Demander N avis' });
      await expect(boite).toContainText('Coût maximal : 1.50 USD');
      await expect(boite).toContainText(
        "Le texte part chez le fournisseur de Swairm. N'y mets ni secret ni contenu de carte.",
      );
      await expect(boite.getByRole('button', { name: 'Envoyer' })).toBeDisabled();
      await boite.getByRole('combobox', { name: 'N', exact: true }).selectOption('2');
      await expect(boite).toContainText('Coût maximal : 1.00 USD');
      await boite
        .getByRole('textbox', { name: 'Question', exact: true })
        .fill(mode === 'refus' ? 'Clé factice : sk-ant-cle-factice-pour-tests' : question);
      await boite.getByRole('button', { name: 'Envoyer' }).click();
      const tableau = boite.getByRole('region', { name: 'Tableau des avis' });
      if (mode === 'ok') {
        await expect(tableau.locator('tbody th')).toHaveText([
          '2. Faut-il livrer maintenant ?',
          '1. Faut-il vérifier les tests ?',
        ]);
        await expect(tableau.getByText(question, { exact: true })).toBeVisible();
        await expect(tableau.locator('tbody td:last-child')).toHaveText(['partage', 'unanime']);
        await expect(tableau).toContainText('Coût total : 0.08 USD');
        await boite.getByRole('button', { name: 'Fermer', exact: true }).click();
        const liste = page.getByRole('region', { name: 'Demandes d’avis' }).getByRole('list');
        await expect(liste.getByRole('listitem')).toHaveCount(1);
        await liste.getByRole('button', { name: /Faut-il vérifier les tests/ }).click();
        const archive = page.getByRole('dialog', { name: 'Avis archivés' });
        await expect(archive.locator('tbody th').first()).toHaveText(
          '2. Faut-il livrer maintenant ?',
        );
        await expect(archive).toContainText('opus — ok');
      } else {
        await expect(tableau.getByRole('status')).toHaveText(
          mode === 'refus' ? 'Question refusée : ressemble à une clé API' : 'Aucun avis valide',
        );
        if (mode === 'refus') {
          const archives = join(dossier, 'avis');
          expect(existsSync(archives) ? readdirSync(archives) : []).toEqual([]);
          expect(existsSync(journal)).toBe(false);
        } else {
          await expect(tableau.getByRole('columnheader', { name: /— echec$/ })).toHaveCount(2);
        }
      }
    } finally {
      await contexte.close();
    }
  });
}

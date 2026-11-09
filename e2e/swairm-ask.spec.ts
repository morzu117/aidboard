import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { node } from './helpers.js';

const cli = join(import.meta.dirname, '../dist/cli/aid.js');
const fixtures = join(import.meta.dirname, '../test/fixtures');
const question = '1. Faut-il vérifier les tests ?\n2. Faut-il livrer maintenant ?';

// Un daemon par mode : le faux CLI lit son mode dans son environnement au lancement.
for (const [indice, mode] of ['ok', 'refus', 'aucun'].entries()) {
  test(`demande d’avis sur le faux swairm : ${mode}`, async ({ browser }) => {
    const dossier = realpathSync(mkdtempSync(join(tmpdir(), 'aid-e2e-ask-')));
    const port = Number(process.env.AID_E2E_PORT ?? 4871) + 20 + indice;
    cpSync(join(fixtures, 'fake-swairm.sh'), join(dossier, 'fake-swairm.sh'));
    cpSync(join(fixtures, 'swairm'), join(dossier, 'swairm'), { recursive: true });
    // Étendre seulement la copie locale : l'ordre reçu est unanime puis partagé.
    const resultat = JSON.parse(readFileSync(join(dossier, 'swairm/ask-ok.json'), 'utf8'));
    resultat.question = question;
    resultat.sous_questions.push({ n: 2, texte: 'Faut-il livrer maintenant ?' });
    resultat.avis[0].reponses.push({ n: 2, verdict: 'oui', justification: 'Oui.' });
    resultat.avis.push({
      ...resultat.avis[0],
      i: 2,
      modele_demande: 'opus',
      modele_servi: 'opus',
      reponses: [
        resultat.avis[0].reponses[0],
        { n: 2, verdict: 'non', justification: 'Attendre.' },
      ],
    });
    resultat.accord = [
      { n: 1, accord: 'unanime', verdict: 'oui', compte: { oui: 2 } },
      { n: 2, accord: 'partage', verdict: null, compte: { oui: 1, non: 1 } },
    ];
    resultat.cout_total_usd = 0.08;
    for (const nom of ['ask-ok.json', `show-${resultat.id}.json`]) {
      writeFileSync(join(dossier, 'swairm', nom), JSON.stringify(resultat));
    }
    writeFileSync(
      join(dossier, 'swairm/asks.json'),
      JSON.stringify({
        format: 'swairm-asks/1',
        demandes: [
          { id: resultat.id, genere_a: resultat.genere_a, question, n: 2, accord: resultat.accord },
        ],
        erreurs: [],
      }),
    );
    writeFileSync(
      join(dossier, 'config.yaml'),
      `port: ${port}\nswairm:\n  bin: ${join(dossier, 'fake-swairm.sh')}\nagents:\n  transport: pty\n`,
      { mode: 0o600 },
    );
    const env = {
      ...process.env,
      AID_HOME: dossier,
      AID_NO_BROWSER: '1',
      SHELL: '/bin/sh',
      PATH: `${join(fixtures, 'bin')}${delimiter}${process.env.PATH}`,
      FAKE_SWAIRM_ASK_MODE: mode,
      FAKE_SWAIRM_ASK_COPY: join(dossier, 'question'),
    };
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
      await boite.getByRole('textbox', { name: 'Question', exact: true }).fill(question);
      await boite.getByRole('button', { name: 'Envoyer' }).click();
      const tableau = boite.getByRole('region', { name: 'Tableau des avis' });
      if (mode === 'ok') {
        await expect(tableau.locator('tbody th')).toHaveText([
          '2. Faut-il livrer maintenant ?',
          '1. Faut-il vérifier les tests ?',
        ]);
        expect(readFileSync(join(dossier, 'question'), 'utf8')).toBe(question);
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
      }
    } finally {
      await contexte.close();
      try {
        execFileSync(process.execPath, [cli, 'stop', '--force'], { env, timeout: 30_000 });
      } finally {
        rmSync(dossier, { recursive: true, force: true });
      }
    }
  });
}

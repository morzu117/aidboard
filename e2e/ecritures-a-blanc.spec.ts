import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { node } from './helpers.js';

// Daemon isolé : ni les fixtures partagées ni la boîte des autres épreuves ne changent.
test('trois aperçus, deux refus et aucune écriture sur le faux swarph', async ({ browser }) => {
  const dossier = realpathSync(mkdtempSync(join(tmpdir(), 'aid-e2e-a-blanc-')));
  const fixtures = join(import.meta.dirname, '../test/fixtures');
  const cli = join(import.meta.dirname, '../dist/cli/aid.js');
  const port = Number(process.env.AID_E2E_PORT ?? 4871) + 1;
  const origine = `http://127.0.0.1:${port}`;
  const board = join(dossier, 'board');
  cpSync(join(fixtures, 'board'), board, { recursive: true });
  // La carte existante garde son corps et son fil ; seule cette copie a un rappel ouvert.
  cpSync(join(board, 'obligations-list-3531.json'), join(board, 'obligations-list-101.json'));
  const sidecar = join(dossier, 'swarph_state', 'peer-a', 'mesh-sidecar');
  mkdirSync(sidecar, { recursive: true });
  writeFileSync(
    join(sidecar, 'inbox.log'),
    JSON.stringify({
      id: 3505,
      thread_id: '00000000-0000-4000-8000-000000003505',
      from_node: 'peer-b',
      to_node: 'peer-a',
      kind: 'question',
      content: 'Une réponse à blanc ?',
      created_at: '2026-11-09T10:00:00Z',
      read_at: null,
      priority: 'normal',
    }) + '\n',
  );
  const swarph = join(dossier, 'swarph');
  // D327 : les réglages du faux CLI sont exportés après le filtrage du daemon.
  writeFileSync(
    swarph,
    `#!/bin/sh\nexport FAKE_SWARPH_BOARD='${board}'\nexport FAKE_SWARPH_LOG='${join(dossier, 'swarph.log')}'\nexec '${join(fixtures, 'fake-swarph.sh')}' "$@"\n`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(dossier, 'config.yaml'),
    `port: ${port}\nagents:\n  transport: pty\nmesh:\n  bin: ${swarph}\n  cell: peer-a\n  gateway: https://example.com\n  stateRoot: ${join(dossier, 'swarph_state')}\n  tailscale:\n    manage: false\n    bin: ${join(fixtures, 'fake-tailscale.sh')}\n`,
    { mode: 0o600 },
  );
  const env = {
    ...process.env,
    AID_HOME: dossier,
    AID_NO_BROWSER: '1',
    SHELL: '/bin/sh',
    PATH: `${join(fixtures, 'bin')}${delimiter}${process.env.PATH}`,
    FAKE_SWARPH_LOG: join(dossier, 'swarph.log'),
    FAKE_TAILSCALE_STATEFILE: join(dossier, 'tailscale.state'),
  };
  const contexte = await browser.newContext();
  execFileSync(process.execPath, [cli], { env, timeout: 40_000 });
  try {
    const { token } = JSON.parse(readFileSync(join(dossier, 'daemon.json'), 'utf8')) as {
      token: string;
    };
    const page = await contexte.newPage();
    await page.goto(`${origine}/?token=${token}`);
    await expect(node(page, '1-1.barre.marque')).toBeVisible();
    await page.goto(`${origine}/reglages#mesh`);
    await node(page, 'reglages.mesh.connecter').click();
    await expect(node(page, 'reglages.mesh.etat')).toContainText('monitor actif');
    await page.goto(`${origine}/board/cartes/101`);
    await page.getByRole('button', { name: 'Écrire une note (à blanc)' }).click();
    const boite = page.getByRole('dialog');
    const apercu = boite.getByRole('region', { name: 'Aperçu' });
    const voir = boite.getByRole('button', { name: "Voir l'aperçu" });
    const sansEnvoi = async () => {
      await expect(boite.getByRole('button', { name: /envoyer/i })).toHaveCount(
        await apercu.count(),
      );
    };
    await sansEnvoi();
    await boite.getByLabel('Texte', { exact: true }).fill('Note synthétique à blanc.');
    await voir.click();
    await expect(apercu).toContainText('Note fyi sur la carte #101');
    await expect(apercu.locator('pre').nth(0)).toHaveText(
      'swarph board cards say 101 --content-file FICHIER --kind fyi --as peer-a',
    );
    await expect(apercu.locator('pre').nth(1)).toHaveText('Note synthétique à blanc.');
    await expect(apercu).toContainText("À blanc : rien n'est parti.");
    await expect(apercu).toContainText("Tu as l'obligation #81 ouverte sur cette carte.");
    await expect(apercu).toContainText('Cette note ne la clôt pas');
    await expect(apercu).not.toContainText("l'obligation #82");
    await sansEnvoi();
    await boite.getByRole('button', { name: 'Fermer', exact: true }).click();

    await page.goto(`${origine}/boite`);
    await page.getByRole('button', { name: 'Répondre (à blanc)' }).click();
    await expect(boite.getByLabel('Pair', { exact: true })).toHaveValue('peer-b');
    await expect(boite.getByLabel('Kind')).toHaveValue('answer');
    await boite.getByLabel('Texte', { exact: true }).fill('Réponse synthétique.');
    await voir.click();
    await expect(apercu.locator('pre').first()).toHaveText(
      'swarph mesh send peer-b --kind answer --content-file FICHIER --thread 00000000-0000-4000-8000-000000003505 --as peer-a',
    );
    await sansEnvoi();
    await boite.getByRole('button', { name: 'Fermer', exact: true }).click();

    await page.goto(`${origine}/swarph`);
    await page.getByRole('button', { name: 'Écrire au mesh (à blanc)' }).click();
    await boite.getByLabel('Destination').selectOption({ label: 'Canal' });
    await boite.getByLabel('Canal', { exact: true }).fill('canal-test');
    await boite.getByLabel('Texte', { exact: true }).fill('Post synthétique.');
    await voir.click();
    await expect(apercu.locator('pre').first()).toHaveText(
      'swarph channel post canal-test --kind fyi --content-file FICHIER --as peer-a',
    );
    await sansEnvoi();
    await boite.getByLabel('Texte', { exact: true }).fill('Post synthétique corrigé.');
    await expect(boite.getByRole('textbox', { name: 'Texte', exact: true })).toHaveAccessibleName(
      'Texte',
    );
    await expect(apercu).toHaveCount(0);
    await voir.click();
    await expect(apercu.locator('pre').nth(1)).toHaveText('Post synthétique corrigé.');

    await boite.getByLabel('Destination').selectOption({ label: 'DM' });
    await boite.getByLabel('Pair', { exact: true }).fill('peer-b');
    const fausseCle = 'sk-ant-' + 'X'.repeat(48);
    await boite.getByLabel('Texte', { exact: true }).fill(fausseCle);
    await voir.click();
    await expect(boite.getByRole('alert')).toContainText(/secret|clé/i);
    await expect(boite.getByRole('alert')).not.toContainText(fausseCle);
    await expect(apercu).toHaveCount(0);
    await sansEnvoi();
    await boite.getByLabel('Texte', { exact: true }).fill('Texte sans secret.');
    await boite.getByLabel('Pair', { exact: true }).fill('Pair invalide');
    await voir.click();
    await expect(boite.getByRole('alert')).toContainText(/pair/i);
    await expect(apercu).toHaveCount(0);
    await sansEnvoi();

    const journal = readFileSync(env.FAKE_SWARPH_LOG, 'utf8');
    expect(journal).toContain('board obligations list --card 101 --json --as peer-a');
    expect(journal).not.toMatch(/\b(?:cards say|mesh send|channel post)\b/);
    for (const ligne of journal.trim().split('\n')) {
      expect(ligne).toMatch(
        /^(?:--version|monitor (?:status|start) |board (?:projects list|cards (?:list|show|graph|thread)|obligations list) )/,
      );
    }
    // La copie est couverte par les tests web, sans dépendance au presse-papiers headless.
  } finally {
    try {
      await contexte.close();
    } finally {
      execFileSync(process.execPath, [cli, 'stop', '--force'], { env, timeout: 30_000 });
    }
  }
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { fermerContextes, node, openApp } from './helpers.js';

const erreur = (valeur: string | null) => {
  const fichier = join(process.env.AID_E2E_HOME!, 'board-error');
  if (valeur) writeFileSync(fichier, `${valeur}\n`);
  else rmSync(fichier, { force: true });
};

test.beforeEach(() => erreur(null));
test.afterEach(() => erreur(null));
test.afterAll(({ browser }) => fermerContextes(browser));

test('depuis le Board : quatre onglets, recherche et navigation mémoire en texte brut', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext());
  await node(page, '1-1.barre.nav-board').click();
  await expect(node(page, 'onglets-swarph')).toBeVisible();
  await node(page, 'onglets-swarph.cells').click();
  await expect(page).toHaveURL(/\/swarph\/cells$/);
  await expect(node(page, 'cells.tableau')).toContainText('Version déclarée');
  await expect(node(page, 'cells.tableau').locator('tbody tr').first()).toContainText('toi');
  await node(page, 'onglets-swarph.federation').click();
  await node(page, 'federation.requete').fill('lecture test');
  await expect(page).toHaveURL(/\/swarph\/federation$/);
  await expect(node(page, 'federation.resultat-0')).toHaveCount(0);
  await node(page, 'federation.chercher').click();
  await expect(page).toHaveURL(/\?q=lecture\+test$/);
  await expect(node(page, 'federation.resultat-0')).toContainText('exemple.lecture');
  await node(page, 'onglets-swarph.memoire').click();
  await node(page, 'memoire-swarph.lister').click();
  await expect(node(page, 'memoire-swarph.liste')).toContainText('Page sans tag');
  await page.getByLabel('Filtre', { exact: true }).selectOption('tag');
  await node(page, 'memoire-swarph.tag').fill('test');
  await expect(node(page, 'memoire-swarph.liste')).toContainText('Page sans tag');
  await node(page, 'memoire-swarph.lister').click();
  await node(page, 'memoire-swarph.liste')
    .getByRole('button', { name: 'page-test', exact: true })
    .click();
  await expect(page).toHaveURL(/\/swarph\/memoire\?page=page-test$/);
  const corps = node(page, 'memoire-swarph.corps');
  await expect(corps).toContainText('<img src=x onerror=alert(1)>');
  await expect(corps).toContainText('https://exemple.invalid');
  await expect(page.locator('img')).toHaveCount(0);
  await expect(page.locator('a[href*="exemple.invalid"]')).toHaveCount(0);
  await node(page, 'memoire-swarph.liens')
    .getByRole('button', { name: 'page-liee', exact: true })
    .click();
  await expect(page).toHaveURL(/\?page=page-liee$/);
  await expect(corps).toHaveText('Texte de peer-b.');
  await node(page, 'onglets-swarph.reglages').click();
  await expect(page).toHaveURL(/\/swarph\/reglages$/);
  await expect(node(page, 'reglages-swarph.droits')).toContainText('direct');
  await node(page, 'onglets-swarph.board').click();
  await expect(page).toHaveURL(/\/board$/);
});

test('Cells et Réglages injoignables, Memory refusée', async ({ browser }) => {
  const page = await openApp(await browser.newContext());
  await node(page, '1-1.barre.nav-board').click();
  erreur('unreachable');
  for (const [onglet, ecran] of [
    ['cells', 'cells'],
    ['reglages', 'reglages-swarph'],
  ]) {
    await node(page, `onglets-swarph.${onglet}`).click();
    await node(page, `${ecran}.recharger`).click();
    await expect(node(page, `${ecran}.message`)).toContainText('Le gateway ne répond pas');
  }
  erreur('forbidden');
  await node(page, 'onglets-swarph.memoire').click();
  await page.getByLabel('Filtre', { exact: true }).selectOption('tag');
  await node(page, 'memoire-swarph.tag').fill('test');
  await node(page, 'memoire-swarph.lister').click();
  await node(page, 'memoire-swarph.liste.recharger').click();
  await expect(node(page, 'memoire-swarph.liste.etat')).toContainText(
    "Ta cellule n'a pas, ou plus, accès à cette mémoire.",
  );
});

test('Federation sans index local sur un daemon isolé', async ({ browser }) => {
  // Le mode codegraph est une variable de démarrage : ne pas modifier le daemon partagé.
  const port = Number(process.env.AID_E2E_PORT ?? 4871) + 1;
  const dossier = realpathSync(mkdtempSync(join(tmpdir(), 'aid-e2e-sans-index-')));
  const fixtures = join(import.meta.dirname, '../test/fixtures');
  const cli = join(import.meta.dirname, '../dist/cli/aid.js');
  writeFileSync(
    join(dossier, 'config.yaml'),
    `port: ${port}\nagents:\n  transport: pty\nmesh:\n  bin: ${join(fixtures, 'fake-swarph.sh')}\n  cell: peer-a\n  gateway: https://example.com\n  stateRoot: ${join(dossier, 'swarph_state')}\n  tailscale:\n    manage: false\n    bin: ${join(fixtures, 'fake-tailscale.sh')}\n`,
    { mode: 0o600 },
  );
  const env = {
    ...process.env,
    AID_HOME: dossier,
    AID_NO_BROWSER: '1',
    SHELL: '/bin/sh',
    PATH: `${join(fixtures, 'bin')}${delimiter}${process.env.PATH}`,
    FAKE_SWARPH_BOARD: join(fixtures, 'board'),
    FAKE_SWARPH_CODEGRAPH_MODE: 'no-index',
    FAKE_SWARPH_LOG: join(dossier, 'swarph.log'),
    FAKE_TAILSCALE_STATEFILE: join(dossier, 'tailscale.state'),
  };
  execFileSync(process.execPath, [cli], { env, timeout: 40_000 });
  try {
    const { token } = JSON.parse(readFileSync(join(dossier, 'daemon.json'), 'utf8')) as {
      token: string;
    };
    const page = await (await browser.newContext()).newPage();
    await page.goto(`http://127.0.0.1:${port}/?token=${token}`);
    await node(page, '1-1.barre.nav-board').click();
    await node(page, 'onglets-swarph.federation').click();
    await node(page, 'federation.requete').fill('lecture test');
    await node(page, 'federation.chercher').click();
    await expect(node(page, 'federation.etat')).toContainText(
      "Aucun index local. Ce n'est pas un résultat négatif : rien n'a été cherché.",
    );
    await expect(node(page, 'federation.etat')).toHaveAttribute('data-kind', 'no-index');
  } finally {
    execFileSync(process.execPath, [cli, 'stop', '--force'], { env, timeout: 30_000 });
  }
});

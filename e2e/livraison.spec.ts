import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { createTopic, fermerContextes, newRepo, node, registerWorkspace } from './helpers.js';

test.afterAll(({ browser }) => fermerContextes(browser));

// Chantier 27 : l'écran Livraison de bout en bout. Ce spec lance son daemon : agents en `stream` devant les
// faux agents structurés (test/fixtures/bin-stream), faux gh par AID_GH_BIN (jamais le vrai gh), journal des
// merges dans FAKE_GH_MERGE_LOG. Le faux gh rend la tête de la PR = HEAD du worktree. AID_HOME temporaire,
// aucun réseau.
const PORT = Number(
  process.env.AID_E2E_STREAM_PORT ?? Number(process.env.AID_E2E_PORT ?? 4871) + 1,
);
const CLI = join(import.meta.dirname, '../dist/cli/aid.js');
const FIXTURES = join(import.meta.dirname, '../test/fixtures');

let home = '';
let page: Page;
let topicId = '';
let worktree = '';
let reviewSlug = '';

function demarrer(): { url: string; token: string } {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'aid-e2e-livraison-')));
  writeFileSync(join(home, 'config.yaml'), `port: ${PORT}\nagents:\n  transport: stream\n`, {
    mode: 0o600,
  });
  const env = {
    ...process.env,
    AID_HOME: home,
    AID_NO_BROWSER: '1',
    SHELL: '/bin/sh',
    PATH: `${join(FIXTURES, 'bin-stream')}${delimiter}${process.env.PATH}`,
    AID_GH_BIN: join(FIXTURES, 'fake-gh.sh'),
    FAKE_GH_MERGE_LOG: join(home, 'gh-merge.log'),
  };
  execFileSync(process.execPath, [CLI], { env, timeout: 40_000 });
  const info = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as { token: string };
  return { url: `http://127.0.0.1:${PORT}`, token: info.token };
}

let base = '';

async function ouvrir(browser: Browser): Promise<Page> {
  const { url, token } = demarrer();
  base = url;
  const context = await browser.newContext();
  await context.addInitScript(() => localStorage.setItem('aid-e2e', '1'));
  const p = await context.newPage();
  await p.goto(`${url}/?token=${token}`);
  await expect(node(p, '1-1.barre.marque')).toBeVisible();
  return p;
}

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: worktree, encoding: 'utf8' }).trim();

/** Un commit dans le worktree du sujet, poussé : la tête de la PR (faux gh) le suit. */
function commit(fichier: string, contenu: string): string {
  writeFileSync(join(worktree, fichier), contenu);
  git('add', fichier);
  git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'commit', '-qm', fichier);
  git('push', '-q', 'origin', 'HEAD');
  return git('rev-parse', 'HEAD');
}

async function ecrireRevue(text: string, mode?: 'append'): Promise<void> {
  const status = await page.evaluate(
    async ({ slug, text, mode }) =>
      (
        await fetch(`/api/memory/pages/${slug}`, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(mode ? { text, mode } : { text }),
        })
      ).status,
    { slug: reviewSlug, text, mode },
  );
  expect([200, 201]).toContain(status);
}

const journalMerge = () => {
  try {
    return readFileSync(join(home, 'gh-merge.log'), 'utf8');
  } catch {
    return '';
  }
};

const court = (sha: string) => sha.slice(0, 7);
const livraison = () => page.goto(`${base}/sujets/${topicId}/livraison`);

test.describe.serial('écran Livraison (chantier 27)', () => {
  let tete1 = '';
  let tete2 = '';

  test.beforeAll(async ({ browser }) => {
    page = await ouvrir(browser);
    await registerWorkspace(page, newRepo('depot-livraison'));
    topicId = await createTopic(page, 'Livraison e2e');
    const s = (await page.evaluate(async () =>
      (await fetch('/api/state', { credentials: 'same-origin' })).json(),
    )) as {
      topics: Array<{ id: string; worktree: string; slug: string }>;
      workspaces: Array<{ name: string; namespace: string | null }>;
    };
    const t = s.topics.find((x) => x.id === topicId)!;
    worktree = t.worktree;
    reviewSlug = `${s.workspaces[0]!.namespace ?? s.workspaces[0]!.name}/review/${t.slug}`;
    tete1 = commit('livraison.txt', 'un\n');
  });

  test.afterAll(async () => {
    await page?.context().close();
    if (!home) return;
    execFileSync(process.execPath, [CLI, 'stop', '--force'], {
      env: { ...process.env, AID_HOME: home },
      timeout: 30_000,
    });
  });

  test('sans PR : la tête locale, le changement, la PR à créer, le merge bloqué', async () => {
    await livraison();
    await expect(node(page, 'livraison.titre')).toHaveText(`Peut-on livrer ${court(tete1)} ?`);
    await expect(node(page, 'livraison.contexte')).toContainText('· 1 fichier · +1 −0');
    await expect(node(page, 'livraison.fichiers.fichier-0')).toContainText('livraison.txt');
    await expect(node(page, 'livraison.trace.pr')).toHaveText('PR vers main○ à créer');
    await expect(node(page, 'livraison.autoriser.blocage')).toHaveText(
      'Bloqué : aucune PR ouverte.',
    );
    await expect(node(page, 'livraison.autoriser')).toBeDisabled();
  });

  test('Ouvrir la PR, puis elle est relue : sans revue, le merge est permis et le dira', async () => {
    await node(page, 'livraison.trace.ouvrir-pr').click();
    await expect(node(page, 'livraison.ouvrir-pr.titre')).toHaveValue('Livraison e2e');
    await node(page, 'livraison.ouvrir-pr.valider').click();
    await expect(node(page, 'livraison.ouvrir-pr')).toHaveCount(0);
    await expect(node(page, 'livraison.trace.pr')).toHaveText('PR vers main● #7 ouverte');
    await expect(node(page, 'livraison.relire')).toHaveText('Relire la PR');
    await expect(node(page, 'livraison.titre')).toHaveText(`Peut-on livrer ${court(tete1)} ?`);
    await expect(node(page, 'livraison.tuile-revue.valeur')).toHaveText('Aucune revue');
    await expect(node(page, 'livraison.autoriser')).toBeEnabled();
    await expect(node(page, 'livraison.autoriser.blocage')).toHaveCount(0);
  });

  test('une page review avec commit: la tête est à jour ; un commit de plus la rend obsolète', async () => {
    await ecrireRevue(
      `---\ncommit: ${tete1}\n---\n## Revue de ${court(tete1)}\n\nPremier avis.\n\nExaminé : livraison.txt.\n`,
    );
    await node(page, 'livraison.relire').click();
    await expect(node(page, 'livraison.tuile-revue.valeur')).toHaveText('À jour');
    await expect(node(page, 'livraison.avis.texte')).toHaveText('Premier avis.');

    tete2 = commit('livraison.txt', 'un\ndeux\n');
    await node(page, 'livraison.relire').click();
    await expect(node(page, 'livraison.titre')).toHaveText(`Peut-on livrer ${court(tete2)} ?`);
    await expect(node(page, 'livraison.tuile-revue.valeur')).toHaveText('Obsolète');
    await expect(node(page, 'livraison.tuile-revue.note')).toHaveText(
      `Porte sur ${court(tete1)} · 1 commit de retard`,
    );
    await expect(node(page, 'livraison.avis.obsolete')).toHaveText(
      `Revue obsolète. L’avis porte sur ${court(tete1)}, la tête est maintenant ${court(tete2)}.`,
    );
    await expect(node(page, 'livraison.autoriser.blocage')).toHaveText(
      'Bloqué : la revue ne porte pas sur cette tête.',
    );
    await expect(node(page, 'livraison.autoriser')).toBeDisabled();
  });

  test('la revue complétée en append sur la nouvelle tête : à jour, et c’est son avis qui se lit', async () => {
    await ecrireRevue(
      `---\ncommit: ${tete2}\n---\n## Revue de ${court(tete2)}\n\nSecond avis.\n\nNon examiné : la recette.\n`,
      'append',
    );
    await node(page, 'livraison.relire').click();
    await expect(node(page, 'livraison.tuile-revue.valeur')).toHaveText('À jour');
    await expect(node(page, 'livraison.avis.texte')).toHaveText('Second avis.');
    await expect(node(page, 'livraison.avis.non-examine')).toHaveText('Non examiné : la recette.');
    await expect(node(page, 'livraison.avis.examine')).toHaveCount(0);
    await expect(node(page, 'livraison.autoriser')).toBeEnabled();
  });

  test('l’onglet Livraison du panneau résume et ouvre la vue ; Livrer sur l’accueil y mène', async () => {
    await page.goto(`${base}/sujets/${topicId}`);
    await page.getByRole('tab', { name: 'Livraison' }).click();
    await expect(node(page, '1-3.panneau.livraison.autorisation')).toHaveText(
      `Aucune · elle ciblera ${court(tete2)}`,
    );
    await expect(node(page, '1-3.panneau.livraison.controles')).toHaveText('Aucun');
    await node(page, '1-3.panneau.livraison.ouvrir').click();
    await page.waitForURL(`**/sujets/${topicId}/livraison`);

    await page.goto(`${base}/`);
    const livrer = page.locator('[data-action="sujet.livrer"]');
    await expect(livrer).toHaveCount(1);
    await livrer.click();
    await page.waitForURL(`**/sujets/${topicId}/livraison`);
  });

  test('Autoriser le merge : la confirmation nomme la tête, et le merge part sur elle', async () => {
    await expect(node(page, 'livraison.autoriser')).toHaveText(
      `Autoriser le merge de ${court(tete2)}`,
    );
    await expect(node(page, 'livraison.autoriser')).toBeEnabled();
    await node(page, 'livraison.autoriser').click();
    await expect(
      page.getByRole('dialog', { name: `Fusionner ${court(tete2)} dans main ?` }),
    ).toBeVisible();
    await expect(node(page, 'livraison.confirmer-merge.citations')).toHaveCount(0);
    await node(page, 'livraison.confirmer-merge.valider').click();
    await expect(node(page, 'livraison.tuile-autorisation.valeur')).toHaveText('Fusionnée');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const journal = journalMerge();
    expect(journal).toContain('--merge');
    expect(journal).toContain(`--match-head-commit ${tete2}`);
    await expect(node(page, 'livraison.autoriser')).toHaveCount(0);
    await expect(node(page, 'livraison.trace.pr')).toHaveText('PR vers main● fusionnée');
  });
});

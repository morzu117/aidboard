import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { newRepo, node, registerWorkspace, state } from './helpers.js';
import { fermerContextes } from './helpers.js';

test.afterAll(({ browser }) => fermerContextes(browser));

// Chantier 28 (28.11) : Nouveau sujet, la Boîte par nature et Reprendre, de bout en bout. Le daemon commun des e2e
// joue claude en PTY : ce spec lance le sien, en `stream`, devant les faux claude et codex structurés
// (test/fixtures/bin-stream). AID_HOME temporaire, jamais le vrai claude ni le vrai codex, aucun réseau.
const PORT = Number(
  process.env.AID_E2E_STREAM_PORT ?? Number(process.env.AID_E2E_PORT ?? 4871) + 1,
);
const CLI = join(import.meta.dirname, '../dist/cli/aid.js');
const FIXTURES = join(import.meta.dirname, '../test/fixtures');
const DN = '1-3.conversation.composer';
const TITRE = 'Plan demandé';
const VIVANT = /^(starting|working|needs_input|idle)$/;

let home = '';
let base = '';
let page: Page;
let topicId = '';

function demarrer(): { url: string; token: string } {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'aid-e2e-boite-')));
  writeFileSync(join(home, 'config.yaml'), `port: ${PORT}\nagents:\n  transport: stream\n`, {
    mode: 0o600,
  });
  const env = {
    ...process.env,
    AID_HOME: home,
    AID_NO_BROWSER: '1',
    SHELL: '/bin/sh',
    PATH: `${join(FIXTURES, 'bin-stream')}${delimiter}${process.env.PATH}`,
  };
  execFileSync(process.execPath, [CLI], { env, timeout: 40_000 });
  const info = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as { token: string };
  return { url: `http://127.0.0.1:${PORT}`, token: info.token };
}

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

const champ = () => node(page, `${DN}.champ`);
// un fil par agent du sujet : seul celui de l'onglet ouvert est visible
const fil = () => page.locator('[data-node="1-3.conversation.fil"]:visible');
const compteurBarre = () => page.locator('[data-node$=".barre.nav-boite.compte"]');
const groupe = (nature: string) => node(page, `1-2.liste.groupe-${nature}`);

interface Etat {
  topics: Array<{ id: string; worktree: string }>;
  runs: Array<{ id: string; topicId: string }>;
  agents: Array<{ id: string; kind: string; status: string; runId: string }>;
}

/** Les agents conversationnels du sujet, dans l'ordre de création. */
async function agentsDuSujet(): Promise<Etat['agents']> {
  const s = (await state(page)) as unknown as Etat;
  const runs = s.runs.filter((r) => r.topicId === topicId).map((r) => r.id);
  return s.agents.filter((a) => runs.includes(a.runId) && a.kind !== 'shell');
}

async function ouvrirSujet(): Promise<void> {
  await page.goto(`${base}/sujets/${topicId}`);
  await expect(champ()).toBeVisible();
}

/** Arrête l'agent ouvert du sujet, par le bouton et sa confirmation. */
async function arreter(): Promise<void> {
  await ouvrirSujet();
  await node(page, '1-3.terminaux.arreter').click();
  await node(page, '1-3.terminaux.arreter').click();
  await expect.poll(async () => (await agentsDuSujet()).at(-1)?.status).not.toMatch(VIVANT);
}

/** Reprendre depuis la ligne du sujet à l'accueil : le dialogue s'ouvre sans quitter l'accueil. */
async function reprendreDepuisAccueil(): Promise<void> {
  await page.goto(`${base}/`);
  // la ligne montre la branche du sujet
  const ligne = page
    .locator('[data-node^="1-1.table.ligne-"]', { hasText: 'feat/plan-demande' })
    .first();
  await ligne.locator('[data-action="sujet.reprendre"]').click();
  await expect(page.getByRole('dialog', { name: 'claude est arrêté.' })).toBeVisible();
}

test.describe.serial('Boîte, Nouveau sujet et Reprendre (chantier 28)', () => {
  test.beforeAll(async ({ browser }) => {
    page = await ouvrir(browser);
    await registerWorkspace(page, newRepo('depot-boite'));
  });

  test.afterAll(async () => {
    await page?.context().close();
    if (!home) return;
    execFileSync(process.execPath, [CLI, 'stop', '--force'], {
      env: { ...process.env, AID_HOME: home },
      timeout: 30_000,
    });
  });

  test('D141, D145 : Nouveau sujet avec claude, le message de plan part au fil', async () => {
    await page.getByLabel('Titre').fill(TITRE);
    await expect(node(page, 'nouveau-sujet.travail.agent')).toHaveValue('claude');
    await page.getByRole('button', { name: 'Créer et demander un plan' }).click();
    await page.waitForURL(/\/sujets\/tp_[^?]+\?agent=/, { timeout: 40_000 });
    topicId = page.url().split('/sujets/')[1]!.split('?')[0]!;
    await expect(node(page, '1-3.entete.titre')).toHaveText(TITRE);
    await expect(fil()).toContainText(`echo: `);
    await expect(fil()).toContainText(TITRE);
  });

  test('D145 : « aucun agent » crée le sujet sans lancer d’agent', async () => {
    await node(page, '1-3.barre.nouveau-sujet').click();
    await page.getByLabel('Titre').fill('Sans agent');
    await node(page, 'nouveau-sujet.travail.agent').selectOption('aucun');
    await page.getByRole('button', { name: 'Créer le sujet' }).click();
    await page.waitForURL(/\/sujets\/tp_/, { timeout: 40_000 });
    await expect(node(page, '1-3.entete.titre')).toHaveText('Sans agent');
    await expect(node(page, '1-3.vide.lancer-claude')).toBeVisible();
  });

  test('D136, D140 : la Boîte range par nature ; une décision compte dans la barre', async () => {
    // le tour du plan est fini : à relire
    await page.goto(`${base}/boite`);
    await expect(node(page, '1-2.filtres.nature-relire.compte')).toHaveText('1');
    await expect(groupe('relire').locator('[data-node$=".agent"]')).toHaveText('claude');
    await expect(compteurBarre()).toHaveCount(0);

    await ouvrirSujet();
    await champ().fill('demande permission');
    await champ().press('Enter');
    await page.goto(`${base}/boite`);
    await expect(node(page, '1-2.filtres.nature-decision.compte')).toHaveText('1');
    await expect(compteurBarre()).toHaveText('1');
    await expect(node(page, '1-2.filtres.nature-relire.compte')).toHaveText('0');

    // Voir le contexte ouvre l'agent dans son sujet
    await groupe('decision').locator('[data-action="sujet.contexte"]').click();
    await page.waitForURL(new RegExp(`/sujets/${topicId}\\?agent=`));
    await page.goto(`${base}/boite`);

    // répondre depuis la Boîte : le tour se termine, l'agent repasse à relire
    await groupe('decision').locator('[data-action="demande.repondre"]').first().click();
    await expect(node(page, '1-2.filtres.nature-relire.compte')).toHaveText('1');
    await expect(node(page, '1-2.filtres.nature-decision.compte')).toHaveText('0');
    await expect(compteurBarre()).toHaveCount(0);
  });

  test('D146, D148, D150 : un agent arrêté, « Reprendre » à l’accueil reprend sa session', async () => {
    await arreter();
    await reprendreDepuisAccueil();
    const option = node(page, 'reprendre.option-reprendre').locator('input');
    await expect(option).toBeChecked();
    await node(page, 'reprendre.valider').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(async () => (await agentsDuSujet()).at(-1)?.status).toMatch(VIVANT);
    expect((await agentsDuSujet()).length).toBe(1);
  });

  test('D149 : Transférer à codex, avec l’alerte des fichiers non commités', async () => {
    await arreter();
    const s = (await state(page)) as unknown as Etat;
    const worktree = s.topics.find((t) => t.id === topicId)!.worktree;
    writeFileSync(join(worktree, 'brouillon.txt'), 'pas encore commité\n');

    await reprendreDepuisAccueil();
    await node(page, 'reprendre.option-transferer').click();
    await expect(node(page, 'reprendre.transfert.agent')).toHaveValue('codex');
    await expect(node(page, 'reprendre.transfert.non-commites')).toBeVisible();
    await expect(node(page, 'reprendre.valider')).toHaveText('Transférer à codex');
    await node(page, 'reprendre.valider').click();

    await page.waitForURL(new RegExp(`/sujets/${topicId}\\?agent=`), { timeout: 40_000 });
    const agents = await agentsDuSujet();
    expect(agents.map((a) => a.kind)).toEqual(['claude', 'codex']);
    expect(page.url()).toContain(`agent=${agents[1]!.id}`);
    await expect(fil()).toContainText('feat/plan-demande');
  });
});

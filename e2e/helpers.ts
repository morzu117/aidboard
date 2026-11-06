import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { makeOriginAndClone } from '../test/helpers/git.js';

export const url = () => process.env.AID_E2E_URL!;
export const node = (page: Page, id: string) => page.locator(`[data-node="${id}"]`);

interface ApiState {
  topics: Array<{ id: string; branch: string }>;
  runs: Array<{ id: string; topicId: string }>;
  agents: Array<{ id: string; status: string; pid: number; runId: string }>;
}

/** Ferme les contextes ouverts par les épreuves d'un fichier (`test.afterAll`) : sinon chaque page reste connectée et
 * relit l'état à chaque événement jusqu'à la fin de la suite — 27 pages vivantes à la fin, la charge qui faisait
 * dépasser `launchShell`. */
export async function fermerContextes(browser: Browser): Promise<void> {
  await Promise.all(browser.contexts().map((c) => c.close()));
}

/** Ouvre le lien d'ouverture (échangé contre le cookie) et expose les terminaux au test. */
export async function openApp(context: BrowserContext): Promise<Page> {
  await context.addInitScript(() => localStorage.setItem('aid-e2e', '1'));
  const page = await context.newPage();
  await page.goto(`${url()}/?token=${process.env.AID_E2E_TOKEN}`);
  await expect(node(page, '1-1.barre.marque')).toBeVisible();
  return page;
}

export function newRepo(name: string, opts: { codegraph?: boolean; local?: boolean } = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'aid-e2e-repo-')));
  return makeOriginAndClone(dir, { name, ...opts }).clone;
}

/** Ouvre « Nouveau projet » depuis le bouton Nouveau sujet de la barre. */
export async function ouvrirNouveauProjet(page: Page): Promise<void> {
  await page.locator('[data-node$=".barre.nouveau-sujet"]').click();
  // un premier dépôt ouvre directement « Nouveau projet » ; ensuite il faut passer par « Ajouter un projet »
  const ajouter = page.getByRole('button', { name: 'Ajouter un projet…' });
  // chantier 28 : l'écran Nouveau sujet se rend après le clic ; isVisible() n'attend pas, on attend l'un des deux
  const dossier = page.getByLabel('Aller au dossier');
  await expect(dossier.or(ajouter).first()).toBeVisible();
  if (!(await dossier.isVisible())) await ajouter.click();
}

/** Enregistre un dépôt par le dialogue « Nouveau projet ». `warning` : l'avertissement attendu, puis « Continuer ». */
export async function registerWorkspace(page: Page, path: string, warning?: RegExp): Promise<void> {
  await ouvrirNouveauProjet(page);
  // le dossier se choisit dans l'explorateur ; « Aller au dossier » évite de descendre arbre par arbre
  await page.getByLabel('Aller au dossier').fill(path);
  await page.getByLabel('Aller au dossier').press('Enter');
  await expect(page.getByLabel('Aller au dossier')).toHaveValue(path);
  await page.getByRole('button', { name: 'Choisir ce dossier' }).click();
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  if (warning) {
    await expect(page.getByRole('dialog', { name: 'Projet enregistré' })).toContainText(warning);
    await page.getByRole('button', { name: 'Continuer' }).click();
  }
  // chantier 28 (D141) : le sujet se crée sur l'écran Nouveau sujet
  await expect(node(page, 'nouveau-sujet.titre')).toBeVisible();
}

/** Crée un sujet depuis l'écran Nouveau sujet ouvert et attend la page du sujet. */
export async function createTopic(page: Page, title: string): Promise<string> {
  await page.getByLabel('Titre').fill(title);
  // chantier 28 (D145) : sans agent, le sujet se crée comme avant ; les specs lancent le leur
  await node(page, 'nouveau-sujet.travail.agent').selectOption('aucun');
  await page.getByRole('button', { name: 'Créer le sujet' }).click();
  await page.waitForURL(/\/sujets\/tp_/, { timeout: 40_000 });
  await expect(node(page, '1-3.entete.titre')).toHaveText(title);
  return page.url().split('/sujets/')[1]!;
}

export async function state(page: Page): Promise<ApiState> {
  return page.evaluate(async () =>
    (await fetch('/api/state', { credentials: 'same-origin' })).json(),
  );
}

export async function terminalText(page: Page, agentId: string): Promise<string> {
  return page.evaluate((id) => {
    type Buf = {
      length: number;
      getLine(i: number): { translateToString(trim: boolean): string } | undefined;
    };
    const terms = (
      window as unknown as { __aidTerminals?: Record<string, { buffer: { active: Buf } }> }
    ).__aidTerminals;
    const b = terms?.[id]?.buffer.active;
    if (!b) return '';
    return Array.from(
      { length: b.length },
      (_, i) => b.getLine(i)?.translateToString(true) ?? '',
    ).join('\n');
  }, agentId);
}

/** Lance un shell depuis l'état vide du sujet et rend l'id de l'agent. */
export async function launchShell(page: Page): Promise<string> {
  await node(page, '1-3.vide.shell').click();
  await expect(node(page, '1-3.terminaux.sortie')).toBeVisible();
  await expect.poll(async () => (await state(page)).agents.length).toBeGreaterThan(0);
  return (await state(page)).agents.at(-1)!.id;
}

/** Lance le faux « claude » (test/fixtures/bin, devant le PATH du daemon) et rend l'id de l'agent. */
export async function launchClaude(page: Page): Promise<string> {
  await node(page, '1-3.vide.lancer-claude').click();
  await expect(node(page, '1-3.terminaux.sortie')).toBeVisible();
  await expect.poll(async () => (await state(page)).agents.length).toBeGreaterThan(0);
  return (await state(page)).agents.at(-1)!.id;
}

export async function typeInTerminal(page: Page, text: string): Promise<void> {
  await page.locator('.xterm-helper-textarea').first().focus();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

/**
 * Chantier 25 (D104) : la barre gauche range par état par défaut. Les épreuves des groupes du chantier 15 la
 * remettent en `groupes` avant de commencer, et en `etat` à la fin, par l'API et sous le cookie d'une page ouverte.
 */
export function rangerLaBarre(rangement: 'etat' | 'groupes') {
  return async ({ browser }: { browser: Browser }) => {
    const page = await openApp(await browser.newContext());
    const status = await page.evaluate(
      async (r) =>
        (
          await fetch('/api/nav/prefs', {
            method: 'PATCH',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ rangement: r }),
          })
        ).status,
      rangement,
    );
    expect(status).toBe(200);
    await page.context().close();
  };
}

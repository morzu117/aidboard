import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { makeOriginAndClone } from '../test/helpers/git.js';

export const url = () => process.env.AID_E2E_URL!;
export const node = (page: Page, id: string) => page.locator(`[data-node="${id}"]`);

interface ApiState {
  topics: Array<{ id: string }>;
  agents: Array<{ id: string; status: string; pid: number }>;
}

/** Ouvre le lien d'ouverture (échangé contre le cookie) et expose les terminaux au test. */
export async function openApp(context: BrowserContext): Promise<Page> {
  await context.addInitScript(() => localStorage.setItem('aid-e2e', '1'));
  const page = await context.newPage();
  await page.goto(`${url()}/?token=${process.env.AID_E2E_TOKEN}`);
  await expect(node(page, '1-1.barre.marque')).toBeVisible();
  return page;
}

export function newRepo(name: string, opts: { codegraph?: boolean } = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'aid-e2e-repo-')));
  return makeOriginAndClone(dir, { name, ...opts }).clone;
}

/** Enregistre un dépôt par le dialogue « Nouveau workspace ». */
export async function registerWorkspace(page: Page, path: string): Promise<void> {
  await node(page, '1-1.barre.nouveau-sujet').click();
  // un premier dépôt ouvre directement « Nouveau workspace » ; ensuite il faut passer par « Ajouter un workspace »
  const ajouter = page.getByRole('button', { name: 'Ajouter un workspace…' });
  if (await ajouter.isVisible({ timeout: 2000 }).catch(() => false)) await ajouter.click();
  // le dossier se choisit dans l'explorateur ; « Aller au dossier » évite de descendre arbre par arbre
  await page.getByLabel('Aller au dossier').fill(path);
  await page.getByLabel('Aller au dossier').press('Enter');
  await expect(page.getByLabel('Aller au dossier')).toHaveValue(path);
  await page.getByRole('button', { name: 'Choisir ce dossier' }).click();
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByRole('dialog', { name: 'Nouveau sujet' })).toBeVisible();
}

/** Crée un sujet dans le dialogue ouvert et attend la page du sujet. */
export async function createTopic(page: Page, title: string): Promise<string> {
  await page.getByLabel('Titre').fill(title);
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

export async function typeInTerminal(page: Page, text: string): Promise<void> {
  await page.locator('.xterm-helper-textarea').first().focus();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

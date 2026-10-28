import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  createTopic,
  newRepo,
  node,
  openApp,
  registerWorkspace,
  state,
  terminalText,
  typeInTerminal,
} from './helpers.js';

// 14.6 : la cell Swairm de bout en bout sur le faux CLI (global-setup : `swairm.bin` =
// test/fixtures/fake-swairm.sh). Jamais le vrai swairm, aucun réseau, aucun board lu.

const home = () => process.env.AID_E2E_HOME!;
// un journal du faux CLI n'existe qu'après son premier appel
const lines = (file: string) => {
  try {
    return readFileSync(join(home(), file), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
interface Cell {
  id: string;
  kind: string;
  cwd: string;
  command: string[];
}
// cells déjà passées dans ce daemon (rejeu de l'épreuve) : ignorées, on ne compte que les nôtres
const anciennes = new Set<string>();
const cells = async (page: Page) =>
  (await state(page)).agents.filter(
    (a) => (a as unknown as Cell).kind === 'swairm-cell' && !anciennes.has(a.id),
  ) as unknown as Cell[];
// le terminal visible est le dernier monté : les onglets d'agents arrêtés restent dans le DOM, masqués
const typeInLast = async (page: Page, text: string) => {
  await page.locator('.xterm-helper-textarea').last().focus();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
};
const status = async (page: Page, id: string) =>
  (await state(page)).agents.find((a) => a.id === id)?.status;

test('ouvrir la cell Swairm, reconnecter, redimensionner, refuser un doublon, arrêter puis rouvrir', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext({ viewport: { width: 1400, height: 800 } }));
  for (const a of await cells(page)) anciennes.add(a.id);
  const appelsAvant = lines('swairm.log').filter((l) => l === 'cell').length;
  await registerWorkspace(page, newRepo('depot-swairm'));
  const topicId = await createTopic(page, 'Cell Swairm');

  // le bouton est proposé par la configuration seule : ni board, ni mesh requis
  await node(page, '1-3.vide.lancer-swairm-cell').click();
  await expect(node(page, '1-3.terminaux.sortie')).toBeVisible();
  await expect.poll(async () => (await cells(page)).length).toBe(1);
  const first = (await cells(page))[0]!.id;
  await expect(node(page, '1-3.terminaux.onglet-1.type')).toHaveText('swairm-cell');

  // la commande est « <bin> cell » sans --project (D42), dans le worktree du sujet
  const worktree = (
    (await state(page)).topics.find((t) => t.id === topicId) as unknown as { worktree: string }
  ).worktree;
  const cell = (await cells(page))[0]!;
  expect(cell.command).toHaveLength(2);
  expect(cell.command[0]).toMatch(/fake-swairm\.sh$/);
  expect(cell.command[1]).toBe('cell');
  expect(cell.cwd).toBe(worktree);
  await expect.poll(() => terminalText(page, first)).toContain('FAKE_SWAIRM');
  // un retour à la ligne de l'émulateur ne coupe pas l'assertion
  const banner = (await terminalText(page, first)).replace(/\n/g, '');
  expect(banner).toContain('argc=1 args=cell');
  expect(banner).toContain('TERM=xterm-256color');
  // aucun jeton GitHub, aucune adresse mesh ajoutée à cette session (D47)
  expect(banner).toContain('GH_TOKEN=absent');
  expect(banner).toContain('GITHUB_TOKEN=absent');
  expect(banner).toContain('MESH_GATEWAY_URL=absent');
  expect(banner).toContain('SWARPH_SELF=absent');
  await expect.poll(() => terminalText(page, first)).toContain('swairm>');
  expect(lines('swairm.log').filter((l) => l === 'cell')).toHaveLength(appelsAvant + 1);

  // saisie interactive ordinaire : commandes de lecture factices du faux CLI
  await typeInTerminal(page, 'help');
  await expect.poll(() => terminalText(page, first)).toContain('help status inbox events quit');
  await typeInTerminal(page, 'status');
  await expect.poll(() => terminalText(page, first)).toContain('status: ready');
  await expect.poll(() => lines('swairm-input.log')).toEqual(['help', 'status']);

  // recharger la page : même agent, même terminal, historique rejoué
  await page.reload();
  await expect(node(page, '1-3.terminaux.sortie')).toBeVisible();
  await expect
    .poll(() => terminalText(page, first), { timeout: 15_000 })
    .toContain('status: ready');
  expect((await cells(page)).map((a) => a.id)).toEqual([first]);
  expect(await status(page, first)).not.toMatch(/^(done|error|stopped)$/);

  // une nouvelle vue (autre contexte) retrouve le même agent sans le relancer
  const autre = await openApp(await browser.newContext({ viewport: { width: 1400, height: 800 } }));
  await autre.goto(`${process.env.AID_E2E_URL}/sujets/${topicId}`);
  await expect(node(autre, '1-3.terminaux.sortie')).toBeVisible();
  await expect.poll(() => terminalText(autre, first), { timeout: 15_000 }).toContain('help status');
  expect((await cells(autre)).map((a) => a.id)).toEqual([first]);
  await autre.context().close();

  // resize : le terminal change de taille, le pied l'affiche, l'écran survit
  const size = () =>
    page.evaluate((id) => {
      const t = (
        window as unknown as { __aidTerminals: Record<string, { cols: number; rows: number }> }
      ).__aidTerminals[id]!;
      return { cols: t.cols, rows: t.rows };
    }, first);
  const avant = await size();
  // review D, finding 7 : reste ≥ 1280 px (Q6 tranchée, D.1) — sous ce seuil la colonne centrale
  // passe en pleine largeur et le terminal s'élargirait au lieu de rétrécir.
  await page.setViewportSize({ width: 1290, height: 700 });
  await expect.poll(async () => (await size()).cols).toBeLessThan(avant.cols);
  const apres = await size();
  await expect(node(page, '1-3.terminaux.pied.taille')).toContainText(
    `${apres.cols}×${apres.rows}`,
  );
  await typeInTerminal(page, 'inbox');
  await expect.poll(() => terminalText(page, first)).toContain('inbox: empty');
  await expect.poll(() => lines('swairm-input.log')).toEqual(['help', 'status', 'inbox']);
  expect(await terminalText(page, first)).toContain('status: ready');

  // second lancement refusé : 409 lisible depuis le menu « + Agent », aucun second agent
  await node(page, '1-3.terminaux.ajouter-agent').click();
  await page.locator('[data-action="agent.lancer"][data-agent="swairm-cell"]').click();
  await expect(page.getByRole('alert').filter({ hasText: 'déjà ouverte' })).toContainText(first);
  expect(await cells(page)).toHaveLength(1);

  // y compris depuis un autre sujet : la garde est celle du daemon
  await page.goto(process.env.AID_E2E_URL!);
  await registerWorkspace(page, newRepo('depot-swairm-bis'));
  const second = await createTopic(page, 'Cell Swairm doublon');
  await node(page, '1-3.vide.lancer-swairm-cell').click();
  await expect(page.getByRole('alert').filter({ hasText: 'déjà ouverte' })).toContainText(first);
  expect(await cells(page)).toHaveLength(1);
  expect(second).not.toBe(topicId);

  // arrêt : la garde est libérée, la cell se rouvre dans le premier sujet
  await page.goto(`${process.env.AID_E2E_URL}/sujets/${topicId}`);
  await expect(node(page, '1-3.terminaux.arreter')).toHaveText('Arrêter');
  await node(page, '1-3.terminaux.arreter').click();
  await expect(node(page, '1-3.terminaux.arreter')).toHaveText('Confirmer l’arrêt');
  await node(page, '1-3.terminaux.arreter').click();
  await expect.poll(() => status(page, first), { timeout: 20_000 }).toMatch(/^(done|stopped)$/);
  await expect(node(page, '1-3.terminaux.arreter')).toHaveText('Fermer');

  await node(page, '1-3.terminaux.ajouter-agent').click();
  await page.locator('[data-action="agent.lancer"][data-agent="swairm-cell"]').click();
  await expect.poll(async () => (await cells(page)).length).toBe(2);
  const reopened = (await cells(page)).at(-1)!.id;
  expect(reopened).not.toBe(first);
  await expect.poll(() => terminalText(page, reopened)).toContain('swairm>');
  await expect(node(page, '1-3.terminaux.onglet-2.type')).toHaveText('swairm-cell');
  expect(lines('swairm.log').filter((l) => l === 'cell')).toHaveLength(appelsAvant + 2);

  // la nouvelle session ne reçoit que ce que l'opérateur tape : jamais de résumé injecté
  await typeInLast(page, 'events');
  await expect.poll(() => terminalText(page, reopened)).toContain('events: empty');
  await expect.poll(() => lines('swairm-input.log')).toEqual(['events']);

  // rendre le daemon propre pour les épreuves suivantes (reopened est l'agent actif)
  await node(page, '1-3.terminaux.arreter').click();
  await node(page, '1-3.terminaux.arreter').click();
  await expect.poll(() => status(page, reopened), { timeout: 20_000 }).toMatch(/^(done|stopped)$/);
});

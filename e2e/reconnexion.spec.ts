import { expect, test } from '@playwright/test';
import {
  createTopic,
  launchShell,
  newRepo,
  node,
  openApp,
  registerWorkspace,
  state,
  terminalText,
  typeInTerminal,
} from './helpers.js';

test('fermer puis rouvrir le navigateur : les agents tournent, l’historique est intact, la sortie produite entre-temps est là', async ({
  browser,
}) => {
  const first = await browser.newContext();
  const page = await openApp(first);
  await registerWorkspace(page, newRepo('depot-reco'));
  const topicId = await createTopic(page, 'Reconnexion');
  const agent = await launchShell(page);
  await typeInTerminal(page, 'echo avant; (sleep 2; echo pendant) &');
  await expect.poll(() => terminalText(page, agent)).toContain('avant');
  const pid = (await state(page)).agents[0]!.pid;

  await first.close();
  await new Promise((r) => setTimeout(r, 3500));

  const page2 = await openApp(await browser.newContext());
  await page2.goto(`${process.env.AID_E2E_URL}/sujets/${topicId}`);
  await expect(node(page2, '1-3.terminaux.sortie')).toBeVisible();
  await expect.poll(() => terminalText(page2, agent), { timeout: 15_000 }).toContain('avant');
  await expect.poll(() => terminalText(page2, agent)).toContain('pendant');
  expect(() => process.kill(pid, 0)).not.toThrow();
  expect((await state(page2)).agents[0]!.status).toBe('starting');
});

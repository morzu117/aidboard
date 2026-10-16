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

test('trois sujets tournent en parallèle, chacun avec son terminal dans son worktree', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext());
  await registerWorkspace(page, newRepo('depot-trois'));

  const sujets: Array<{ id: string; agent: string }> = [];
  for (const n of [1, 2, 3]) {
    if (n > 1) {
      await page.goto(process.env.AID_E2E_URL!);
      await node(page, '1-1.barre.nouveau-sujet').click();
    }
    const id = await createTopic(page, `Sujet numéro ${n}`);
    const agent = await launchShell(page);
    await typeInTerminal(page, `echo "marqueur-${n}-$(basename $(pwd))"`);
    await expect
      .poll(() => terminalText(page, agent), { timeout: 15_000 })
      .toContain(`marqueur-${n}-sujet-numero-${n}`);
    sujets.push({ id, agent });
  }

  const s = await state(page);
  const mine = s.topics.filter((t) =>
    /^sujet-numero-\d$/.test((t as unknown as { slug: string }).slug),
  );
  expect(mine).toHaveLength(3);
  expect(new Set(mine.map((t) => (t as unknown as { workspaceId: string }).workspaceId)).size).toBe(
    1,
  );
  expect(new Set(sujets.map((x) => x.agent)).size).toBe(3);
  for (const x of sujets) expect(s.agents.find((a) => a.id === x.agent)?.status).toBe('starting');

  await page.goto(process.env.AID_E2E_URL!);
  await expect(node(page, '1-1.entete.resume.sujets')).toHaveText(String(s.topics.length));
  await expect(page.getByText('Lancé · statut non suivi').first()).toBeVisible();
});

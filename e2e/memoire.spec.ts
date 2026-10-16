import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createTopic, newRepo, node, openApp, registerWorkspace } from './helpers.js';

const CLI = join(import.meta.dirname, '../dist/cli/aid.js');

interface RawState {
  topics: Array<{ id: string; slug: string; workspaceId: string }>;
  workspaces: Array<{ id: string; name: string; namespace: string | null }>;
}

function memPut(slug: string, text: string): void {
  execFileSync(process.execPath, [CLI, 'mem', 'put', slug], {
    env: { ...process.env, AID_HOME: process.env.AID_E2E_HOME },
    input: text,
    timeout: 10_000,
  });
}

test('le panneau Mémoire affiche une page écrite par le CLI, sans recharger', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext());
  await registerWorkspace(page, newRepo('depot-memoire'));
  const topicId = await createTopic(page, 'Sujet mémoire');

  await expect(node(page, '1-3.memoire.onglet-plan')).toBeVisible();
  await expect(node(page, '1-3.memoire.absente')).toBeVisible();

  const full: RawState = await page.evaluate(async () =>
    (await fetch('/api/state', { credentials: 'same-origin' })).json(),
  );
  const topic = full.topics.find((t) => t.id === topicId)!;
  const workspace = full.workspaces.find((w) => w.id === topic.workspaceId)!;
  const namespace = workspace.namespace ?? workspace.name;
  memPut(`${namespace}/plan/${topic.slug}`, 'Le plan du sujet mémoire.');

  await expect
    .poll(async () => node(page, '1-3.memoire.page.corps').textContent(), { timeout: 15_000 })
    .toBe('Le plan du sujet mémoire.');
  await expect(node(page, '1-3.memoire.page.meta')).toContainText('révision 1');

  // écrite par aid mem append : la page existante ne se remplace pas, elle se complète
  memPut(`${namespace}/dev-handoff/${topic.slug}`, '## Dev 1\n\nfait.');
  await node(page, '1-3.memoire.onglet-dev-handoff').click();
  await expect
    .poll(async () => node(page, '1-3.memoire.page.corps').textContent(), { timeout: 15_000 })
    .toBe('## Dev 1\n\nfait.');
});

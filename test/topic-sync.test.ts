import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { gitLiveInfo } from '../src/daemon/git/inspect.js';
import type { StateSnapshot } from '../src/shared/state.js';
import { startTestDaemon, waitFor, type TestDaemon } from './helpers/daemon.js';
import { commitFile, makeOriginAndClone, sh } from './helpers/git.js';

let t: TestDaemon;
afterEach(async () => {
  await t?.d.stop();
});

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'aid-ts-')));
const FAKE = join(import.meta.dirname, 'fixtures/fake-codegraph.sh');

async function setup() {
  t = await startTestDaemon(undefined, { codegraphBin: FAKE });
  const repo = makeOriginAndClone(tmp());
  const ws = (
    await t.d.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: t.headers,
      payload: { path: repo.clone },
    })
  ).json<{ id: string; worktreesDir: string }>();
  return { ...repo, ws };
}

const finished = (actionId: string) =>
  waitFor(
    () =>
      t.store.since(null).find((e) => e.type === 'action.finished' && e.data.actionId === actionId),
    15_000,
    `fin de ${actionId}`,
  );

const state = async () =>
  (await t.d.app.inject({ url: '/api/state', headers: t.headers })).json<StateSnapshot>();

const syncAction = (topicId: string, action: string) =>
  t.d.app.inject({
    method: 'POST',
    url: `/api/topics/${topicId}/actions/${action}`,
    headers: t.headers,
  });

test('topic.sync : rebase sans conflit, avance/retard lus en direct avant et après', async () => {
  const { origin, clone, ws } = await setup();
  const created = (
    await t.d.app.inject({
      method: 'POST',
      url: '/api/topics',
      headers: t.headers,
      payload: { workspaceId: ws.id, title: 'Sync', type: 'feat' },
    })
  ).json<{ actionId: string; slug: string; branch: string }>();
  await finished(created.actionId);
  const wt = join(ws.worktreesDir, created.slug);
  const topicId = (await state()).topics[0]?.id;
  if (!topicId) throw new Error('sujet manquant');

  // origin avance pendant que le sujet travaille : le topic devient « en retard ».
  commitFile(clone, 'depuis-origin.md', 'plus tard\n');
  sh(clone, 'push', '-q', 'origin', 'main');

  // et le sujet avance de son côté : « en avance » aussi, sur l'ancien point de base.
  commitFile(wt, 'depuis-le-sujet.md', 'en cours\n');

  const before = await gitLiveInfo(wt, 'main');
  expect(before).toEqual({
    aheadBehind: { ahead: 1, behind: 1 },
    rebaseInProgress: false,
    onTopicBranch: true,
    headBranch: created.branch,
  });

  const sync = await t.d.app.inject({
    method: 'POST',
    url: `/api/topics/${topicId}/actions/topic.sync`,
    headers: t.headers,
  });
  expect(sync.statusCode).toBe(202);
  const { actionId: syncActionId } = sync.json<{ actionId: string }>();
  const fin = await finished(syncActionId);
  expect(fin.data.outcome).toBe('succeeded');

  const after = await gitLiveInfo(wt, 'main');
  expect(after).toEqual({
    aheadBehind: { ahead: 1, behind: 0 },
    rebaseInProgress: false,
    onTopicBranch: true,
    headBranch: created.branch,
  });
  expect(sh(wt, 'rev-parse', 'origin/main')).toBe(sh(origin, 'rev-parse', 'main'));
  expect(sh(wt, 'log', '-1', '--format=%s')).toBe('ajout depuis-le-sujet.md');

  // Aucune régression sur topic.branch : la branche réelle reste celle attendue après le rebase.
  expect((await state()).topics).toMatchObject([{ branch: created.branch }]);
  expect(sh(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(created.branch);
});

test('topic.sync : ne pousse rien avant la première PR, repousse (force-with-lease) une fois l’amont pris', async () => {
  const { origin, clone, ws } = await setup();
  const created = (
    await t.d.app.inject({
      method: 'POST',
      url: '/api/topics',
      headers: t.headers,
      payload: { workspaceId: ws.id, title: 'Push après rebase', type: 'feat' },
    })
  ).json<{ actionId: string; slug: string; branch: string }>();
  await finished(created.actionId);
  const wt = join(ws.worktreesDir, created.slug);
  const topicId = (await state()).topics[0]?.id;
  if (!topicId) throw new Error('sujet manquant');

  commitFile(clone, 'depuis-origin.md', 'plus tard\n');
  sh(clone, 'push', '-q', 'origin', 'main');
  commitFile(wt, 'depuis-le-sujet.md', 'en cours\n');

  // `--no-track` (topic-create.sh) : pas d'amont tant que topic.pr n'a pas poussé une
  // première fois. Rien à synchroniser côté origin, donc le sync ne pousse rien.
  let sync = await syncAction(topicId, 'topic.sync');
  await finished(sync.json<{ actionId: string }>().actionId);
  expect(() => sh(origin, 'rev-parse', created.branch)).toThrow();

  // Simule le premier push de topic.pr (06.6), sans gh : seul topic.sync est sous test ici.
  sh(wt, 'push', '-u', 'origin', created.branch);

  commitFile(clone, 'depuis-origin-2.md', 'encore plus tard\n');
  sh(clone, 'push', '-q', 'origin', 'main');

  sync = await syncAction(topicId, 'topic.sync');
  const fin = await finished(sync.json<{ actionId: string }>().actionId);
  expect(fin.data.outcome).toBe('succeeded');
  expect(sh(origin, 'rev-parse', created.branch)).toBe(sh(wt, 'rev-parse', 'HEAD'));
});

test('topic.sync : worktree manquant, 409', async () => {
  const { ws } = await setup();
  const created = (
    await t.d.app.inject({
      method: 'POST',
      url: '/api/topics',
      headers: t.headers,
      payload: { workspaceId: ws.id, title: 'Draft', type: 'feat' },
    })
  ).json<{ actionId: string }>();
  const topicId = (await state()).topics[0]?.id;
  if (!topicId) throw new Error('sujet manquant');
  const sync = await t.d.app.inject({
    method: 'POST',
    url: `/api/topics/${topicId}/actions/topic.sync`,
    headers: t.headers,
  });
  expect(sync.statusCode).toBe(409);
  await finished(created.actionId);
});

test('topic.sync : conflit détecté (code 2), fichiers listés ; sync-annuler nettoie le worktree', async () => {
  const { clone, ws } = await setup();
  const created = (
    await t.d.app.inject({
      method: 'POST',
      url: '/api/topics',
      headers: t.headers,
      payload: { workspaceId: ws.id, title: 'Conflit', type: 'feat' },
    })
  ).json<{ actionId: string; branch: string; slug: string }>();
  await finished(created.actionId);
  const wt = join(ws.worktreesDir, created.slug);
  const topicId = (await state()).topics[0]?.id;
  if (!topicId) throw new Error('sujet manquant');

  // Même ligne de README.md changée des deux côtés depuis le même point de départ : conflit garanti.
  commitFile(clone, 'README.md', '# origin a changé\n');
  sh(clone, 'push', '-q', 'origin', 'main');
  commitFile(wt, 'README.md', '# le sujet a changé\n');

  const sync = await syncAction(topicId, 'topic.sync');
  const fin = await finished(sync.json<{ actionId: string }>().actionId);
  expect(fin.data).toMatchObject({ outcome: 'needs_human', exitCode: 2 });
  expect(fin.data.result).toMatchObject({ conflict: true, files: ['README.md'] });
  expect((await gitLiveInfo(wt, 'main')).rebaseInProgress).toBe(true);

  const annuler = await syncAction(topicId, 'topic.sync-annuler');
  const finAnnuler = await finished(annuler.json<{ actionId: string }>().actionId);
  expect(finAnnuler.data.outcome).toBe('succeeded');
  expect((await gitLiveInfo(wt, 'main')).rebaseInProgress).toBe(false);
  expect(sh(wt, 'status', '--porcelain')).toBe('');
  expect(sh(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(created.branch);
});

test('topic.sync-continuer : poursuit le rebase une fois le conflit résolu à la main', async () => {
  const { clone, ws } = await setup();
  const created = (
    await t.d.app.inject({
      method: 'POST',
      url: '/api/topics',
      headers: t.headers,
      payload: { workspaceId: ws.id, title: 'Résolution', type: 'feat' },
    })
  ).json<{ actionId: string; branch: string; slug: string }>();
  await finished(created.actionId);
  const wt = join(ws.worktreesDir, created.slug);
  const topicId = (await state()).topics[0]?.id;
  if (!topicId) throw new Error('sujet manquant');

  commitFile(clone, 'README.md', '# origin a changé\n');
  sh(clone, 'push', '-q', 'origin', 'main');
  commitFile(wt, 'README.md', '# le sujet a changé\n');

  const sync = await syncAction(topicId, 'topic.sync');
  await finished(sync.json<{ actionId: string }>().actionId);

  writeFileSync(join(wt, 'README.md'), '# résolu à la main\n');

  const cont = await syncAction(topicId, 'topic.sync-continuer');
  const finCont = await finished(cont.json<{ actionId: string }>().actionId);
  expect(finCont.data.outcome).toBe('succeeded');
  expect((await gitLiveInfo(wt, 'main')).rebaseInProgress).toBe(false);
  expect(sh(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(created.branch);
});

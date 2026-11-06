import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { LivraisonGit } from '../src/shared/git.js';
import type { StateSnapshot } from '../src/shared/state.js';
import { startTestDaemon, waitFor, type TestDaemon } from './helpers/daemon.js';
import { commitFile, makeOriginAndClone, sh } from './helpers/git.js';

// Chantier 27 (D125) : GET /api/topics/:id/git/livraison, sur un vrai dépôt temporaire.

let t: TestDaemon;
afterEach(async () => {
  await t?.d.stop();
});

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'aid-livr-')));
const FAKE_CODEGRAPH = join(import.meta.dirname, 'fixtures/fake-codegraph.sh');

async function sujet() {
  t = await startTestDaemon(undefined, { codegraphBin: FAKE_CODEGRAPH });
  const repo = makeOriginAndClone(tmp());
  const ws = (
    await t.d.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: t.headers,
      payload: { path: repo.clone },
    })
  ).json<{ id: string; worktreesDir: string }>();
  const created = (
    await t.d.app.inject({
      method: 'POST',
      url: '/api/topics',
      headers: t.headers,
      payload: { workspaceId: ws.id, title: 'Livraison', type: 'feat' },
    })
  ).json<{ actionId: string; slug: string }>();
  await waitFor(
    () =>
      t.store
        .since(null)
        .find((e) => e.type === 'action.finished' && e.data.actionId === created.actionId),
    15_000,
    'création du sujet',
  );
  const snap = (
    await t.d.app.inject({ url: '/api/state', headers: t.headers })
  ).json<StateSnapshot>();
  const topicId = snap.topics[0]!.id;
  return { topicId, wt: join(ws.worktreesDir, created.slug), clone: repo.clone };
}

const lire = (topicId: string, revue?: string) =>
  t.d.app.inject({
    url: `/api/topics/${topicId}/git/livraison${revue === undefined ? '' : `?revue=${revue}`}`,
    headers: t.headers,
  });

test('D125 : fichiers, totaux et empreinte du changement origin/<base>...HEAD', async () => {
  const { topicId, wt } = await sujet();
  const base = sh(wt, 'rev-parse', 'HEAD');

  const vide = (await lire(topicId)).json<LivraisonGit>();
  expect(vide).toMatchObject({ head: base, base: 'main', mergeBase: base, files: [] });
  expect(vide.additions).toBe(0);
  expect(vide.revue).toBeUndefined();

  commitFile(wt, 'a.txt', 'un\ndeux\n');
  writeFileSync(join(wt, 'README.md'), '# changé\n');
  sh(wt, 'add', 'README.md');
  sh(wt, 'commit', '-q', '-m', 'readme');
  const r = await lire(topicId);
  expect(r.statusCode).toBe(200);
  const l = r.json<LivraisonGit>();
  expect(l.head).toBe(sh(wt, 'rev-parse', 'HEAD'));
  expect(l.mergeBase).toBe(base);
  expect(l.files).toEqual([
    { path: 'README.md', status: 'M', additions: 1, deletions: 1 },
    { path: 'a.txt', status: 'A', additions: 2, deletions: 0 },
  ]);
  expect([l.additions, l.deletions]).toEqual([3, 1]);
  expect(l.empreinte).toMatch(/^[0-9a-f]{8}$/);
  expect(vide.empreinte).not.toBe(l.empreinte);

  // même changement, autre historique : même empreinte
  sh(wt, 'reset', '-q', '--soft', base);
  sh(wt, 'commit', '-q', '-m', 'les deux en un');
  expect((await lire(topicId)).json<LivraisonGit>().empreinte).toBe(l.empreinte);

  // une suppression
  sh(wt, 'rm', '-q', 'a.txt');
  sh(wt, 'commit', '-q', '-m', 'retrait');
  const s = (await lire(topicId)).json<LivraisonGit>();
  expect(s.files).toEqual([{ path: 'README.md', status: 'M', additions: 1, deletions: 1 }]);
});

test('D125 : la place du commit de la revue par rapport à HEAD', async () => {
  const { topicId, wt } = await sujet();
  commitFile(wt, 'a.txt', 'a\n');
  const relu = sh(wt, 'rev-parse', 'HEAD');

  expect((await lire(topicId, relu)).json<LivraisonGit>().revue).toEqual({
    commit: relu,
    connu: true,
    ancetre: true,
    retard: 0,
  });
  commitFile(wt, 'b.txt', 'b\n');
  commitFile(wt, 'c.txt', 'c\n');
  // abrégé : résolu par git, jamais comparé en texte
  expect((await lire(topicId, relu.slice(0, 7))).json<LivraisonGit>().revue).toEqual({
    commit: relu,
    connu: true,
    ancetre: true,
    retard: 2,
  });

  // réécrit : le commit relu existe encore mais n'est plus dans la branche
  sh(wt, 'reset', '-q', '--hard', 'HEAD~3');
  commitFile(wt, 'z.txt', 'z\n');
  expect((await lire(topicId, relu)).json<LivraisonGit>().revue).toEqual({
    commit: relu,
    connu: true,
    ancetre: false,
    retard: 0,
  });

  expect((await lire(topicId, 'deadbeef')).json<LivraisonGit>().revue).toEqual({
    commit: null,
    connu: false,
    ancetre: false,
    retard: 0,
  });
});

test('D125 : requête invalide, sujet inconnu, worktree absent', async () => {
  const { topicId, wt } = await sujet();
  expect((await lire(topicId, '--all')).statusCode).toBe(422);
  expect((await lire(topicId, 'HEAD')).statusCode).toBe(422);
  expect((await lire('tp_inconnu')).statusCode).toBe(404);
  rmSync(wt, { recursive: true, force: true });
  expect((await lire(topicId)).statusCode).toBe(409);
});

test('D125 : sans origin/<base>, pas de base commune ni de fichiers', async () => {
  const { topicId, wt, clone } = await sujet();
  sh(clone, 'remote', 'set-head', 'origin', '-d');
  sh(clone, 'update-ref', '-d', 'refs/remotes/origin/main');
  const l = (await lire(topicId)).json<LivraisonGit>();
  expect(l).toMatchObject({ head: sh(wt, 'rev-parse', 'HEAD'), mergeBase: null, files: [] });
  expect(l.empreinte).toBeNull();
});

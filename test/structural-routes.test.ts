import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { issueRunToken } from '../src/daemon/security.js';
import { waitFor } from './helpers/daemon.js';
import { makeTopic, setupWorkspace, type Ctx } from './helpers/topics.js';

let c: Ctx;
afterEach(async () => {
  delete process.env.FAKE_CODEGRAPH_FIXTURES;
  await c?.t.d.stop();
});

// `status` du faux binaire ne sait répondre « ready » que si on lui fournit ce fichier canné
// (test/structural-service.test.ts fait de même) — sans lui, la sortie vide est « illisible ».
function fakeStatusReady(): void {
  const dir = mkdtempSync(join(tmpdir(), 'aid-sr-'));
  writeFileSync(
    join(dir, 'status.json'),
    JSON.stringify({ initialized: true, pendingChanges: { added: 0, modified: 0, removed: 0 } }),
  );
  process.env.FAKE_CODEGRAPH_FIXTURES = dir;
}

function runOf(c: Ctx, topicId: string): string {
  return (c.t.db.prepare('SELECT id FROM runs WHERE topic_id = ?').get(topicId) as { id: string })
    .id;
}

function runHeaders(c: Ctx, runId: string) {
  return { host: c.t.headers.host!, authorization: `Bearer ${issueRunToken(c.t.d.auth, runId)}` };
}

const status = (c: Ctx, query: string, headers = c.t.headers) =>
  c.t.d.app.inject({ method: 'GET', url: `/api/structural/status?${query}`, headers });

test('admin lit l’état d’un workspace et d’un sujet, en attente que l’index soit prêt', async () => {
  c = await setupWorkspace({ codegraph: true });
  const topic = await makeTopic(c);
  await waitFor(
    () => (c.t.db.prepare('SELECT index_state s FROM topics').get() as { s: string }).s === 'ready',
    8000,
    'index prêt',
  );
  fakeStatusReady();

  const byTopic = await status(c, `topic=${topic.topicId}`);
  expect(byTopic.statusCode).toBe(200);
  expect(byTopic.json()).toMatchObject({ engine: 'codegraph', state: 'ready' });

  const byWorkspace = await status(c, `workspace=${c.ws.id}`);
  expect(byWorkspace.statusCode).toBe(200);
  expect(byWorkspace.json()).toMatchObject({ engine: 'codegraph' });
});

test('un token de run lit son propre sujet (200) mais pas un autre (403)', async () => {
  c = await setupWorkspace({ codegraph: true });
  const own = await makeTopic(c, 'Le mien');
  const foreign = await makeTopic(c, 'Un autre');
  const headers = runHeaders(c, runOf(c, own.topicId));
  fakeStatusReady();

  expect((await status(c, `topic=${own.topicId}`, headers)).statusCode).toBe(200);
  expect((await status(c, '', headers)).statusCode).toBe(200); // défaut : son propre sujet

  expect((await status(c, `topic=${foreign.topicId}`, headers)).statusCode).toBe(403);
  // son propre workspace reste admis (il résout vers son propre sujet, pas vers un autre) ;
  // un workspace étranger non.
  expect((await status(c, `workspace=${c.ws.id}`, headers)).statusCode).toBe(200);
  expect((await status(c, 'workspace=ws_autre', headers)).statusCode).toBe(403);
});

test('moteur off : 503 avec la raison', async () => {
  c = await setupWorkspace({ engine: 'off' });
  const topic = await makeTopic(c);
  const r = await status(c, `topic=${topic.topicId}`);
  expect(r.statusCode).toBe(503);
  expect(r.json()).toEqual({
    error: 'index_unavailable',
    reason: 'index désactivé (structural.engine = off)',
  });
});

test('paramètre manquant : 400 ; sujet inconnu : 404', async () => {
  c = await setupWorkspace();
  expect((await status(c, '')).statusCode).toBe(400);
  expect((await status(c, 'topic=tp_absent')).statusCode).toBe(404);
});

test('reindex : un token de run reçoit 403, même pour son propre sujet', async () => {
  c = await setupWorkspace({ codegraph: true });
  const topic = await makeTopic(c);
  const headers = runHeaders(c, runOf(c, topic.topicId));
  const r = await c.t.d.app.inject({
    method: 'POST',
    url: `/api/structural/reindex?topic=${topic.topicId}`,
    headers,
  });
  expect(r.statusCode).toBe(403);
});

test('reindex par un admin : repasse en indexing puis ready avec le faux binaire', async () => {
  c = await setupWorkspace();
  const topic = await makeTopic(c);
  expect(c.t.db.prepare('SELECT index_state s FROM topics').get()).toEqual({ s: 'disabled' });

  const r = await c.t.d.app.inject({
    method: 'POST',
    url: `/api/structural/reindex?topic=${topic.topicId}`,
    headers: c.t.headers,
  });
  expect(r.statusCode).toBe(200);
  expect(
    c.t.store
      .since(null)
      .filter((e) => e.type === 'topic.state')
      .at(-1)?.data.indexState,
  ).toBe('indexing');

  await waitFor(
    () => (c.t.db.prepare('SELECT index_state s FROM topics').get() as { s: string }).s === 'ready',
    8000,
    'index prêt',
  );
});

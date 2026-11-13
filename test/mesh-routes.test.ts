import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import type { MeshDm, MeshState } from '../src/shared/model.js';
import type { StateSnapshot } from '../src/shared/state.js';
import { startTestDaemon, type TestDaemon, waitFor } from './helpers/daemon.js';

// 12.4 : /api/mesh, connect/disconnect, « vu », et le champ `mesh` de /api/state. Faux binaires (D40).

const FAKE_SWARPH = join(import.meta.dirname, 'fixtures', 'fake-swarph.sh');
const FAKE_TAILSCALE = join(import.meta.dirname, 'fixtures', 'fake-tailscale.sh');

let t: TestDaemon;
afterEach(async () => {
  await t?.d.stop();
});

const record = (
  id: number,
  kind = 'question',
  at = `2026-10-20T10:00:${String(id % 60).padStart(2, '0')}+02:00`,
) =>
  JSON.stringify({
    id,
    thread_id: `th_${id}`,
    from_node: 'gateway',
    to_node: 'cell-aid',
    kind,
    content: `m${id}`,
    created_at: at,
  });

const get = (url: string) => t.d.app.inject({ url, headers: t.headers });
const post = (url: string) => t.d.app.inject({ method: 'POST', url, headers: t.headers });
const meshApi = async () => (await get('/api/mesh')).json<{ state: MeshState; inbox: MeshDm[] }>();

async function bootWithMesh() {
  const home = mkdtempSync(join(tmpdir(), 'aid-mesh-r-'));
  t = await startTestDaemon(home, {
    config: {
      mesh: {
        ...DEFAULT_CONFIG.mesh,
        bin: FAKE_SWARPH,
        cell: 'cell-aid',
        gateway: 'http://gateway.example.ts.net:8788',
        stateRoot: join(home, 'swarph_state'),
        tailscale: { manage: false, bin: FAKE_TAILSCALE },
      },
    },
  });
  await waitFor(() => t.store.since(null).some((e) => e.type === 'mesh.state'), 5000, 'init');
}

test('mesh désactivé : /api/mesh et ses actions répondent 404, /api/state n’a pas de champ mesh', async () => {
  t = await startTestDaemon();
  for (const r of [
    await get('/api/mesh'),
    await post('/api/mesh/connect'),
    await post('/api/mesh/dm/1/seen'),
    await post('/api/mesh/dm/1/decision'),
  ]) {
    expect(r.statusCode).toBe(404);
    expect(r.json<{ error: string }>().error).toContain('mesh désactivé');
  }
  expect((await get('/api/state')).json<StateSnapshot>().mesh).toBeUndefined();
});

test('connect (202) ⇒ mesh.state connecté ; les DM suivis arrivent dans /api/mesh et /api/state, les plus récents d’abord', async () => {
  await bootWithMesh();
  expect((await meshApi()).state).toMatchObject({
    connected: false,
    monitor: 'stopped',
    cell: 'cell-aid',
  });
  const r = await post('/api/mesh/connect');
  expect(r.statusCode).toBe(202);
  await waitFor(() => t.d.mesh!.current().connected || undefined, 5000, 'connecté');
  const mesh = t.d.mesh!;
  mkdirSync(dirname(mesh.inboxLog), { recursive: true });
  writeFileSync(
    mesh.inboxLog,
    `${record(1, 'fyi', '2026-10-20T10:00:01+02:00')}\n${record(2, 'question', '2026-10-20T10:00:02+02:00')}\n`,
  );
  expect(mesh.tick()).toBe(2);
  const { inbox } = await meshApi();
  expect(inbox.map((d) => d.id)).toEqual([2, 1]);
  expect(inbox[0]).toEqual({
    id: 2,
    threadId: 'th_2',
    from: 'gateway',
    to: 'cell-aid',
    kind: 'question',
    content: 'm2',
    createdAt: '2026-10-20T10:00:02+02:00',
    replyTo: null,
    obligationId: null,
    seenAt: null,
    decidedAt: null,
  });
  const snap = (await get('/api/state')).json<StateSnapshot>();
  expect(snap.mesh?.state.connected).toBe(true);
  expect(snap.mesh?.inbox.map((d) => d.id)).toEqual([2, 1]);

  expect((await post('/api/mesh/disconnect')).statusCode).toBe(202);
  await waitFor(() => !t.d.mesh!.current().connected || undefined, 5000, 'déconnecté');
  expect((await meshApi()).state).toMatchObject({ connected: false, monitor: 'stopped' });
});

test('« vu » : idempotent, local (seen_at), 404 sur un DM inconnu, 400 sur un id invalide', async () => {
  await bootWithMesh();
  t.db
    .prepare(
      "INSERT INTO mesh_inbox (mesh, id, thread_id, from_node, to_node, kind, content, created_at, event_id) VALUES ('principal', 7, NULL, 'a', 'b', 'fyi', 'x', 't1', 'ev')",
    )
    .run();
  const a = await post('/api/mesh/dm/7/seen');
  expect(a.statusCode).toBe(200);
  const { seenAt } = a.json<{ id: number; seenAt: string }>();
  expect(typeof seenAt).toBe('string');
  await new Promise((r) => setTimeout(r, 5));
  expect((await post('/api/mesh/dm/7/seen')).json()).toEqual({ id: 7, seenAt });
  expect((await meshApi()).inbox[0]?.seenAt).toBe(seenAt);
  expect((await post('/api/mesh/dm/8/seen')).statusCode).toBe(404);
  expect((await post('/api/mesh/dm/abc/seen')).statusCode).toBe(400);
  // la marque n'est pas un événement : rien au journal
  expect(t.store.since(null).filter((e) => e.type === 'mesh.dm')).toEqual([]);
});

test('« en faire une décision » (D137) : idempotent, local (decided_at), 404, 400, rien au journal', async () => {
  await bootWithMesh();
  t.db
    .prepare(
      "INSERT INTO mesh_inbox (mesh, id, thread_id, from_node, to_node, kind, content, created_at, event_id) VALUES ('principal', 7, NULL, 'a', 'b', 'question', 'x', 't1', 'ev')",
    )
    .run();
  const a = await post('/api/mesh/dm/7/decision');
  expect(a.statusCode).toBe(200);
  const { decidedAt } = a.json<{ id: number; decidedAt: string }>();
  expect(typeof decidedAt).toBe('string');
  await new Promise((r) => setTimeout(r, 5));
  expect((await post('/api/mesh/dm/7/decision')).json()).toEqual({ id: 7, decidedAt });
  expect((await meshApi()).inbox[0]).toMatchObject({ decidedAt, seenAt: null });
  // « Vu » ensuite le retire de la Boîte, la décision reste notée
  await post('/api/mesh/dm/7/seen');
  expect((await meshApi()).inbox[0]).toMatchObject({ decidedAt });
  expect((await post('/api/mesh/dm/8/decision')).statusCode).toBe(404);
  expect((await post('/api/mesh/dm/abc/decision')).statusCode).toBe(400);
  expect(t.store.since(null).filter((e) => e.type === 'mesh.dm')).toEqual([]);
});

test('la boîte est bornée à 200 entrées', async () => {
  await bootWithMesh();
  const ins = t.db.prepare(
    "INSERT INTO mesh_inbox (mesh, id, from_node, to_node, kind, content, created_at, event_id) VALUES ('principal', ?, 'a', 'b', 'fyi', '', ?, 'ev')",
  );
  for (let i = 1; i <= 205; i++)
    ins.run(
      i,
      `2026-10-20T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}+02:00`,
    );
  const { inbox } = await meshApi();
  expect(inbox).toHaveLength(200);
  expect(inbox[0]?.id).toBe(205);
});

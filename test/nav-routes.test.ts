import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { NavGroup, NavPlacement, NavState } from '../src/shared/model.js';
import { makeOriginAndClone } from './helpers/git.js';
import { type Ctx, makeTopic, setupWorkspace } from './helpers/topics.js';

let c: Ctx;
afterEach(async () => {
  await c?.t.d.stop();
});

const get = () => c.t.d.app.inject({ method: 'GET', url: '/api/nav', headers: c.t.headers });
const post = (url: string, payload: unknown) =>
  c.t.d.app.inject({ method: 'POST', url, headers: c.t.headers, payload: payload as never });
const patch = (url: string, payload: unknown) =>
  c.t.d.app.inject({ method: 'PATCH', url, headers: c.t.headers, payload: payload as never });
const put = (url: string, payload: unknown) =>
  c.t.d.app.inject({ method: 'PUT', url, headers: c.t.headers, payload: payload as never });

test('défauts : un groupe par projet, un sujet par défaut dans le groupe de son projet, idempotent', async () => {
  c = await setupWorkspace();
  const { topicId } = await makeTopic(c);
  const first = (await get()).json<NavState>();
  expect(first.groups).toHaveLength(1);
  expect(first.groups[0]).toMatchObject({ workspaceId: c.ws.id, name: c.ws.name });
  expect(first.placements).toEqual([
    expect.objectContaining({ topicId, groupId: first.groups[0]!.id }),
  ]);
  expect(first.prefs).toEqual({ reduit: false });

  // un second appel ne recrée rien : même groupe, même placement
  const second = (await get()).json<NavState>();
  expect(second.groups).toEqual(first.groups);
  expect(second.placements).toEqual(first.placements);
});

test('un nouveau projet apparaît en bas', async () => {
  c = await setupWorkspace();
  await makeTopic(c);
  const before = (await get()).json<NavState>();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'aid-nav-tc-')));
  const { clone } = makeOriginAndClone(dir, { name: 'second-depot' });
  const r = await c.t.d.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: c.t.headers,
    payload: { path: clone },
  });
  expect(r.statusCode).toBe(201);
  const after = (await get()).json<NavState>();
  expect(after.groups).toHaveLength(before.groups.length + 1);
  const last = after.groups.at(-1)!;
  expect(last.ord).toBeGreaterThan(before.groups[0]!.ord);
  expect(last.workspaceId).toBe(r.json().id);
});

test('POST /api/nav/groups : crée en dernier rang ; PATCH renomme sans toucher le sujet ; erreurs', async () => {
  c = await setupWorkspace();
  const { topicId, branch } = await makeTopic(c);
  const before = (await get()).json<NavState>();
  const created = await post('/api/nav/groups', { name: 'Mes favoris' });
  expect(created.statusCode).toBe(201);
  const group = created.json<NavGroup>();
  expect(group.ord).toBeGreaterThan(before.groups[0]!.ord);
  expect(group.workspaceId).toBeNull();

  const renamed = await patch(`/api/nav/groups/${group.id}`, { name: 'Favoris' });
  expect(renamed.statusCode).toBe(200);
  expect(renamed.json<NavGroup>().name).toBe('Favoris');

  expect((await patch(`/api/nav/groups/${group.id}`, { name: '   ' })).statusCode).toBe(400);
  expect((await patch('/api/nav/groups/ng_nope', { name: 'x' })).statusCode).toBe(404);
  expect((await post('/api/nav/groups', { name: '' })).statusCode).toBe(400);
  expect((await post('/api/nav/groups', { name: '   ' })).statusCode).toBe(400);

  // name non vide après trim, stocké trimé
  const trimmed = await post('/api/nav/groups', { name: '  Espacé  ' });
  expect(trimmed.statusCode).toBe(201);
  expect(trimmed.json<NavGroup>().name).toBe('Espacé');

  // color : hex strict, POST et PATCH
  expect((await post('/api/nav/groups', { name: 'Couleur', color: 'rouge' })).statusCode).toBe(400);
  expect((await post('/api/nav/groups', { name: 'Couleur', color: '#abc' })).statusCode).toBe(400);
  const colored = await post('/api/nav/groups', { name: 'Couleur', color: '#AaBbCc' });
  expect(colored.statusCode).toBe(201);
  expect(colored.json<NavGroup>().color).toBe('#AaBbCc');
  expect((await patch(`/api/nav/groups/${group.id}`, { color: 'not-a-color' })).statusCode).toBe(
    400,
  );
  const recolored = await patch(`/api/nav/groups/${group.id}`, { color: '#112233' });
  expect(recolored.statusCode).toBe(200);
  expect(recolored.json<NavGroup>().color).toBe('#112233');

  // renommer le groupe ne touche jamais la branche du sujet
  const nav = (await get()).json<NavState>();
  const placement = nav.placements.find((p) => p.topicId === topicId)!;
  expect(placement).toBeTruthy();
  const topic = (await c.t.d.app.inject({ url: '/api/state', headers: c.t.headers }))
    .json<{ topics: Array<{ id: string; branch: string }> }>()
    .topics.find((t) => t.id === topicId);
  expect(topic?.branch).toBe(branch);
});

test('changer de groupe met le sujet en dernier rang du groupe cible ; placement/groupe inconnus en 404', async () => {
  c = await setupWorkspace();
  const { topicId: t1 } = await makeTopic(c, 'Premier');
  const { topicId: t2 } = await makeTopic(c, 'Deuxième');
  const cible = (await post('/api/nav/groups', { name: 'Cible' })).json<NavGroup>();

  const moved = await patch(`/api/nav/placements/${t1}`, { groupId: cible.id });
  expect(moved.statusCode).toBe(200);
  expect(moved.json<NavPlacement>()).toMatchObject({ topicId: t1, groupId: cible.id, ord: 0 });

  const movedAgain = await patch(`/api/nav/placements/${t2}`, { groupId: cible.id });
  expect(movedAgain.json<NavPlacement>().ord).toBe(1);

  expect((await patch(`/api/nav/placements/${t1}`, { groupId: 'ng_nope' })).statusCode).toBe(404);
  expect((await patch('/api/nav/placements/tp_nope', { pinned: true })).statusCode).toBe(404);

  const displayed = await patch(`/api/nav/placements/${t1}`, { displayName: 'Mon nom' });
  expect(displayed.json<NavPlacement>().displayName).toBe('Mon nom');
  const cleared = await patch(`/api/nav/placements/${t1}`, { displayName: null });
  expect(cleared.json<NavPlacement>().displayName).toBeNull();
});

test('PUT ordre des groupes et des sujets d’un groupe : jeu complet exigé, sinon 422', async () => {
  c = await setupWorkspace();
  const { topicId: t1 } = await makeTopic(c, 'Un');
  const { topicId: t2 } = await makeTopic(c, 'Deux');
  const base = (await get()).json<NavState>();
  const groupId = base.groups[0]!.id;
  const extra = (await post('/api/nav/groups', { name: 'Extra' })).json<NavGroup>();

  const order = await put('/api/nav/groups/order', { ids: [extra.id, groupId] });
  expect(order.statusCode).toBe(200);
  const afterOrder = order.json<NavState>();
  expect(afterOrder.groups.map((g) => g.id)).toEqual([extra.id, groupId]);

  expect((await put('/api/nav/groups/order', { ids: [groupId] })).statusCode).toBe(422);
  expect(
    (await put('/api/nav/groups/order', { ids: [groupId, extra.id, 'ng_nope'] })).statusCode,
  ).toBe(422);

  const topics = await put(`/api/nav/groups/${groupId}/topics`, { topicIds: [t2, t1] });
  expect(topics.statusCode).toBe(200);
  const afterTopics = topics.json<NavState>();
  const ordered = afterTopics.placements
    .filter((p) => p.groupId === groupId)
    .sort((a, b) => a.ord - b.ord);
  expect(ordered.map((p) => p.topicId)).toEqual([t2, t1]);

  expect((await put(`/api/nav/groups/${groupId}/topics`, { topicIds: [t1] })).statusCode).toBe(422);
  expect((await put('/api/nav/groups/ng_nope/topics', { topicIds: [] })).statusCode).toBe(404);
});

test('PATCH /api/nav/prefs : persiste reduit', async () => {
  c = await setupWorkspace();
  await makeTopic(c);
  expect((await get()).json<NavState>().prefs).toEqual({ reduit: false });
  const r = await patch('/api/nav/prefs', { reduit: true });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({ reduit: true });
  expect((await get()).json<NavState>().prefs).toEqual({ reduit: true });
});

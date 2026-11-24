import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, expect, test, vi } from 'vitest';
import { MemoryMirror } from '../src/daemon/memory/mirror.js';
import { renderMarkdown } from '../src/daemon/memory/store.js';
import { issueRunToken } from '../src/daemon/security.js';
import { seedTopic, startTestDaemon, waitFor, type TestDaemon } from './helpers/daemon.js';

let t: TestDaemon;
afterEach(async () => {
  await t?.d.stop();
});

const runHeaders = (runId: string) => ({
  host: t.headers.host!,
  authorization: `Bearer ${issueRunToken(t.d.auth, runId)}`,
});

const put = (slug: string, body: unknown, headers = t.headers) =>
  t.d.app.inject({
    method: 'PUT',
    url: `/api/memory/pages/${slug}`,
    headers,
    payload: body as never,
  });
const get = (slug: string, headers = t.headers) =>
  t.d.app.inject({ method: 'GET', url: `/api/memory/pages/${slug}`, headers });
const del = (slug: string, headers = t.headers) =>
  t.d.app.inject({ method: 'DELETE', url: `/api/memory/pages/${slug}`, headers });

// Un run dont le workspace a le namespace `a` (son nom) et un agent du rôle donné.
function seedRun(role: string, namespace: string | null = null) {
  seedTopic(t.db);
  t.db.prepare("UPDATE agents SET role = ? WHERE id = 'ag_1'").run(role);
  t.db.prepare("UPDATE workspaces SET namespace = ? WHERE id = 'ws_1'").run(namespace);
}

test('admin : création 201, lecture, mise à jour 200, liste, suppression, 404 ensuite', async () => {
  t = await startTestDaemon();
  const c = await put('aid/plan/alpha', { text: '# Alpha\n\ncorps' });
  expect(c.statusCode).toBe(201);
  expect(c.json()).toEqual({ slug: 'aid/plan/alpha', revision: 1 });
  const r = await get('aid/plan/alpha');
  expect(r.statusCode).toBe(200);
  expect(r.json()).toMatchObject({
    slug: 'aid/plan/alpha',
    title: 'Alpha',
    revision: 1,
    author: 'admin',
  });
  expect((await put('aid/plan/alpha', { text: '## Suite', mode: 'append' })).statusCode).toBe(200);
  expect((await get('aid/plan/alpha')).json().body).toBe('# Alpha\n\ncorps\n\n## Suite');
  await put('aid/review/alpha', { text: 'r' });
  const list = await t.d.app.inject({
    url: '/api/memory/pages?prefix=aid/plan/',
    headers: t.headers,
  });
  expect(list.json()).toEqual({ slugs: ['aid/plan/alpha'] });
  expect((await del('aid/plan/alpha')).statusCode).toBe(200);
  expect((await get('aid/plan/alpha')).statusCode).toBe(404);
  expect((await del('aid/plan/alpha')).statusCode).toBe(404);
});

test('PUT sans mode sur une page existante : 409 avec la révision ; replace exige expectedRevision', async () => {
  t = await startTestDaemon();
  await put('aid/plan/x', { text: 'v1' });
  await put('aid/plan/x', { text: 'v2', mode: 'force' });
  const r = await put('aid/plan/x', { text: 'v3' });
  expect(r.statusCode).toBe(409);
  expect(r.json()).toEqual({ error: 'revision_conflict', revision: 2 });
  expect(
    (await put('aid/plan/x', { text: 'v3', mode: 'replace', expectedRevision: 1 })).statusCode,
  ).toBe(409);
  expect(
    (await put('aid/plan/x', { text: 'v3', mode: 'replace', expectedRevision: 2 })).statusCode,
  ).toBe(200);
  expect((await put('aid/plan/x', { text: 'v4', mode: 'replace' })).statusCode).toBe(400);
  expect((await put('aid/plan/x', { text: 'v4', mode: 'force', extra: 1 })).statusCode).toBe(400);
});

test('slug invalide : 400 qui nomme la règle, en GET comme en PUT', async () => {
  t = await startTestDaemon();
  const r = await get('Plan');
  expect(r.statusCode).toBe(400);
  expect(r.json().error).toContain('segments [a-z0-9._-]');
  expect((await put('aid/Plan', { text: 'x' })).statusCode).toBe(400);
  expect((await put('aid/plan/x', { text: '---\nchaîne\n---\n' })).statusCode).toBe(400);
});

test('token de run : lit tout, écrit dans son namespace, 403 ailleurs', async () => {
  t = await startTestDaemon();
  seedRun('dev');
  const h = runHeaders('run_1');
  await put('autre/plan/x', { text: 'admin' });
  expect((await get('autre/plan/x', h)).statusCode).toBe(200);
  const ok = await put('a/plan/s', { text: '## Plan' }, h);
  expect(ok.statusCode).toBe(201);
  expect((await get('a/plan/s', h)).json().author).toBe('run:run_1');
  const no = await put('autre/plan/x', { text: 'pirate', mode: 'force' }, h);
  expect(no.statusCode).toBe(403);
  expect(no.json()).toEqual({ error: 'forbidden', namespace: 'autre', allowed: 'a' });
  expect((await del('autre/plan/x', h)).statusCode).toBe(403);
  expect((await get('autre/plan/x')).json().body).toBe('admin');
  const search = await t.d.app.inject({ url: '/api/memory/search?q=admin', headers: h });
  expect(search.statusCode).toBe(200);
  expect(search.json()).toMatchObject({ mode: 'fts', hits: [{ slug: 'autre/plan/x' }] });
});

test('le namespace du workspace prime sur son nom pour un token de run', async () => {
  t = await startTestDaemon();
  seedRun('dev', 'projet');
  const h = runHeaders('run_1');
  expect((await put('projet/plan/s', { text: 'x' }, h)).statusCode).toBe(201);
  expect((await put('a/plan/s', { text: 'x' }, h)).statusCode).toBe(403);
});

test('lesson/ : seul un agent du rôle retro y écrit ; token d’un run inconnu : 403', async () => {
  t = await startTestDaemon();
  seedRun('dev');
  expect((await put('lesson/git/x', { text: 'l' }, runHeaders('run_1'))).statusCode).toBe(403);
  t.db.prepare("UPDATE agents SET role = 'retro' WHERE id = 'ag_1'").run();
  expect((await put('lesson/git/x', { text: 'l' }, runHeaders('run_1'))).statusCode).toBe(201);
  expect((await put('a/plan/x', { text: 'l' }, runHeaders('run_absent'))).statusCode).toBe(403);
});

test('reindex, export, import et health : admin seulement', async () => {
  t = await startTestDaemon();
  seedRun('retro');
  const h = runHeaders('run_1');
  for (const url of ['/api/memory/reindex', '/api/memory/export', '/api/memory/import']) {
    const r = await t.d.app.inject({ method: 'POST', url, headers: h, payload: { dir: '/x' } });
    expect(r.statusCode, url).toBe(403);
  }
  expect((await t.d.app.inject({ url: '/api/memory/health', headers: h })).statusCode).toBe(403);
  await put('aid/plan/x', {
    text: '---\nclose_le: 2026-01-01\n---\n[[lesson/l/y]] [[aid/plan/absente]]',
  });
  await put('lesson/l/y', { text: 'y' });
  const health = await t.d.app.inject({ url: '/api/memory/health', headers: t.headers });
  expect(health.json()).toMatchObject({
    pages: { aid: 1, lesson: 1 },
    closed: 1,
    links: { total: 2, pendants: 1 },
    fts: true,
    vectors: 'off',
    pendingJobs: 0,
    failedJobs: 0,
  });
  const re = await t.d.app.inject({
    method: 'POST',
    url: '/api/memory/reindex',
    headers: t.headers,
  });
  expect(re.json()).toEqual({ pages: 2 });
  expect((await get('aid/plan/x')).json()).toMatchObject({ author: 'reindex', closed: true });
});

test('l’événement memory.page arrive sur /ws/events', async () => {
  t = await startTestDaemon();
  const ws = new WebSocket(`ws://127.0.0.1:${t.d.port}/ws/events`, {
    headers: { ...t.headers, origin: `http://127.0.0.1:${t.d.port}` },
  });
  const got: Array<{ type: string; data: Record<string, unknown> }> = [];
  ws.on('message', (m) => {
    const msg = JSON.parse(String(m)) as {
      kind: string;
      event?: { type: string; data: Record<string, unknown> };
    };
    if (msg.kind === 'event' && msg.event) got.push(msg.event);
  });
  await new Promise<void>((r) => ws.once('open', () => r()));
  await put('aid/plan/x', { text: 'x' });
  const e = await waitFor(() => got.find((x) => x.type === 'memory.page'), 5000, 'memory.page');
  expect(e.data).toEqual({ slug: 'aid/plan/x', revision: 1, author: 'admin', op: 'put' });
  ws.close();
});

test('PUT refuse un type de lien inconnu avant toute écriture', async () => {
  t = await startTestDaemon();
  const slug = 'aid/page/a';
  const response = await put(slug, { text: '---\nliens:\n  inconnu: [aid/page/b]\n---\nA' });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ error: 'liens.inconnu : type de lien inconnu' });
  expect((await get(slug)).statusCode).toBe(404);
});

const decide = (body: Record<string, unknown> = {}, headers = t.headers) =>
  t.d.app.inject({
    method: 'POST',
    url: '/api/memory/decisions',
    headers,
    payload: { slug: 'choix', title: 'Choix', raison: 'Motif de test', ...body },
  });

test('decide crée une décision sans remplacement, dans le namespace du run', async () => {
  t = await startTestDaemon();
  seedRun('dev', 'projet');
  const day = new Date().toISOString().slice(0, 10);
  const headers = runHeaders('run_1');
  const result = await decide({ texte: 'Détail du choix' }, headers);
  expect(result.statusCode).toBe(201);
  expect(result.json()).toEqual({ slug: 'projet/decision/choix', revision: 1, fermees: [] });
  const page = t.d.memory.get('projet/decision/choix');
  expect(page).toMatchObject({
    author: 'run:run_1',
    body: '# Choix\n\nDétail du choix',
    frontmatter: { raison: 'Motif de test', title: 'Choix', type: 'decision', valide_depuis: day },
  });
  expect(page?.frontmatter).not.toHaveProperty('liens');
  expect(decisionEvents()).toEqual([
    { slug: 'projet/decision/choix', fermees: [], author: 'run:run_1' },
  ]);
});

function decisionEvents(): unknown[] {
  return (
    t.db.prepare("SELECT data FROM events WHERE type = 'memory.decision' ORDER BY seq").all() as {
      data: string;
    }[]
  ).map(({ data }) => JSON.parse(data));
}

test('decide ferme deux pages, préserve le texte et fait remonter la décision en recherche', async () => {
  t = await startTestDaemon();
  const first = 'projet/plan/alpha';
  const second = 'projet/plan/beta';
  const target = 'projet/decision/choix';
  await put(first, { text: '---\ntags: [neutre]\n---\n# Alpha\n\nTermeterain' });
  await put(first, { text: '', mode: 'append' });
  // Une ancienne valeur invalide n'a pas fermé la page. Elle est conservée lors de la fermeture.
  await t.d.memory.put(
    second,
    '---\nremplacee_par: ancien\n---\n# Bêta',
    { kind: 'create' },
    { author: 'admin' },
  );

  const result = await decide({ namespace: 'projet', remplace: [first, second] });
  expect(result.statusCode).toBe(201);
  expect(result.json()).toEqual({ slug: target, revision: 1, fermees: [first, second] });
  const close_le = new Date().toISOString().slice(0, 10);
  expect(t.d.memory.get(first)).toMatchObject({
    closed: true,
    revision: 3,
    body: '# Alpha\n\nTermeterain\n\n',
    frontmatter: { close_le, remplacee_par: [target], tags: ['neutre'] },
  });
  expect(t.d.memory.get(second)).toMatchObject({
    closed: true,
    revision: 2,
    body: '# Bêta',
    frontmatter: { close_le, remplacee_par: ['ancien', target] },
  });
  expect(t.d.memory.get(target)?.frontmatter.liens).toEqual({ remplace: [first, second] });
  const results = await t.d.app.inject({
    url: '/api/memory/search?q=Termeterain&scope=projet',
    headers: t.headers,
  });
  expect(results.json().hits).toMatchObject([
    { slug: target, via: { slug: first, type: 'remplace' } },
  ]);
  expect(decisionEvents()).toEqual([{ slug: target, fermees: [first, second], author: 'admin' }]);
});

test('decide refuse avant toute écriture et identifie les pages en erreur', async () => {
  t = await startTestDaemon();
  seedRun('dev', 'projet');
  const headers = runHeaders('run_1');
  const open = 'projet/plan/ouverte';
  const closed = 'projet/plan/close';
  const lesson = 'lesson/test/lecon';
  const foreign = 'autre/plan/page';
  const missing = 'projet/plan/absente';
  const existing = 'projet/decision/existante';
  for (const slug of [open, lesson, foreign, existing]) await put(slug, { text: '# Page' });
  await put(closed, { text: '---\nclose_le: 2020-01-01\n---\n# Page' });
  const snapshot = () => [...t.d.memory.store.all()];
  const writes = () => t.db.prepare("SELECT id FROM events WHERE type = 'memory.page'").all();
  const before = snapshot();
  const events = writes();
  const cases: Array<[Record<string, unknown>, number, Record<string, unknown>, boolean?]> = [
    [{ remplace: [open, missing] }, 404, { slug: missing }],
    [{ remplace: [open, closed] }, 409, { error: 'deja_close', slug: closed }],
    [{ slug: 'existante' }, 409, { error: 'revision_conflict', slug: existing, revision: 1 }],
    [{ remplace: [open, lesson] }, 403, { namespace: 'lesson', allowed: 'projet' }],
    [{ remplace: [open, foreign] }, 403, { namespace: 'autre', allowed: 'projet' }],
    [{ namespace: 'autre' }, 403, { namespace: 'autre', allowed: 'projet' }],
    [{ namespace: 'lesson' }, 400, { namespace: 'lesson' }, true],
    [{ namespace: 'pas/valide' }, 400, { namespace: 'pas/valide' }, true],
    [{}, 400, { error: 'namespace est requis' }, true],
    [{ slug: 'deux/segments' }, 400, { slug: 'projet/decision/deux/segments' }],
    [{ remplace: [open, open] }, 400, { error: 'doublon dans remplace' }],
    [{ remplace: ['projet/decision/choix'] }, 400, { slug: 'projet/decision/choix' }],
    [{ title: '' }, 400, {}],
  ];
  for (const [body, status, error, admin] of cases) {
    const result = await decide(body, admin ? t.headers : headers);
    expect(result.statusCode, JSON.stringify(body)).toBe(status);
    expect(result.json()).toMatchObject(error);
    expect(snapshot()).toEqual(before);
    expect(writes()).toEqual(events);
    expect(decisionEvents()).toEqual([]);
  }
});

test('decide restaure les deux textes si le miroir échoue à la deuxième fermeture', async () => {
  t = await startTestDaemon();
  const first = 'projet/plan/alpha';
  const second = 'projet/plan/beta';
  for (const slug of [first, second]) {
    await put(slug, { text: '---\ntags: [neutre]\n---\n# Page\n\nCorps original' });
  }
  const originals = [first, second].map((slug) => renderMarkdown(t.d.memory.get(slug)!));
  const write = MemoryMirror.prototype.write;
  const error = new Error('échec simulé du miroir');
  const spy = vi.spyOn(MemoryMirror.prototype, 'write').mockImplementation(function (
    this: MemoryMirror,
    slug,
    text,
  ) {
    if (slug === second && text.includes('close_le:')) return Promise.reject(error);
    return write.call(this, slug, text);
  });
  try {
    await expect(
      t.d.memory.decide(
        {
          namespace: 'projet',
          slug: 'choix',
          title: 'Choix',
          raison: 'Motif',
          remplace: [first, second],
        },
        { author: 'admin' },
      ),
    ).rejects.toBe(error);
    for (const [index, slug] of [first, second].entries()) {
      const page = t.d.memory.get(slug)!;
      expect(renderMarkdown(page)).toBe(originals[index]);
      expect(readFileSync(join(t.home, 'memory', `${slug}.md`), 'utf8')).toBe(originals[index]);
      expect(page.revision).toBe(3);
      expect(page.closed).toBe(false);
    }
    expect(t.d.memory.get('projet/decision/choix')).toBeUndefined();
    expect(existsSync(join(t.home, 'memory/projet/decision/choix.md'))).toBe(false);
    expect(t.d.memory.links(first)?.entrants).toEqual([]);
    expect(decisionEvents()).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});

test('links rend les deux sens, y compris pour une page absente reliée, sans journaliser', async () => {
  t = await startTestDaemon();
  seedRun('dev');
  await put('projet/plan/alpha', {
    text: '---\nclose_le: 2020-01-01\n---\n[[projet/plan/absente]]',
  });
  await put('projet/plan/beta', { text: '[[projet/plan/alpha]]' });
  const links = (slug: string) =>
    t.d.app.inject({ url: `/api/memory/links/${slug}`, headers: runHeaders('run_1') });
  const alpha = await links('projet/plan/alpha');
  expect(alpha.statusCode).toBe(200);
  expect(alpha.json()).toEqual({
    slug: 'projet/plan/alpha',
    closed: true,
    sortants: [{ type: 'cite', slug: 'projet/plan/absente', existe: false }],
    entrants: [{ type: 'cite', slug: 'projet/plan/beta', existe: true }],
  });
  const missing = await links('projet/plan/absente');
  expect(missing.statusCode).toBe(200);
  expect(missing.json()).toEqual({
    slug: 'projet/plan/absente',
    closed: false,
    sortants: [],
    entrants: [{ type: 'cite', slug: 'projet/plan/alpha', existe: true }],
  });
  expect((await links('projet/plan/inconnue')).statusCode).toBe(404);
  expect(t.db.prepare('SELECT * FROM memory_usage').all()).toEqual([]);
});

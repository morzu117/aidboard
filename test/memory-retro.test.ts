import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { loadConfig } from '../src/daemon/config.js';
import { findMigrationsDir, migrate, openDb } from '../src/daemon/db.js';
import type { Embedder } from '../src/daemon/memory/embed.js';
import { MemoryJobs } from '../src/daemon/memory/jobs.js';
import { MemoryProposals } from '../src/daemon/memory/maintain.js';
import type { RetroPayload } from '../src/daemon/memory/retro.js';
import { parseMarkdown } from '../src/daemon/memory/store.js';
import { resolvePaths } from '../src/daemon/paths.js';
import { startTestDaemon, type TestDaemon, waitFor } from './helpers/daemon.js';

const topicId = 'tp_exemple';
const retroSlug = 'exemple/retro/cycle';
const planSlug = 'exemple/plan/cycle';
const lessonSlug = (slug: string) => `lesson/memoire/${slug}`;
const revue = { title: 'Rétro du cycle', body: 'La vérification a réussi.' };
const lecon = (slug: string) => ({
  slug,
  title: `Leçon ${slug}`,
  domaine: 'memoire',
  tags: ['validation', 'inconnu'],
  entites: ['migration'],
  body: 'Vérifier la conservation des données lors d’une migration.',
});

let t: TestDaemon;
let aidHome: string;
afterEach(async () => {
  await t?.d.stop();
  if (aidHome) rmSync(aidHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function setup(lecons = [lecon('a'), lecon('b'), lecon('c')], embedder?: Embedder) {
  aidHome = mkdtempSync(join(tmpdir(), 'aid-retro-'));
  writeFileSync(
    join(aidHome, 'config.yaml'),
    'memory:\n  embeddings:\n    provider: off\n  maintenance:\n    hotesPrives: [prive.example]\n',
  );
  const chat = vi.fn(async () => JSON.stringify({ retro: revue, lecons }));
  t = await startTestDaemon(aidHome, {
    config: { memory: loadConfig(resolvePaths(aidHome)).memory },
    memory: { chatModel: { chat }, embedder, pollMs: 10, backoffMs: [0] },
  });
  const at = '2026-01-01T00:00:00.000Z';
  t.db
    .prepare(
      `INSERT INTO workspaces (id, name, namespace, root, base_branch, worktrees_dir, created_at)
       VALUES ('ws_exemple', 'exemple', 'exemple', ?, 'main', ?, ?)`,
    )
    .run(aidHome, aidHome, at);
  t.db
    .prepare(
      `INSERT INTO topics (id, workspace_id, slug, title, type, branch, base, worktree, state,
                           index_state, created_at, updated_at)
       VALUES (?, 'ws_exemple', 'cycle', 'Cycle exemple', 'feat', 'feat/cycle', 'main',
               ?, 'merged', 'disabled', ?, ?)`,
    )
    .run(topicId, aidHome, at, at);
  return { chat, proposals: new MemoryProposals(t.db) };
}

const put = (slug: string, text = 'Contenu de test.') =>
  t.d.memory.put(slug, text, { kind: 'create' }, { author: 'test' });

async function runJob(idSujet = topicId, state = 'done') {
  const jobs = new MemoryJobs(t.db);
  const id = jobs.enqueue('retro', idSujet);
  expect(id).toBeTruthy();
  return waitFor(() => {
    const job = jobs.get(id!);
    return job?.state === state ? job : undefined;
  });
}

const apply = (id: string, lecons?: string[]) =>
  t.d.app.inject({
    method: 'POST',
    url: `/api/memory/proposals/${id}/apply`,
    headers: t.headers,
    ...(lecons && { payload: { lecons } }),
  });

test('le worker propose une rétro seule', async () => {
  const { chat, proposals } = await setup([]);
  await put(planSlug);
  await runJob();
  expect(chat).toHaveBeenCalledOnce();
  expect(chat.mock.calls[0]).toEqual([
    expect.stringContaining('15 lignes'),
    expect.stringContaining('Contenu de test.'),
  ]);
  const [p] = proposals.list();
  expect(p).toMatchObject({
    kind: 'retro',
    slug: retroSlug,
    rationale: `rétro de ${retroSlug} et 0 leçon(s)`,
    payload: {
      topicId,
      retro: { slug: retroSlug },
      lecons: [],
      sources: { pages: [planSlug], actions: 0, reprises: 0 },
    },
  });
  const payload = p!.payload as RetroPayload;
  expect(parseMarkdown(payload.retro.text)).toMatchObject({
    body: revue.body,
    frontmatter: { type: 'retro', title: revue.title, cycle: 'exemple/cycle' },
  });
});

test('le code fixe le frontmatter et filtre les tags des trois leçons', async () => {
  const { proposals } = await setup();
  await put(planSlug);
  await put(lessonSlug('vocabulaire'), '---\ntags: [validation]\n---\nVocabulaire.');
  await runJob();
  const { lecons } = proposals.list()[0]!.payload as RetroPayload;
  expect(lecons.map(({ slug }) => slug)).toEqual(['a', 'b', 'c'].map(lessonSlug));
  for (const [index, { text }] of lecons.entries()) {
    expect(parseMarkdown(text).frontmatter).toEqual({
      title: lecon(['a', 'b', 'c'][index]!).title,
      domaine: 'memoire',
      cycle: 'exemple/cycle',
      liens: { issu_de: [retroSlug] },
      tags: ['validation'],
      entites: ['migration'],
    });
  }
});

test.each([
  ['quatre leçons', [lecon('a'), lecon('b'), lecon('c'), lecon('d')]],
  ['slug à deux segments', [lecon('a/b')]],
  ['domaine à deux segments', [{ ...lecon('a'), domaine: 'a/b' }]],
  ['corps de 30 lignes', [{ ...lecon('a'), body: Array(30).fill('ligne').join('\n') }]],
  ['corps blanc', [{ ...lecon('a'), body: ' \t' }]],
] as const)(
  'réponse invalide (%s) : le worker réessaie sans créer de proposition',
  async (_cas, lecons) => {
    const { chat, proposals } = await setup([...lecons]);
    await put(planSlug);
    expect(await runJob(topicId, 'failed')).toMatchObject({
      attempts: 2,
      error: 'proposition retro : forme JSON invalide',
    });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(proposals.list()).toEqual([]);
  },
);

test('un slug de leçon trop long pour la mémoire fait échouer le job', async () => {
  const { proposals } = await setup([lecon('a'.repeat(200))]);
  await put(planSlug);
  expect(await runJob(topicId, 'failed')).toMatchObject({
    error: 'proposition retro : slug de leçon invalide',
  });
  expect(proposals.list()).toEqual([]);
});

test('écarte un slug pris et une répétition dans la réponse', async () => {
  const { proposals } = await setup([lecon('pris'), lecon('libre'), lecon('libre')]);
  await put(planSlug);
  await put(lessonSlug('pris'));
  await runJob();
  expect(proposals.list()[0]!.payload).toMatchObject({ lecons: [{ slug: lessonSlug('libre') }] });
});

test('écarte le doublon vectoriel ouvert en ignorant les pages closes et les autres namespaces', async () => {
  const embedder: Embedder = {
    model: 'test',
    ready: async () => true,
    embed: async (texts) =>
      texts.map((text) => new Float32Array(text.includes('second axe') ? [0, 1] : [1, 0])),
  };
  const { proposals } = await setup(
    [lecon('doublon'), { ...lecon('libre'), body: 'second axe' }],
    embedder,
  );
  await put(planSlug, 'second axe');
  await put(lessonSlug('existante'));
  await put(lessonSlug('close'), '---\nclose_le: 2026-01-01\n---\nsecond axe');
  await waitFor(() => {
    const { n } = t.db
      .prepare("SELECT count(*) AS n FROM memory_jobs WHERE kind = 'embed' AND state = 'done'")
      .get() as { n: number };
    return n === 3;
  });
  await runJob();
  expect(proposals.list()[0]!.payload).toMatchObject({ lecons: [{ slug: lessonSlug('libre') }] });
});

test.each(['page', 'open', 'applied', 'rejected', 'sujet absent'] as const)(
  'garde (%s) : le modèle reste inutilisé',
  async (cas) => {
    const { chat, proposals } = await setup();
    await put(planSlug);
    if (cas === 'page') await put(retroSlug);
    else if (cas !== 'sujet absent') {
      const p = proposals.create('retro', retroSlug, {}, 'rétro existante');
      if (cas !== 'open') proposals.decide(p.id, cas);
    }
    await runJob(cas === 'sujet absent' ? 'tp_absent' : topicId);
    expect(chat).not.toHaveBeenCalled();
  },
);

test.each(['vide', 'refus:hôte privé'])(
  'récit %s : seen suffit pour les passages suivants',
  async (raison) => {
    const { chat, proposals } = await setup();
    const prive = 'prive.example';
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    if (raison !== 'vide') await put(planSlug, `Ce récit cite ${prive}.`);
    await runJob();
    expect(
      t.db
        .prepare("SELECT slug, vocabulary FROM memory_maintenance_seen WHERE kind = 'retro'")
        .all(),
    ).toEqual([{ slug: retroSlug, vocabulary: raison }]);
    if (raison !== 'vide') await t.d.memory.remove(planSlug, { author: 'test' });
    await put(planSlug);
    await runJob();
    expect(chat).not.toHaveBeenCalled();
    expect(proposals.list()).toEqual([]);
    expect(logs.mock.calls.flat().join('\n')).not.toContain(prive);
    for (const table of [
      'memory_pages',
      'memory_proposals',
      'memory_jobs',
      'memory_maintenance_seen',
      'events',
    ]) {
      expect(JSON.stringify(t.db.prepare(`SELECT * FROM ${table}`).all())).not.toContain(prive);
    }
  },
);

test.each([{ selection: undefined }, { selection: ['a', 'c'] }, { selection: [] }])(
  'appliquer conserve la sélection %j',
  async ({ selection }) => {
    const { proposals } = await setup();
    await put(planSlug);
    await runJob();
    const [p] = proposals.list();
    expect((await apply(p!.id, selection?.map(lessonSlug))).statusCode).toBe(200);
    expect(t.d.memory.get(retroSlug)?.author).toBe('maintenance');
    const saved = proposals.get(p!.id)!;
    const expected = selection ?? ['a', 'b', 'c'];
    expect(saved.state).toBe('applied');
    expect((saved.payload as RetroPayload).lecons.map(({ slug }) => slug)).toEqual(
      expected.map(lessonSlug),
    );
    for (const slug of ['a', 'b', 'c']) {
      const page = t.d.memory.get(lessonSlug(slug));
      if (expected.includes(slug)) {
        expect(page?.author).toBe('maintenance');
        expect(page?.frontmatter.liens).toEqual({ issu_de: [retroSlug] });
      } else {
        expect(page).toBeUndefined();
      }
    }
  },
);

test('appliquer avec un slug inconnu renvoie 400 avant toute écriture', async () => {
  const { proposals } = await setup();
  await put(planSlug);
  await runJob();
  const [p] = proposals.list();
  expect((await apply(p!.id, [lessonSlug('a'), lessonSlug('inconnue')])).statusCode).toBe(400);
  expect(t.d.memory.get(retroSlug)).toBeUndefined();
  for (const slug of ['a', 'b', 'c']) expect(t.d.memory.get(lessonSlug(slug))).toBeUndefined();
  expect(proposals.get(p!.id)).toEqual(p);
});

test('un conflit sur la deuxième leçon annule les créations précédentes', async () => {
  const { proposals } = await setup();
  await put(planSlug);
  await runJob();
  const [p] = proposals.list();
  await put(lessonSlug('b'), 'Page créée entre la proposition et son application.');
  expect((await apply(p!.id)).statusCode).toBe(500);
  expect(t.d.memory.get(retroSlug)).toBeUndefined();
  expect(t.d.memory.get(lessonSlug('a'))).toBeUndefined();
  expect(t.d.memory.get(lessonSlug('b'))?.author).toBe('test');
  expect(t.d.memory.get(lessonSlug('c'))).toBeUndefined();
  expect(proposals.get(p!.id)).toEqual(p);
});

test('rejeter laisse même une rétro apparue entre-temps intacte et empêche une nouvelle proposition', async () => {
  const { chat, proposals } = await setup();
  await put(planSlug);
  await runJob();
  const [p] = proposals.list();
  const page = await put(retroSlug);
  const response = await t.d.app.inject({
    method: 'POST',
    url: `/api/memory/proposals/${p!.id}/reject`,
    headers: t.headers,
  });
  expect(response.statusCode).toBe(200);
  expect(t.d.memory.get(retroSlug)).toEqual(page);
  for (const slug of ['a', 'b', 'c']) expect(t.d.memory.get(lessonSlug(slug))).toBeUndefined();
  await t.d.memory.remove(retroSlug, { author: 'test' });
  await runJob();
  expect(chat).toHaveBeenCalledOnce();
  expect(proposals.list()).toEqual([{ ...p, state: 'rejected', decidedAt: expect.any(String) }]);
});

test('038 conserve les lignes de 037, y compris les dates, le délai et le vocabulaire', () => {
  aidHome = mkdtempSync(join(tmpdir(), 'aid-retro-migration-'));
  const migrations = findMigrationsDir();
  for (const file of readdirSync(migrations).filter((name) => Number(name.slice(0, 3)) <= 37)) {
    copyFileSync(join(migrations, file), join(aidHome, file));
  }
  const db = openDb(join(aidHome, 'state.db'), aidHome);
  try {
    expect(db.pragma('user_version', { simple: true })).toBe(37);
    db.exec(`
      INSERT INTO memory_proposals VALUES ('p', 'split', 'lesson/memoire/a', '{}', 'motif', 'rejected', 't1', 't2');
      INSERT INTO memory_jobs VALUES ('j', 'maintain', 'lesson/memoire/a', 'pending', 2, 'erreur', 't1', 't2', 't3');
      INSERT INTO memory_maintenance_seen VALUES ('lesson/memoire/a', 'tags', 3, 't1', '["validation"]');
    `);
    const tables = ['memory_proposals', 'memory_jobs', 'memory_maintenance_seen'];
    const rows = () => tables.map((name) => db.prepare(`SELECT * FROM ${name}`).all());
    const before = rows();
    migrate(db, migrations);
    expect(db.pragma('user_version', { simple: true })).toBe(38);
    expect(rows()).toEqual(before);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('memory_proposals_slug', 'memory_jobs_pending') ORDER BY name",
        )
        .pluck()
        .all(),
    ).toEqual(['memory_jobs_pending', 'memory_proposals_slug']);
  } finally {
    db.close();
  }
});

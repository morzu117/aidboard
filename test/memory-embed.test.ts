import { afterEach, expect, test } from 'vitest';
import type { Embedder } from '../src/daemon/memory/embed.js';
import { startTestDaemon, waitFor, type TestDaemon } from './helpers/daemon.js';

let t: TestDaemon;
afterEach(async () => {
  await t?.d.stop();
});

const put = (slug: string, text: string) =>
  t.d.app.inject({
    method: 'PUT',
    url: `/api/memory/pages/${slug}`,
    headers: t.headers,
    payload: { text },
  });
const search = (q: string) =>
  t.d.app.inject({ url: `/api/memory/search?q=${encodeURIComponent(q)}`, headers: t.headers });
const health = async () =>
  (await t.d.app.inject({ url: '/api/memory/health', headers: t.headers })).json();

// `waitFor` attend un prédicat synchrone : on interroge la base directement plutôt que la route
// (async) d'health, pour ne pas confondre une promesse toujours vraie avec la condition réelle.
const jobState = (slug: string) =>
  (
    t.db.prepare('SELECT state FROM memory_jobs WHERE slug = ?').get(slug) as
      { state: string } | undefined
  )?.state;
const vectorCount = () => {
  const exists = t.db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_vectors'")
    .get();
  if (!exists) return 0;
  return (t.db.prepare('SELECT count(*) AS c FROM memory_vectors').get() as { c: number }).c;
};

// Vecteurs choisis à la main par texte exact (titre\n\ncorps, ou requête telle quelle) : pas de
// vrai modèle, juste de quoi vérifier la mécanique (ensureTable, upsert, RRF).
function fakeEmbedder(vectors: Record<string, number[]>, opts: { ready?: boolean } = {}): Embedder {
  return {
    model: 'fake-bge',
    async ready() {
      return opts.ready ?? true;
    },
    async embed(texts) {
      return texts.map((text) => {
        const v = vectors[text];
        if (!v) throw new Error(`fakeEmbedder : texte inattendu : ${JSON.stringify(text)}`);
        return Float32Array.from(v);
      });
    },
  };
}

function alwaysFails(): Embedder {
  return {
    model: 'fake-bge',
    async ready() {
      return true;
    },
    async embed() {
      throw new Error('embedding en échec (test)');
    },
  };
}

test('put enfile un job d’embedding, le worker le passe à done, memory_vectors a une ligne', async () => {
  const embedder = fakeEmbedder({ 'felin\n\nLe chat dort sur le canapé.': [1, 0, 0] });
  t = await startTestDaemon(undefined, { memory: { embedder, pollMs: 5 } });
  expect((await put('aid/plan/felin', 'Le chat dort sur le canapé.')).statusCode).toBe(201);
  await waitFor(() => jobState('aid/plan/felin') === 'done', 5000, 'job embed terminé');
  expect((await health()).vectors).toBe('ollama');
  expect(
    t.db.prepare('SELECT slug FROM memory_vectors WHERE slug = ?').get('aid/plan/felin'),
  ).toMatchObject({ slug: 'aid/plan/felin' });
});

test('recherche hybride : une page sans mot commun avec la requête remonte par proximité vectorielle', async () => {
  const embedder = fakeEmbedder({
    'felin\n\nLe chat dort sur le canapé.': [1, 0, 0],
    'canin\n\nLe chien dort sur le tapis.': [0, 1, 0],
    félin: [0.9, 0.1, 0],
  });
  t = await startTestDaemon(undefined, { memory: { embedder, pollMs: 5 } });
  await put('aid/plan/felin', 'Le chat dort sur le canapé.');
  await put('aid/plan/canin', 'Le chien dort sur le tapis.');
  await waitFor(() => vectorCount() === 2, 5000, 'jobs embed terminés');
  const r = await search('félin');
  expect(r.json()).toMatchObject({ mode: 'hybrid' });
  const slugs = (r.json().hits as Array<{ slug: string }>).map((h) => h.slug);
  expect(slugs[0]).toBe('aid/plan/felin');
});

test('Embedder.ready() faux : recherche FTS5 seule, jamais de job', async () => {
  const embedder = fakeEmbedder({}, { ready: false });
  t = await startTestDaemon(undefined, { memory: { embedder, pollMs: 5 } });
  await put('aid/plan/x', 'un mot rare : zythum');
  expect((await health()).vectors).toBe('off');
  expect((await health()).pendingJobs).toBe(0);
  const r = await search('zythum');
  expect(r.json()).toMatchObject({ mode: 'fts', hits: [{ slug: 'aid/plan/x' }] });
});

test('échec d’embedding : le job passe à failed après 3 tentatives, le put a déjà répondu', async () => {
  t = await startTestDaemon(undefined, {
    memory: { embedder: alwaysFails(), backoffMs: [5, 5], pollMs: 5 },
  });
  const r = await put('aid/plan/x', 'contenu');
  expect(r.statusCode).toBe(201); // répond avant que le worker n'ait rien tenté
  await waitFor(() => jobState('aid/plan/x') === 'failed', 5000, 'job embed en échec');
  const job = t.db
    .prepare('SELECT state, attempts FROM memory_jobs WHERE slug = ?')
    .get('aid/plan/x');
  expect(job).toMatchObject({ state: 'failed', attempts: 3 });
  expect((await health()).pendingJobs).toBe(0);
});

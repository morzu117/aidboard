import { afterEach, expect, test, vi } from 'vitest';
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

test('Embedder.ready() faux : recherche FTS5 seule, job en attente', async () => {
  const embedder = fakeEmbedder({}, { ready: false });
  t = await startTestDaemon(undefined, { memory: { embedder, pollMs: 5 } });
  await put('aid/plan/x', 'un mot rare : zythum');
  expect((await health()).vectors).toBe('off');
  expect((await health()).pendingJobs).toBe(1);
  expect(t.db.prepare('SELECT attempts FROM memory_jobs').get()).toEqual({ attempts: 0 });
  const r = await search('zythum');
  expect(r.json()).toMatchObject({ mode: 'fts', hits: [{ slug: 'aid/plan/x' }] });
});

test('DM16 : un contenu rejeté épuise ses tentatives sans désactiver la recherche hybride', async () => {
  const ready = vi.fn(async () => true);
  const embed = vi.fn(async () => {
    throw new Error('contenu rejeté');
  });
  t = await startTestDaemon(undefined, {
    memory: {
      embedder: { model: 'fake-bge', ready, embed },
      backoffMs: [5, 5],
      pollMs: 5,
      maintenanceScheduleMs: 20,
      readyTimeoutMs: 50,
    },
  });
  expect((await put('aid/plan/x', 'contenu')).statusCode).toBe(201);
  await waitFor(() => jobState('aid/plan/x') === 'failed');
  const sondes = ready.mock.calls.length;
  await waitFor(() => ready.mock.calls.length > sondes + 1);
  expect((await health()).vectors).toBe('ollama');
  expect(embed).toHaveBeenCalledTimes(3);
  expect(t.db.prepare('SELECT state, attempts, error FROM memory_jobs').all()).toEqual([
    { state: 'failed', attempts: 3, error: 'contenu rejeté' },
  ]);
});

test('DM16 : une nouvelle révision réarme un embedding en échec', async () => {
  const disponibilité = { ready: true };
  const embedder = fakeEmbedder({ 'x\n\ncontenu corrigé': [1, 0, 0] }, disponibilité);
  const slug = 'aid/plan/x';
  t = await startTestDaemon(undefined, {
    memory: { embedder, backoffMs: [], maintenanceScheduleMs: 20 },
  });
  expect((await put(slug, 'contenu rejeté')).statusCode).toBe(201);
  await waitFor(() => jobState(slug) === 'failed');

  disponibilité.ready = false;
  await vi.waitFor(async () => expect((await health()).vectors).toBe('off'));
  await t.d.memory.put(
    slug,
    'contenu corrigé',
    { kind: 'replace', expectedRevision: 1 },
    { author: 'admin' },
  );
  expect(jobState(slug)).toBe('pending');
  expect(t.d.memory.get(slug)?.revision).toBe(2);

  disponibilité.ready = true;
  await waitFor(() => jobState(slug) === 'done');
  expect(t.db.prepare('SELECT slug FROM memory_vectors').all()).toEqual([{ slug }]);
});

test('DM16 : rattrapage après démarrage indisponible, puis après une nouvelle panne', async () => {
  const availability = { ready: false };
  let probes = 0;
  const fake = fakeEmbedder(
    {
      'x\n\ncontenu': [1, 0, 0],
      'ancienne\n\ncontenu': [0, 1, 0],
      'y\n\ncontenu': [0, 0, 1],
    },
    availability,
  );
  t = await startTestDaemon(undefined, {
    memory: {
      embedder: {
        ...fake,
        ready: async () => {
          probes++;
          return availability.ready;
        },
      },
      pollMs: 5,
      maintenanceScheduleMs: 20,
    },
  });
  await put('aid/plan/x', 'contenu');
  await put('aid/plan/ancienne', 'contenu');
  // Simule une page importée avant la file persistante, sans job à reprendre.
  t.db.prepare('DELETE FROM memory_jobs WHERE slug = ?').run('aid/plan/ancienne');
  const before = probes;
  await waitFor(() => probes > before + 1);
  expect(jobState('aid/plan/x')).toBe('pending');
  expect(vectorCount()).toBe(0);
  availability.ready = true;
  await waitFor(() => vectorCount() === 2);
  expect(t.db.prepare('SELECT count(*) AS n FROM memory_jobs').get()).toEqual({ n: 2 });
  const recovered = probes;
  availability.ready = false;
  await waitFor(() => probes > recovered + 1);
  expect((await health()).vectors).toBe('off');
  await put('aid/plan/y', 'contenu');
  const down = probes;
  await waitFor(() => probes > down + 1);
  expect(
    t.db.prepare('SELECT state, attempts FROM memory_jobs WHERE slug = ?').get('aid/plan/y'),
  ).toEqual({ state: 'pending', attempts: 0 });
  availability.ready = true;
  await waitFor(() => vectorCount() === 3);
  expect((await health()).vectors).toBe('ollama');
});

test('DM16 : panne entre deux ticks, job pending rattrapé au retour d’Ollama', async () => {
  let available = true;
  let échecEmbedding = false;
  let sondéAprèsÉchec = false;
  t = await startTestDaemon(undefined, {
    memory: {
      embedder: {
        model: 'fake-bge',
        async ready() {
          if (échecEmbedding) sondéAprèsÉchec = true;
          return available;
        },
        async embed() {
          if (!échecEmbedding) {
            échecEmbedding = true;
            available = false;
            throw new Error('panne entre deux ticks');
          }
          return [Float32Array.from([1, 0, 0])];
        },
      },
      backoffMs: [],
      pollMs: 60_000,
      maintenanceScheduleMs: 1000,
      readyTimeoutMs: 50,
    },
  });
  expect((await health()).vectors).toBe('ollama');
  await put('aid/plan/panne', 'contenu');
  await waitFor(() => sondéAprèsÉchec && jobState('aid/plan/panne') === 'pending');
  expect((await health()).vectors).toBe('off');
  expect(t.db.prepare('SELECT attempts FROM memory_jobs').get()).toEqual({ attempts: 0 });
  available = true;
  await waitFor(() => vectorCount() === 1);
  expect(jobState('aid/plan/panne')).toBe('done');
  expect(t.db.prepare('SELECT count(*) AS n FROM memory_jobs').get()).toEqual({ n: 1 });
});

test('DM16 : ready bloqué est borné et ne bloque pas l’arrêt pendant un tick', async () => {
  let probes = 0;
  t = await startTestDaemon(undefined, {
    memory: {
      embedder: {
        model: 'fake-bge',
        ready() {
          probes++;
          return probes === 1 ? Promise.resolve(true) : new Promise<boolean>(() => {});
        },
        async embed() {
          return [Float32Array.from([1, 0, 0])];
        },
      },
      maintenanceScheduleMs: 20,
      readyTimeoutMs: 50,
    },
  });
  await waitFor(() => probes >= 2);
  await t.d.stop();
});

test('DM16 : absence au démarrage journalisée, même si ready ne répond jamais', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    t = await startTestDaemon(undefined, {
      memory: {
        embedder: {
          model: 'fake-bge',
          ready: () => new Promise<boolean>(() => {}),
          embed: async () => [],
        },
        readyTimeoutMs: 50,
      },
    });
    expect((await health()).vectors).toBe('off');
    expect(log).toHaveBeenCalledWith('ollama injoignable : recherche FTS5 seule');
  } finally {
    log.mockRestore();
  }
});

test('DM16 : un ancien job failed est rattrapé au retour de la disponibilité', async () => {
  const disponibilité = { ready: true };
  const fake = fakeEmbedder({ 'ancien\n\ncontenu': [1, 0, 0] }, disponibilité);
  const ready = vi.fn(fake.ready);
  t = await startTestDaemon(undefined, {
    memory: {
      embedder: { ...fake, ready },
      pollMs: 5,
      maintenanceScheduleMs: 20,
      readyTimeoutMs: 50,
    },
  });
  await put('aid/plan/ancien', 'contenu');
  await waitFor(() => jobState('aid/plan/ancien') === 'done');
  t.db.prepare('DELETE FROM memory_vectors').run();
  t.db.prepare("UPDATE memory_jobs SET state = 'failed'").run();
  const sondes = ready.mock.calls.length;
  await waitFor(() => ready.mock.calls.length > sondes + 1);
  expect(jobState('aid/plan/ancien')).toBe('failed');
  disponibilité.ready = false;
  const sondesAvantPanne = ready.mock.calls.length;
  await waitFor(() => ready.mock.calls.length > sondesAvantPanne + 1);
  expect((await health()).vectors).toBe('off');
  disponibilité.ready = true;
  await waitFor(() => vectorCount() === 1);
  expect(jobState('aid/plan/ancien')).toBe('done');
  expect(t.db.prepare('SELECT count(*) AS n FROM memory_jobs').get()).toEqual({ n: 1 });
});

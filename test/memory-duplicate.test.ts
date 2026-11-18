import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { parseConfig } from '../src/daemon/config.js';
import { type Db, openDb } from '../src/daemon/db.js';
import { VectorIndex } from '../src/daemon/memory/embed.js';
import { MemoryJobs } from '../src/daemon/memory/jobs.js';
import {
  type ChatModel,
  MemoryProposals,
  runMaintainJob,
  scheduleMaintenance,
} from '../src/daemon/memory/maintain.js';
import { MemoryStore } from '../src/daemon/memory/store.js';
import { startTestDaemon, waitFor } from './helpers/daemon.js';

let home: string;
let db: Db;
let store: MemoryStore;
let vectors: VectorIndex;
let proposals: MemoryProposals;
const chat = vi.fn<ChatModel['chat']>(async () => '{"doublon":false,"rationale":"distinctes"}');
const source = 'lesson/test/source';
const text = '---\ntags: [test]\n---\nLeçon.';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aid-duplicate-'));
  vi.stubEnv('AID_HOME', home);
  db = openDb(join(home, 'state.db'));
  store = new MemoryStore(db);
  proposals = new MemoryProposals(db);
  vectors = VectorIndex.load(db, () => {})!;
  expect(vectors).not.toBeNull();
  vectors.ensureTable('fake', 2);
  chat.mockReset().mockResolvedValue('{"doublon":false,"rationale":"distinctes"}');
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function page(slug: string, angle = 0) {
  store.put(slug, text, { kind: 'create' }, 'test');
  vectors.upsert(slug, new Float32Array([Math.cos(angle), Math.sin(angle)]));
}

async function run(slug = source, index: VectorIndex | undefined = vectors, distance = 0.15) {
  const jobs = new MemoryJobs(db);
  jobs.enqueue('maintain', slug);
  const job = jobs.claim()!;
  try {
    await runMaintainJob(job, {
      store,
      proposals,
      vectors: index,
      duplicateDistance: distance,
      model: { chat },
      log: () => {},
    });
    jobs.done(job.id);
  } catch (error) {
    jobs.fail(job.id, (error as Error).message, 0);
    throw error;
  }
}

const pairs = () =>
  db.prepare('SELECT * FROM memory_duplicate_pairs ORDER BY slug_a, slug_b').all();

test('non : trois voisins lesson/ au plus, dans l’ordre, sous le seuil, aucune proposition', async () => {
  page(source);
  page('aid/plan/proche');
  page('lesson/test/c', 0.3);
  page('lesson/test/b', 0.2);
  page('lesson/test/a', 0.1);
  page('lesson/test/d', 0.4);
  page('lesson/test/loin', 1);
  await run();
  expect(chat).toHaveBeenCalledTimes(3);
  for (const [i, name] of ['a', 'b', 'c'].entries()) {
    expect(chat.mock.calls[i]?.[1]).toContain(`Candidat : lesson/test/${name}\n`);
  }
  expect(proposals.list()).toEqual([]);
  expect(pairs()).toHaveLength(3);
  expect(pairs()[0]).toMatchObject({ verdict: 'non', revision_a: 1, revision_b: 1 });
});

test('oui : arrêt au premier oui et duplicateOf imposé par le candidat', async () => {
  page(source);
  page('lesson/test/a', 0.1);
  page('lesson/test/b', 0.2);
  page('lesson/test/c', 0.3);
  chat
    .mockResolvedValueOnce('{"doublon":false,"rationale":"non"}')
    .mockResolvedValueOnce('{"doublon":true,"rationale":"même leçon"}');
  await run();
  expect(chat).toHaveBeenCalledTimes(2);
  expect(proposals.list()).toMatchObject([
    {
      kind: 'duplicate',
      slug: source,
      payload: { duplicateOf: 'lesson/test/b', rationale: 'même leçon' },
    },
  ]);
  expect(pairs()).toHaveLength(2);
  expect(pairs()[1]).toMatchObject({ verdict: 'oui' });
});

test('sans index ou sans vecteur source : aucun examen jusqu’à l’arrivée du vecteur', async () => {
  store.put(source, text, { kind: 'create' }, 'test');
  page('lesson/test/a');
  await run();
  expect(chat).not.toHaveBeenCalled();
  expect(proposals.seen(store.get(source)!, 'duplicate', '0.15')).toBe(false);
  vectors.upsert(source, new Float32Array([1, 0]));
  await runMaintainJob(
    { id: 'sans-index', kind: 'maintain', slug: source, attempts: 1 },
    {
      store,
      proposals,
      model: { chat },
      log: () => {},
    },
  );
  expect(chat).not.toHaveBeenCalled();
  expect(pairs()).toEqual([]);
  expect(proposals.list()).toEqual([]);
  expect(proposals.seen(store.get(source)!, 'duplicate', '0.15')).toBe(false);
  await run();
  expect(chat).toHaveBeenCalledOnce();
  expect(proposals.seen(store.get(source)!, 'duplicate', '0.15')).toBe(true);
});

test('seuil inclusif et configurable', async () => {
  page(source);
  store.put(
    'lesson/test/a',
    '---\ntags: [test]\nentretien_rejete: [duplicate]\n---\nLeçon.',
    { kind: 'create' },
    'test',
  );
  vectors.upsert('lesson/test/a', new Float32Array([0, 1]));
  await run();
  expect(chat).not.toHaveBeenCalled();
  const jobs = new MemoryJobs(db);
  const maintenant = new Date(2026, 10, 18, 23);
  const planifier = (duplicateDistance: number) =>
    scheduleMaintenance(maintenant, {
      vectors,
      store,
      jobs,
      proposals,
      enabled: true,
      window: '22:00-04:00',
      duplicateDistance,
    });
  expect(planifier(0.15)).toBe(0);
  expect(planifier(1)).toBe(1);
  await run(source, vectors, 1);
  expect(chat).toHaveBeenCalledTimes(1);
});

test('paire persistante et symétrique, rejugée si une des deux révisions change', async () => {
  page(source);
  page('lesson/test/a', 0.1);
  await run();
  db.close();
  db = openDb(join(home, 'state.db'));
  store = new MemoryStore(db);
  proposals = new MemoryProposals(db);
  vectors = VectorIndex.load(db, () => {})!;
  await run('lesson/test/a');
  expect(chat).toHaveBeenCalledTimes(1);
  store.put(source, `${text} modifiée`, { kind: 'force' }, 'test');
  await run('lesson/test/a');
  expect(chat).toHaveBeenCalledTimes(2);
  store.put('lesson/test/a', `${text} modifiée`, { kind: 'force' }, 'test');
  await run();
  expect(chat).toHaveBeenCalledTimes(3);
  expect(pairs()).toHaveLength(1);
  expect(pairs()[0]).toMatchObject({
    slug_a: 'lesson/test/a',
    slug_b: source,
    revision_a: 2,
    revision_b: 2,
  });
});

test.each(['réécriture', 'suppression'])(
  'un partenaire jugé non rend la page éligible après sa %s',
  async (action) => {
    const partenaire = 'lesson/test/a';
    page(source);
    page(partenaire);
    await run();
    const pageSource = store.get(source)!;
    expect(pairs()).toMatchObject([{ verdict: 'non' }]);
    expect(proposals.seen(pageSource, 'duplicate', '0.15')).toBe(true);

    if (action === 'réécriture') {
      store.put(partenaire, `${text} Modifiée.`, { kind: 'force' }, 'test');
    } else {
      expect(store.remove(partenaire)).toBe(true);
    }

    expect(proposals.seen(pageSource, 'duplicate', '0.15')).toBe(false);
    await run();
    expect(chat).toHaveBeenCalledTimes(action === 'réécriture' ? 2 : 1);
    expect(proposals.seen(pageSource, 'duplicate', '0.15')).toBe(true);
  },
);

test.each([
  'pas du JSON',
  '{"doublon":"non","rationale":"non"}',
  '{"doublon":true,"rationale":"oui","duplicateOf":"intrus"}',
  '{"doublon":false}',
])('hors schéma : échec sans verdict, retry possible (%s)', async (answer) => {
  page(source);
  page('lesson/test/a', 0.1);
  chat.mockResolvedValueOnce(answer);
  await expect(run()).rejects.toThrow();
  expect(pairs()).toEqual([]);
  expect(proposals.list()).toEqual([]);
  expect(db.prepare('SELECT state, attempts FROM memory_jobs').get()).toMatchObject({
    state: 'pending',
    attempts: 1,
  });
  await run();
  expect(chat).toHaveBeenCalledTimes(2);
  expect(pairs()).toHaveLength(1);
});

test('duplicateDistance : défaut, bornes et valeurs invalides', () => {
  expect(parseConfig('').memory.maintenance.duplicateDistance).toBe(0.15);
  for (const distance of ['0.01', '2']) {
    expect(
      parseConfig(`memory:\n  maintenance:\n    duplicateDistance: ${distance}`).memory.maintenance
        .duplicateDistance,
    ).toBe(Number(distance));
  }
  for (const distance of ['0', '-1', '2.1', '.nan', '.inf', '"0.15"', 'null']) {
    expect(() =>
      parseConfig(`memory:\n  maintenance:\n    duplicateDistance: ${distance}`),
    ).toThrow('duplicateDistance');
  }
});

test.each(['lesson/test/a', source])(
  'suppression de %s : la paire est rejugée après recréation',
  async (slug) => {
    page(source);
    page('lesson/test/a');
    await run();
    expect(pairs()).toHaveLength(1);
    expect(store.remove(slug)).toBe(true);
    expect(pairs()).toEqual([]);
    page(slug);
    expect(store.get(slug)?.revision).toBe(1);
    await run();
    expect(chat).toHaveBeenCalledTimes(2);
    expect(pairs()).toHaveLength(1);
  },
);

test('échec de création : aucun oui enregistré, puis nouvelle tentative', async () => {
  page(source);
  page('lesson/test/a');
  chat.mockResolvedValue('{"doublon":true,"rationale":"même leçon"}');
  const create = vi.spyOn(proposals, 'create').mockImplementationOnce(() => {
    throw new Error('création impossible');
  });
  await expect(run()).rejects.toThrow('création impossible');
  expect(pairs()).toEqual([]);
  expect(proposals.list()).toEqual([]);
  await run();
  expect(chat).toHaveBeenCalledTimes(2);
  expect(proposals.list()).toHaveLength(1);
  expect(pairs()[0]).toMatchObject({ verdict: 'oui' });
  create.mockRestore();
});

test('échec du verdict oui : annulation des deux écritures, puis une seule proposition', async () => {
  page(source);
  page('lesson/test/a');
  chat.mockResolvedValue('{"doublon":true,"rationale":"même leçon"}');
  const enregistrer = store.recordDuplicatePair.bind(store);
  const verdict = vi.spyOn(store, 'recordDuplicatePair').mockImplementationOnce((...args) => {
    expect(proposals.list()).toHaveLength(1);
    enregistrer(...args);
    throw new Error('enregistrement impossible');
  });
  await expect(run()).rejects.toThrow('enregistrement impossible');
  expect(pairs()).toEqual([]);
  expect(proposals.list()).toEqual([]);
  verdict.mockRestore();
  await run();
  expect(chat).toHaveBeenCalledTimes(2);
  expect(proposals.list()).toHaveLength(1);
  expect(pairs()).toMatchObject([{ verdict: 'oui' }]);
});

test('vecteur orphelin : aucun candidat absent du store n’est jugé', async () => {
  page(source);
  vectors.upsert('lesson/test/absente', new Float32Array([1, 0]));
  await run();
  expect(chat).not.toHaveBeenCalled();
  expect(pairs()).toEqual([]);
  expect(proposals.list()).toEqual([]);
});

test('oui déjà jugé : relance symétrique et après décision sans seconde proposition', async () => {
  page(source);
  page('lesson/test/a');
  chat.mockResolvedValue('{"doublon":true,"rationale":"même leçon"}');
  await run();
  await run();
  await run('lesson/test/a');
  proposals.decide(proposals.list()[0]!.id, 'rejected');
  await run();
  expect(chat).toHaveBeenCalledTimes(1);
  expect(proposals.list()).toHaveLength(1);
  expect(pairs()).toHaveLength(1);
});

// 0.1 est le contrôle négatif : comme le défaut 0.15, il exclut le candidat.
test.each([0.1, 0.3])('daemon : vecteurs et seuil %s transmis au job doublon', async (distance) => {
  const vecteurCandidat = [0.8, 0.6];
  const distanceCandidat = 1 - vecteurCandidat[0]! / Math.hypot(...vecteurCandidat);
  const candidatRetenu = distance >= distanceCandidat;
  const embed = vi.fn(async (texts: string[]) =>
    texts.map(
      (content) => new Float32Array(content.includes('Candidate') ? vecteurCandidat : [1, 0]),
    ),
  );
  const t = await startTestDaemon(join(home, 'daemon'), {
    config: {
      memory: {
        embeddings: { provider: 'off', model: 'fake', url: 'http://127.0.0.1:1' },
        maintenance: {
          enabled: false,
          model: 'fake',
          window: '00:00-00:00',
          duplicateDistance: distance,
        },
        git: { push: false },
      },
    },
    memory: {
      embedder: { model: 'fake', ready: async () => true, embed },
      chatModel: { chat },
      pollMs: 5,
    },
  });
  try {
    for (const [slug, body] of [
      [source, text],
      ['lesson/test/a', `${text} Candidate`],
    ]) {
      const response = await t.d.app.inject({
        method: 'PUT',
        url: `/api/memory/pages/${slug}`,
        headers: t.headers,
        payload: { text: body },
      });
      expect(response.statusCode).toBe(201);
    }
    await waitFor(
      () =>
        (
          t.db
            .prepare(
              "SELECT count(*) AS n FROM memory_jobs WHERE kind = 'embed' AND state = 'done'",
            )
            .get() as { n: number }
        ).n === 2,
    );
    const id = new MemoryJobs(t.db).enqueue('maintain', source);
    await waitFor(
      () =>
        (t.db.prepare('SELECT state FROM memory_jobs WHERE id = ?').get(id) as { state: string })
          .state === 'done',
    );
    expect(embed).toHaveBeenCalled();
    expect(chat).toHaveBeenCalledTimes(candidatRetenu ? 1 : 0);
    expect(t.db.prepare('SELECT * FROM memory_duplicate_pairs').all()).toHaveLength(
      candidatRetenu ? 1 : 0,
    );
    if (candidatRetenu) expect(chat.mock.calls[0]?.[1]).toContain('Candidat : lesson/test/a');
  } finally {
    await t.d.stop();
  }
});

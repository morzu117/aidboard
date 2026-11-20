import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { type Db, openDb } from '../src/daemon/db.js';
import { MemoryJobs } from '../src/daemon/memory/jobs.js';
import {
  applyProposal,
  type ChatModel,
  MemoryProposals,
  scheduleMaintenance,
} from '../src/daemon/memory/maintain.js';
import { MemoryMirror } from '../src/daemon/memory/mirror.js';
import { MemoryService } from '../src/daemon/memory/service.js';
import { MemoryStore } from '../src/daemon/memory/store.js';
import { RevisionConflict } from '../src/shared/memory.js';
import { startTestDaemon, waitFor, type TestDaemon } from './helpers/daemon.js';

// Config mémoire complète : `startDaemon` fusionne `memory` au premier niveau (pas de fusion
// profonde), toute config de test doit donc donner embeddings/maintenance/git en entier.
const MEMORY_CFG = (maintenance: { enabled: boolean; window: string; model?: string }) => ({
  embeddings: { provider: 'off' as const, model: 'bge-m3', url: 'http://127.0.0.1:11434' },
  maintenance: {
    enabled: maintenance.enabled,
    window: maintenance.window,
    model: maintenance.model ?? 'qwen3:8b',
  },
  git: { push: false },
});

function fixedChatModel(content: string): ChatModel {
  return {
    async chat() {
      return content;
    },
  };
}

let t: TestDaemon;
let db: Db;
afterEach(async () => {
  await t?.d.stop();
  db?.close();
});

function freshDb(): { store: MemoryStore; jobs: MemoryJobs; proposals: MemoryProposals } {
  db = openDb(join(mkdtempSync(join(tmpdir(), 'aid-maint-')), 'state.db'));
  return {
    store: new MemoryStore(db),
    jobs: new MemoryJobs(db),
    proposals: new MemoryProposals(db),
  };
}

const put = (slug: string, text: string) =>
  t.d.app.inject({
    method: 'PUT',
    url: `/api/memory/pages/${slug}`,
    headers: t.headers,
    payload: { text },
  });
const getPage = async (slug: string) =>
  (await t.d.app.inject({ url: `/api/memory/pages/${slug}`, headers: t.headers })).json();
const apply = (id: string) =>
  t.d.app.inject({ method: 'POST', url: `/api/memory/proposals/${id}/apply`, headers: t.headers });

// `waitFor` attend un prédicat synchrone (cf. 06.7) : on interroge la base directement.
const jobState = (slug: string) =>
  (
    t.db.prepare("SELECT state FROM memory_jobs WHERE kind = 'maintain' AND slug = ?").get(slug) as
      { state: string } | undefined
  )?.state;
const openProposals = () =>
  t.db.prepare("SELECT id, kind, slug FROM memory_proposals WHERE state = 'open'").all() as Array<{
    id: string;
    kind: string;
    slug: string;
  }>;

test('page sans tags : une proposition « tags » ouverte, la page ne change pas', async () => {
  t = await startTestDaemon(undefined, {
    config: { memory: MEMORY_CFG({ enabled: true, window: '00:00-23:59' }) },
    memory: { chatModel: fixedChatModel('{"tags":["chat","sommeil"]}'), maintenanceScheduleMs: 20 },
  });
  await put('lesson/test/vocabulaire', '---\ntags: [chat, sommeil]\n---\nVocabulaire.');
  expect((await put('lesson/test/felin', 'Le chat dort sur le canapé.')).statusCode).toBe(201);
  await waitFor(() => jobState('lesson/test/felin') === 'done', 5000, 'job maintain terminé');

  const open = openProposals();
  expect(open).toHaveLength(1);
  expect(open[0]).toMatchObject({ kind: 'tags', slug: 'lesson/test/felin' });

  const page = await getPage('lesson/test/felin');
  expect(page.revision).toBe(1);
  expect(page.frontmatter.tags).toBeUndefined();
});

test('apply : les tags sont écrits, la révision augmente', async () => {
  t = await startTestDaemon(undefined, {
    config: { memory: MEMORY_CFG({ enabled: true, window: '00:00-23:59' }) },
    memory: { chatModel: fixedChatModel('{"tags":["chat","sommeil"]}'), maintenanceScheduleMs: 20 },
  });
  await put('lesson/test/vocabulaire', '---\ntags: [chat, sommeil]\n---\nVocabulaire.');
  await put('lesson/test/felin', 'Le chat dort sur le canapé.');
  await waitFor(() => jobState('lesson/test/felin') === 'done', 5000, 'job maintain terminé');
  const [proposal] = openProposals();

  const res = await apply(proposal!.id);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ state: 'applied' });

  const page = await getPage('lesson/test/felin');
  expect(page.revision).toBe(2);
  expect(page.frontmatter.tags).toEqual(['chat', 'sommeil']);
});

test('réponse JSON invalide : le job échoue, aucune proposition n’est créée', async () => {
  t = await startTestDaemon(undefined, {
    config: { memory: MEMORY_CFG({ enabled: true, window: '00:00-23:59' }) },
    memory: {
      chatModel: fixedChatModel('ceci n’est pas du JSON'),
      maintenanceScheduleMs: 20,
      backoffMs: [],
    },
  });
  await put('lesson/test/vocabulaire', '---\ntags: [chat, sommeil]\n---\nVocabulaire.');
  await put('lesson/test/x', 'contenu quelconque');
  await waitFor(() => jobState('lesson/test/x') === 'failed', 5000, 'job maintain en échec');
  expect(openProposals()).toEqual([]);
});

test('hors fenêtre : aucun job créé', () => {
  const { store, jobs, proposals } = freshDb();
  store.put('aid/plan/x', 'contenu', { kind: 'create' }, 'test');
  const now = new Date('2026-01-01T12:00:00');
  const n = scheduleMaintenance(now, {
    store,
    jobs,
    proposals,
    enabled: true,
    window: '02:00-06:00',
  });
  expect(n).toBe(0);
  expect(db.prepare("SELECT count(*) AS c FROM memory_jobs WHERE kind = 'maintain'").get()).toEqual(
    { c: 0 },
  );
});

test('désactivé : aucun job créé même dans la fenêtre', () => {
  const { store, jobs, proposals } = freshDb();
  store.put('aid/plan/x', 'contenu', { kind: 'create' }, 'test');
  const now = new Date('2026-01-01T03:00:00');
  const n = scheduleMaintenance(now, {
    store,
    jobs,
    proposals,
    enabled: false,
    window: '02:00-06:00',
  });
  expect(n).toBe(0);
});

test('page éligible, dans la fenêtre : un job par page, plafonné à maxPerNight', () => {
  const { store, jobs, proposals } = freshDb();
  store.put('lesson/test/a', '---\na_decouper: true\n---\ncontenu a', { kind: 'create' }, 'test');
  store.put('lesson/test/b', '---\na_decouper: true\n---\ncontenu b', { kind: 'create' }, 'test');
  const now = new Date('2026-01-01T03:00:00');
  const n = scheduleMaintenance(now, {
    store,
    jobs,
    proposals,
    enabled: true,
    window: '02:00-06:00',
    maxPerNight: 1,
  });
  expect(n).toBe(1);
  expect(db.prepare("SELECT count(*) AS c FROM memory_jobs WHERE kind = 'maintain'").get()).toEqual(
    { c: 1 },
  );
});

const splitSource = 'lesson/test/source';
const splitText =
  '---\ntags: [test]\nentretien_rejete: [duplicate]\na_decouper: true\n---\nLeçon à découper.';
const splitPages = (secondSlug = 'lesson/test/seconde') => [
  {
    slug: 'lesson/test/premiere',
    title: 'Première',
    frontmatter: {
      tags: ['test'],
      title: 'Titre modèle',
      issu_de: 'origine-falsifiee',
      remplacee_par: ['intrus'],
      entretien_rejete: ['split'],
    },
    body: 'Première leçon.',
  },
  { slug: secondSlug, title: 'Seconde', frontmatter: {}, body: 'Seconde leçon.' },
];

test('split : crée les pages, filtre le frontmatter et impose leur origine', async () => {
  t = await startTestDaemon(undefined, {
    config: { memory: MEMORY_CFG({ enabled: true, window: '00:00-23:59' }) },
    memory: {
      chatModel: fixedChatModel(JSON.stringify({ pages: splitPages() })),
      maintenanceScheduleMs: 20,
    },
  });
  await put(splitSource, splitText);
  await waitFor(() => jobState(splitSource) === 'done', 5000, 'découpage proposé');
  const [proposal] = new MemoryProposals(t.db).list('open');
  const payload = proposal!.payload as { pages: Array<{ frontmatter: unknown }> };
  expect(payload.pages[0]!.frontmatter).toEqual({
    tags: ['test'],
    title: 'Titre modèle',
    issu_de: splitSource,
  });
  expect((await apply(proposal!.id)).statusCode).toBe(200);
  expect((await getPage('lesson/test/premiere')).frontmatter).toEqual({
    tags: ['test'],
    title: 'Première',
    issu_de: splitSource,
  });
  expect((await getPage('lesson/test/seconde')).frontmatter).toEqual({
    title: 'Seconde',
    issu_de: splitSource,
  });
  expect((await getPage(splitSource)).frontmatter.remplacee_par).toEqual([
    'lesson/test/premiere',
    'lesson/test/seconde',
  ]);
});

test.each(['aid/plan/intrus', 'lesson/../intrus'])(
  'split : refuse le slug %s avant de créer une proposition',
  async (slug) => {
    t = await startTestDaemon(undefined, {
      config: { memory: MEMORY_CFG({ enabled: true, window: '00:00-23:59' }) },
      memory: {
        chatModel: fixedChatModel(JSON.stringify({ pages: splitPages(slug) })),
        maintenanceScheduleMs: 20,
        backoffMs: [],
      },
    });
    await put(splitSource, splitText);
    await waitFor(() => jobState(splitSource) === 'failed', 5000, 'découpage refusé');
    expect(openProposals()).toEqual([]);
    expect((await getPage(splitSource)).revision).toBe(1);
  },
);

test.each(['occupé', 'répété', 'hors lesson', 'invalide'])(
  'split : slug %s en deuxième position, aucune écriture partielle',
  async (cas) => {
    t = await startTestDaemon();
    await put(splitSource, splitText);
    const secondSlug =
      cas === 'répété'
        ? 'lesson/test/premiere'
        : cas === 'hors lesson'
          ? 'aid/plan/intrus'
          : cas === 'invalide'
            ? 'lesson/../intrus'
            : 'lesson/test/seconde';
    if (cas === 'occupé') await put(secondSlug, 'Contenu à préserver.');
    const sourceBefore = await getPage(splitSource);
    const existingBefore = cas === 'occupé' ? await getPage(secondSlug) : undefined;
    const proposal = new MemoryProposals(t.db).create(
      'split',
      splitSource,
      { pages: splitPages(secondSlug) },
      'Découpage',
    );
    expect((await apply(proposal.id)).statusCode).toBeGreaterThanOrEqual(400);
    expect(
      (await t.d.app.inject({ url: '/api/memory/pages/lesson/test/premiere', headers: t.headers }))
        .statusCode,
    ).toBe(404);
    expect(await getPage(splitSource)).toEqual(sourceBefore);
    if (existingBefore) expect(await getPage(secondSlug)).toEqual(existingBefore);
    expect(openProposals().map((p) => p.id)).toContain(proposal.id);
  },
);

test('split : filtre aussi une proposition créée directement sans filtrage préalable', async () => {
  t = await startTestDaemon();
  await put(splitSource, splitText);
  const proposals = new MemoryProposals(t.db);
  const proposal = proposals.create('split', splitSource, { pages: splitPages() }, 'Découpage');

  expect((await apply(proposal.id)).statusCode).toBe(200);
  expect((await getPage('lesson/test/premiere')).frontmatter).toEqual({
    tags: ['test'],
    title: 'Première',
    issu_de: splitSource,
  });
  expect((await getPage('lesson/test/seconde')).frontmatter).toEqual({
    title: 'Seconde',
    issu_de: splitSource,
  });
  expect(proposals.get(proposal.id)?.state).toBe('applied');
});

test('split : annule la première création si le deuxième put échoue et reste ouverte', async () => {
  t = await startTestDaemon();
  await put(splitSource, splitText);
  const sourceBefore = await getPage(splitSource);
  const proposals = new MemoryProposals(t.db);
  const proposal = proposals.create('split', splitSource, { pages: splitPages() }, 'Découpage');
  const originalPut = MemoryService.prototype.put;
  const putSpy = vi.spyOn(MemoryService.prototype, 'put').mockImplementation(function (
    this: MemoryService,
    ...args: Parameters<MemoryService['put']>
  ) {
    if (args[0] === 'lesson/test/seconde' && args[2].kind === 'create') {
      return Promise.reject(new Error('échec simulé du deuxième put'));
    }
    return originalPut.apply(this, args);
  });
  const removeSpy = vi.spyOn(MemoryService.prototype, 'remove');
  try {
    const response = await apply(proposal.id);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'erreur interne' });
    expect(removeSpy).toHaveBeenCalledExactlyOnceWith(
      'lesson/test/premiere',
      expect.objectContaining({ author: 'maintenance' }),
    );
    for (const { slug } of splitPages()) {
      expect(
        (await t.d.app.inject({ url: `/api/memory/pages/${slug}`, headers: t.headers })).statusCode,
      ).toBe(404);
    }
    expect(await getPage(splitSource)).toEqual(sourceBefore);
    expect(proposals.get(proposal.id)?.state).toBe('open');
  } finally {
    putSpy.mockRestore();
    removeSpy.mockRestore();
  }
});

test.each(['avant insertion', 'après insertion', 'avec retrait en échec'] as const)(
  'split : annule en ordre inverse après un troisième put en échec (%s)',
  async (cas) => {
    t = await startTestDaemon();
    await put(splitSource, splitText);
    const { memory } = t.d;
    const pages = [
      ...splitPages(),
      { slug: 'lesson/test/troisieme', title: 'Troisième', frontmatter: {}, body: 'Suite.' },
    ];
    const propositions = new MemoryProposals(t.db);
    const proposition = propositions.create('split', splitSource, { pages }, 'Découpage');
    const erreur = new Error('échec du troisième put');
    const ecritureOriginale = memory.put.bind(memory);
    vi.spyOn(memory, 'put').mockImplementation(async (...args) => {
      if (args[0] !== 'lesson/test/troisieme') return ecritureOriginale(...args);
      if (cas === 'après insertion') await ecritureOriginale(...args);
      throw erreur;
    });
    const retirer = vi.spyOn(memory, 'remove');
    if (cas === 'avec retrait en échec') {
      retirer.mockRejectedValueOnce(new Error('retrait impossible'));
    }
    const journal = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(applyProposal(proposition, memory)).rejects.toBe(erreur);
      expect(retirer.mock.calls.map(([slug]) => slug)).toEqual([
        ...(cas === 'après insertion' ? ['lesson/test/troisieme'] : []),
        'lesson/test/seconde',
        'lesson/test/premiere',
      ]);
      expect(memory.get('lesson/test/premiere')).toBeUndefined();
      expect(memory.get('lesson/test/troisieme')).toBeUndefined();
      if (cas === 'avec retrait en échec') {
        expect(journal).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining('lesson/test/seconde'),
        );
      } else {
        expect(memory.get('lesson/test/seconde')).toBeUndefined();
      }
    } finally {
      journal.mockRestore();
    }
  },
);

test('split : un échec sur la source laisse la proposition ouverte et réessayable', async () => {
  t = await startTestDaemon();
  await put(splitSource, splitText);
  const { memory } = t.d;
  const pages = splitPages();
  const propositions = new MemoryProposals(t.db);
  const proposition = propositions.create('split', splitSource, { pages }, 'Découpage');
  const ecritureOriginale = memory.put.bind(memory);
  const ecriture = vi.spyOn(memory, 'put').mockImplementation((...args) => {
    if (args[0] === splitSource) return Promise.reject(new Error('réécriture impossible'));
    return ecritureOriginale(...args);
  });
  try {
    expect((await apply(proposition.id)).statusCode).toBe(500);
    for (const { slug } of pages) expect(memory.get(slug)).toBeUndefined();
    expect(propositions.get(proposition.id)?.state).toBe('open');
  } finally {
    ecriture.mockRestore();
  }
  expect((await apply(proposition.id)).statusCode).toBe(200);
  expect(propositions.get(proposition.id)?.state).toBe('applied');
});

test.each([
  splitText,
  splitText.replace('tags: [test]', 'tags: [test]\nremplacee_par: [lesson/test/ancien]'),
])('split : restaure la source après un échec du miroir (%j)', async (original) => {
  t = await startTestDaemon();
  await put(splitSource, original);
  const { memory } = t.d;
  const sourceOriginale = memory.get(splitSource)!;
  const pages = splitPages();
  const propositions = new MemoryProposals(t.db);
  const proposition = propositions.create('split', splitSource, { pages }, 'Découpage');
  const ecritureOriginale = MemoryMirror.prototype.write;
  const ecriture = vi.spyOn(MemoryMirror.prototype, 'write').mockImplementation(function (
    this: MemoryMirror,
    ...args
  ) {
    const replacements = memory.get(splitSource)?.frontmatter.remplacee_par;
    if (
      args[0] === splitSource &&
      Array.isArray(replacements) &&
      replacements.includes(pages[0]!.slug)
    ) {
      return Promise.reject(new Error('miroir de la source indisponible'));
    }
    return ecritureOriginale.apply(this, args);
  });
  try {
    expect((await apply(proposition.id)).statusCode).toBe(500);
    for (const { slug } of pages) expect(memory.get(slug)).toBeUndefined();
    expect(memory.get(splitSource)?.frontmatter).toEqual(sourceOriginale.frontmatter);
    expect(memory.get(splitSource)?.body).toBe(sourceOriginale.body);
    expect(propositions.get(proposition.id)?.state).toBe('open');
  } finally {
    ecriture.mockRestore();
  }
  expect((await apply(proposition.id)).statusCode).toBe(200);
  expect(propositions.get(proposition.id)?.state).toBe('applied');
});

test('split : un conflit de restauration préserve l’écriture concurrente et l’erreur initiale', async () => {
  t = await startTestDaemon();
  await put(splitSource, splitText);
  const { memory } = t.d;
  const pages = splitPages();
  const proposition = new MemoryProposals(t.db).create(
    'split',
    splitSource,
    { pages },
    'Découpage',
  );
  const originalPut = memory.put.bind(memory);
  const error = new Error('miroir de la source indisponible');
  const write = vi.spyOn(memory, 'put').mockImplementation(async (...args) => {
    if (args[0] === splitSource && args[2].kind === 'replace') {
      await originalPut(
        splitSource,
        'texte concurrent',
        { kind: 'force' },
        { author: 'run:tiers' },
      );
    }
    const result = await originalPut(...args);
    if (args[0] === splitSource && args[2].kind === 'force') throw error;
    return result;
  });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(applyProposal(proposition, memory)).rejects.toBe(error);
    expect(memory.get(splitSource)?.body).toBe('texte concurrent');
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(`${splitSource} : Error: revision_conflict`),
    );
    for (const { slug } of pages) expect(memory.get(slug)).toBeUndefined();
  } finally {
    write.mockRestore();
    log.mockRestore();
  }
});

test('split : un conflit de création conserve la page créée par un tiers', async () => {
  t = await startTestDaemon();
  await put(splitSource, splitText);
  const { memory } = t.d;
  const pages = splitPages();
  const concurrentSlug = pages[1]!.slug;
  const proposition = new MemoryProposals(t.db).create(
    'split',
    splitSource,
    { pages },
    'Découpage',
  );
  const originalPut = memory.put.bind(memory);
  const write = vi.spyOn(memory, 'put').mockImplementation(async (...args) => {
    if (args[0] === concurrentSlug && args[2].kind === 'create') {
      await originalPut(concurrentSlug, 'page tierce', { kind: 'create' }, { author: 'run:tiers' });
    }
    return originalPut(...args);
  });
  try {
    await expect(applyProposal(proposition, memory)).rejects.toBeInstanceOf(RevisionConflict);
    expect(memory.get(concurrentSlug)?.body).toBe('page tierce');
    expect(memory.get(pages[0]!.slug)).toBeUndefined();
  } finally {
    write.mockRestore();
  }
});

test('daemon : maxPerNight à 1 reste respecté après plusieurs passages', async () => {
  const memory = MEMORY_CFG({ enabled: true, window: '00:00-23:59' });
  const passages = vi.fn(async () => false);
  t = await startTestDaemon(undefined, {
    config: { memory: { ...memory, maintenance: { ...memory.maintenance, maxPerNight: 1 } } },
    memory: {
      embedder: { model: 'fake', ready: passages, embed: vi.fn() },
      chatModel: fixedChatModel('{"tags":["connu"]}'),
      maintenanceScheduleMs: 20,
      pollMs: 10,
    },
  });
  await put(
    'lesson/test/vocabulaire',
    '---\ntags: [connu]\nentretien_rejete: [duplicate]\n---\nVocabulaire.',
  );
  await put('lesson/test/a', 'contenu a');
  await put('lesson/test/b', 'contenu b');
  await waitFor(() => jobState('lesson/test/a') === 'done', 5000, 'premier entretien terminé');
  const passagesApresJob = passages.mock.calls.length;
  await waitFor(() => passages.mock.calls.length >= passagesApresJob + 3);
  expect(openProposals()).toMatchObject([{ kind: 'tags', slug: 'lesson/test/a' }]);
  expect(
    t.db.prepare("SELECT count(*) AS n FROM memory_jobs WHERE kind = 'maintain'").get(),
  ).toEqual({ n: 1 });
  expect(jobState('lesson/test/b')).toBeUndefined();
});

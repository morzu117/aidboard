import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { parseConfig } from '../src/daemon/config.js';
import { openDb, type Db } from '../src/daemon/db.js';
import { VectorIndex } from '../src/daemon/memory/embed.js';
import { MemoryJobs } from '../src/daemon/memory/jobs.js';
import {
  MemoryProposals,
  runMaintainJob,
  scheduleMaintenance,
} from '../src/daemon/memory/maintain.js';
import { MemoryStore } from '../src/daemon/memory/store.js';

let home: string;
let db: Db;
let store: MemoryStore;
let jobs: MemoryJobs;
let proposals: MemoryProposals;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aid-maintenance-limits-'));
  vi.stubEnv('AID_HOME', home);
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 17, 23));
  db = openDb(join(home, 'state.db'));
  store = new MemoryStore(db);
  jobs = new MemoryJobs(db);
  proposals = new MemoryProposals(db);
});
afterEach(() => {
  db.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});
const put = (slug: string, text = 'contenu') => store.put(slug, text, { kind: 'create' }, 'test');
const schedule = (extra = {}) =>
  scheduleMaintenance(new Date(), {
    db,
    store,
    jobs,
    proposals,
    enabled: true,
    window: '22:00-04:00',
    ...extra,
  });
const model = { chat: vi.fn(async () => '{"tags":["inconnu"]}') };
const log = vi.fn();
const run = (slug: string, extra = {}) =>
  runMaintainJob(
    { id: 'test', kind: 'maintain', slug, attempts: 1 },
    { store, proposals, model, log, ...extra },
  );

test('DM15 : pages cycliques exclues au planning et à l’exécution', async () => {
  put('aid/plan/tache', '---\na_decouper: true\n---\ncontenu');
  expect(schedule()).toBe(0);
  model.chat.mockClear();
  await run('aid/plan/tache');
  expect(model.chat).not.toHaveBeenCalled();
});

test('DM15 : le 21e job reste refusé après minuit, même après exécution et redémarrage', () => {
  for (let i = 0; i < 21; i++) put(`lesson/test/p${i}`, '---\na_decouper: true\n---\ncontenu');
  expect(schedule()).toBe(20);
  db.prepare("UPDATE memory_jobs SET state = 'done'").run();
  vi.setSystemTime(new Date(2026, 10, 18, 1));
  expect(schedule({ jobs: new MemoryJobs(db) })).toBe(0);
  vi.setSystemTime(new Date(2026, 10, 18, 22));
  expect(schedule()).toBe(20);
});

test('DM15 : plafond configurable et jobs embed non comptés', () => {
  put('lesson/test/a', '---\na_decouper: true\n---\ncontenu');
  jobs.enqueue('embed', 'lesson/test/a');
  expect(schedule({ maxPerNight: 1 })).toBe(1);
  expect(schedule({ maxPerNight: 1 })).toBe(0);
});

test('DM15 : vocabulaire vide, aucun appel tags ; vocabulaire relu et tag inconnu refusé', async () => {
  put('lesson/test/a');
  put('aid/plan/vocabulaire', '---\ntags: [inconnu]\n---\ncontenu');
  model.chat.mockClear();
  log.mockClear();
  await run('lesson/test/a');
  expect(model.chat).not.toHaveBeenCalled();
  put('lesson/test/vocabulaire', '---\ntags: [connu]\n---\ncontenu');
  await run('lesson/test/a');
  expect(model.chat).toHaveBeenCalledOnce();
  expect(proposals.list()).toEqual([]);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('inconnu'));
  store.put('lesson/test/a', 'nouvelle révision', { kind: 'append' }, 'test');
  model.chat.mockResolvedValueOnce('{"tags":["connu"]}');
  await run('lesson/test/a');
  expect(proposals.list()[0]?.payload).toEqual({ tags: ['connu'] });
});

test('DM15 : découpage au-delà de 40 lignes non vides, seuil réglable et drapeau prioritaire', () => {
  const text = (n: number, flag = false) =>
    `---\ntags: [test]\nentretien_rejete: [duplicate]\na_decouper: ${flag}\n---\n${'ligne\n\n'.repeat(n)}`;
  put('lesson/test/quarante', text(40));
  expect(schedule()).toBe(0);
  put('lesson/test/quarante-et-une', text(41));
  expect(schedule()).toBe(1);
  expect(schedule({ splitLines: 39 })).toBe(1);
  put('lesson/test/drapeau', text(1, true));
  expect(schedule({ splitLines: 100 })).toBe(1);
});

test('DM15 : défauts et validation des limites de configuration', () => {
  expect(parseConfig('').memory.maintenance).toMatchObject({ maxPerNight: 20, splitLines: 40 });
  for (const key of ['maxPerNight', 'splitLines']) {
    expect(parseConfig(`memory:\n  maintenance:\n    ${key}: 7`).memory.maintenance).toHaveProperty(
      key,
      7,
    );
    for (const value of ['0', '-1', '1.5', 'true', '"2"']) {
      expect(() => parseConfig(`memory:\n  maintenance:\n    ${key}: ${value}`)).toThrow(key);
    }
  }
});

test('sans proposition : persistance, nuit suivante, révision et suppression', async () => {
  put('lesson/test/a', '---\nentretien_rejete: [duplicate]\n---\ncontenu');
  put('lesson/test/vocabulaire', '---\ntags: [connu]\nentretien_rejete: [duplicate]\n---\ncontenu');
  expect(schedule()).toBe(1);
  const job = jobs.claim()!;
  await runMaintainJob(job, { store, proposals, model, log });
  jobs.done(job.id);
  vi.setSystemTime(new Date(2026, 10, 18, 23));
  expect(schedule({ proposals: new MemoryProposals(db) })).toBe(0);
  store.put('lesson/test/a', 'ajout', { kind: 'append' }, 'test');
  expect(schedule()).toBe(1);
  await run('lesson/test/a');
  expect(
    db.prepare('SELECT revision FROM memory_maintenance_seen WHERE slug = ?').get('lesson/test/a'),
  ).toEqual({ revision: 2 });
  store.remove('lesson/test/a');
  expect(
    db.prepare('SELECT * FROM memory_maintenance_seen WHERE slug = ?').all('lesson/test/a'),
  ).toEqual([]);
});

test('tags : changement de vocabulaire à taille constante réactive la page', async () => {
  put('lesson/test/a', '---\nentretien_rejete: [duplicate]\n---\ncontenu');
  put('lesson/test/vocabulaire', '---\ntags: [connu]\nentretien_rejete: [duplicate]\n---\ncontenu');
  await run('lesson/test/a');
  expect(schedule()).toBe(0);
  store.put(
    'lesson/test/vocabulaire',
    '---\ntags: [inconnu]\nentretien_rejete: [duplicate]\n---\ncontenu',
    { kind: 'force' },
    'test',
  );
  expect(schedule()).toBe(1);
  await run('lesson/test/a');
  expect(proposals.list()[0]?.payload).toEqual({ tags: ['inconnu'] });
});

test('doublon sans candidat : le job terminé ne consomme plus le plafond', async () => {
  put('lesson/test/a');
  const vectors = VectorIndex.load(db, () => {})!;
  vectors.ensureTable('fake', 2);
  vectors.upsert('lesson/test/a', new Float32Array([1, 0]));
  await run('lesson/test/a', { vectors });
  expect(schedule({ vectors })).toBe(0);
});

test.each([false, true])(
  'une page longue sans vecteur atteint le découpage (index présent : %s)',
  async (indexPresent) => {
    const vectors = indexPresent ? VectorIndex.load(db, () => {})! : undefined;
    vectors?.ensureTable('fake', 2);
    const source = 'lesson/test/a';
    put(source, '---\ntags: [connu]\n---\nun\ndeux\ntrois');
    const chat = vi.fn(async () =>
      JSON.stringify({
        pages: [
          { slug: 'lesson/test/b', title: 'B', frontmatter: {}, body: 'B' },
          { slug: 'lesson/test/c', title: 'C', frontmatter: {}, body: 'C' },
        ],
      }),
    );
    expect(schedule({ vectors, splitLines: 2 })).toBe(1);
    const job = jobs.claim()!;
    expect(job.slug).toBe(source);
    await runMaintainJob(job, { store, proposals, vectors, splitLines: 2, model: { chat }, log });
    expect(chat).toHaveBeenCalledOnce();
    expect(proposals.list()).toMatchObject([{ kind: 'split', slug: source }]);
  },
);

test('sans vecteur : aucun job vide, puis doublon éligible dès que le vecteur arrive', async () => {
  const source = 'lesson/test/a';
  put(source);
  const vectors = VectorIndex.load(db, () => {})!;
  vectors.ensureTable('fake', 2);
  const options = { vectors, maxPerNight: 1 };
  expect(schedule(options)).toBe(0);
  vi.setSystemTime(new Date(2026, 10, 17, 23, 1));
  expect(schedule(options)).toBe(0);
  expect(jobs.countCreatedSince('maintain', new Date(2026, 10, 17, 22).toISOString())).toBe(0);

  vectors.upsert(source, new Float32Array([1, 0]));
  expect(schedule(options)).toBe(1);
  const job = jobs.claim()!;
  expect(job.slug).toBe(source);
  await runMaintainJob(job, { store, proposals, vectors, model, log });
  expect(proposals.seen(store.get(source)!, 'duplicate', '0.15')).toBe(true);
});

test('échec du modèle : aucun résultat sans proposition mémorisé', async () => {
  put('lesson/test/a');
  put('lesson/test/vocabulaire', '---\ntags: [connu]\n---\ncontenu');
  await expect(run('lesson/test/a', { model: { chat: async () => 'invalide' } })).rejects.toThrow(
    'JSON invalide',
  );
  expect(db.prepare('SELECT * FROM memory_maintenance_seen').all()).toEqual([]);
});

test.each([1, 5])('découpage : une réponse de %i page(s) est rejetée', async (nombre) => {
  const source = 'lesson/test/a';
  put(source, '---\nentretien_rejete: [duplicate]\na_decouper: true\n---\ncontenu');
  const pages = Array.from({ length: nombre }, (_, i) => ({
    slug: `lesson/test/partie-${i}`,
    title: 'Partie',
    frontmatter: {},
    body: 'Contenu',
  }));
  await expect(
    run(source, { model: { chat: async () => JSON.stringify({ pages }) } }),
  ).rejects.toThrow('proposition split : forme JSON invalide');
  expect(proposals.list()).toEqual([]);
  expect(store.list('lesson/')).toEqual([source]);
});

test('découpage sans proposition : la page ne revient pas la nuit suivante', async () => {
  put(
    'lesson/test/a',
    '---\ntags: [connu]\nentretien_rejete: [duplicate]\na_decouper: true\n---\ncontenu',
  );
  await run('lesson/test/a', { model: { chat: async () => '{"pages":[]}' } });
  vi.setSystemTime(new Date(2026, 10, 18, 23));
  expect(schedule()).toBe(0);
  expect(proposals.list()).toEqual([]);
  expect(store.list('lesson/')).toEqual(['lesson/test/a']);
});

test('DM16 : claim sans embeddings prend maintain sans consommer la tentative embed', () => {
  const embed = jobs.enqueue('embed', 'lesson/test/a')!;
  const maintain = jobs.enqueue('maintain', 'lesson/test/a')!;
  expect(jobs.claim(undefined, false)).toMatchObject({ id: maintain, kind: 'maintain' });
  expect(jobs.get(embed)).toMatchObject({ state: 'pending', attempts: 0 });
});

test('DM16 : enqueue reprend un échec seulement sur demande, sans doubler le job en attente', () => {
  const id = jobs.enqueue('embed', 'lesson/test/a')!;
  jobs.claim();
  jobs.fail(id, 'panne', null);
  expect(jobs.enqueue('embed', 'lesson/test/a')).toBeNull();
  expect(jobs.get(id)).toMatchObject({ state: 'failed', attempts: 1 });
  expect(jobs.enqueue('embed', 'lesson/test/a', true)).toBe(id);
  expect(jobs.enqueue('embed', 'lesson/test/a')).toBeNull();
  expect(jobs.get(id)).toEqual({ state: 'pending', attempts: 0, error: null });
});

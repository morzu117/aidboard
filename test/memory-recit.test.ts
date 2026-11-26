import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openDb } from '../src/daemon/db.js';
import { EventStore } from '../src/daemon/events/store.js';
import { assembleCycleRecit, loadCycleInput } from '../src/daemon/memory/recit.js';
import { MemoryStore } from '../src/daemon/memory/store.js';
import type { AidEvent } from '../src/shared/events.js';
import type { MemoryPage } from '../src/shared/memory.js';

const createdAt = '2026-01-01T00:00:00Z';
const topic = {
  id: 's',
  slug: 'cycle',
  title: 'Cycle exemple',
  createdAt,
  state: 'merged',
} as const;
const namespace = 'exemple';
const fauxJeton = 'ghp_' + 'a'.repeat(36);
const page = (phase: string, body = 'Contenu de la page'): MemoryPage => ({
  slug: `${namespace}/${phase}/cycle`,
  namespace,
  title: phase,
  body,
  closed: false,
  frontmatter: {},
  revision: 1,
  author: 'agent',
  createdAt,
  updatedAt: createdAt,
});
const evenement = (
  type: AidEvent['type'],
  data: AidEvent['data'] = {},
  ts = '2026-01-01T00:01:00Z',
): AidEvent => ({ v: 1, id: type, source: 'daemon', type, data, ts });
const action = (action: string, result: unknown = {}) =>
  evenement('action.finished', { action, outcome: 'succeeded', exitCode: 0, result });

test('assemble les phases, les issues des actions, les reprises et la durée jusqu’au merge', () => {
  const resultat = assembleCycleRecit({
    topic,
    namespace,
    pages: [page('review'), page('plan'), page('dev-handoff')],
    events: [
      action('topic.test'),
      evenement('agent.resumed'),
      evenement('topic.state', { state: 'merged' }),
      action('topic.merge'),
      evenement('topic.state', { state: 'archived' }, '2026-01-02T00:00:00Z'),
    ],
  });
  expect(resultat).toMatchObject({
    ok: true,
    sources: {
      pages: ['exemple/plan/cycle', 'exemple/dev-handoff/cycle', 'exemple/review/cycle'],
      actions: 2,
      reprises: 1,
    },
  });
  if (!resultat.ok) throw new Error('Récit attendu');
  expect(resultat.recit).toMatch(
    /## exemple\/plan\/cycle[\s\S]*## exemple\/dev-handoff\/cycle[\s\S]*## exemple\/review\/cycle/,
  );
  expect(resultat.recit).toContain('# cycle — Cycle exemple');
  expect(resultat.recit).toContain('Durée du cycle : 60 s');
  expect(resultat.recit).toContain('1 reprise');
  expect(resultat.recit).toContain('- topic.test — succeeded (code de sortie 0)');
  expect(resultat.recit).toContain('- topic.merge — succeeded (code de sortie 0)');
});

test('un cycle avec des actions et sans pages est vide', () => {
  expect(
    assembleCycleRecit({ topic, namespace, pages: [], events: [action('topic.test')] }),
  ).toEqual({ ok: false, raison: 'vide' });
});

test('exclut le texte des événements techniques et le résultat du script', () => {
  const resultat = assembleCycleRecit({
    topic,
    namespace,
    pages: [page('plan')],
    events: [
      evenement('agent.tool', { label: fauxJeton }),
      evenement('agent.status', { message: 'MESSAGE_REPERABLE' }),
      action('topic.test', { stdout: 'RESULTAT_REPERABLE' }),
    ],
  });
  expect(resultat.ok).toBe(true);
  const retour = JSON.stringify(resultat);
  for (const texte of [fauxJeton, 'MESSAGE_REPERABLE', 'RESULTAT_REPERABLE'])
    expect(retour).not.toContain(texte);
});

test('un refus rend seulement la classe du filtre', () => {
  const resultat = assembleCycleRecit({
    topic,
    namespace,
    pages: [page('plan', `Jeton : ${fauxJeton}`)],
    events: [],
  });
  expect(resultat).toEqual({ ok: false, raison: 'refus', classe: 'ressemble à une clé API' });
  expect(JSON.stringify(resultat)).not.toContain(fauxJeton);
});

test('borne le récit entier et coupe le corps de chaque page à une fin de ligne', () => {
  const maxChars = 500;
  const corps = 'ligne complète ici.\n'.repeat(1000);
  const resultat = assembleCycleRecit(
    {
      topic,
      namespace,
      pages: ['plan', 'dev-handoff', 'review'].map((phase) => page(phase, corps)),
      events: [],
    },
    { maxChars },
  );
  if (!resultat.ok) throw new Error('Récit attendu');
  expect(resultat.recit.length).toBeLessThanOrEqual(maxChars);
  expect(resultat.recit.match(/ligne complète ici\.\n\[…\]/g)).toHaveLength(3);
});

test('marque les pages closes et trie les autres pages par slug', () => {
  const resultat = assembleCycleRecit({
    topic,
    namespace,
    pages: [page('notes-z'), { ...page('review'), closed: true }, page('notes-a')],
    events: [],
  });
  if (!resultat.ok) throw new Error('Récit attendu');
  expect(resultat.recit).toContain('## exemple/review/cycle (close)');
  expect(resultat.sources.pages).toEqual([
    'exemple/review/cycle',
    'exemple/notes-a/cycle',
    'exemple/notes-z/cycle',
  ]);
});

test.each(['espace', null])('charge les pages du sujet avec le namespace %s', (ns) => {
  const aidHome = mkdtempSync(join(tmpdir(), 'aid-recit-'));
  const db = openDb(join(aidHome, 'state.db'));
  try {
    const memory = new MemoryStore(db);
    const store = new EventStore(db);
    db.prepare(
      `INSERT INTO workspaces (id, name, namespace, root, base_branch, worktrees_dir, created_at)
       VALUES ('w', 'exemple', ?, ?, 'main', ?, ?)`,
    ).run(ns, aidHome, aidHome, createdAt);
    db.prepare(
      `INSERT INTO topics (id, workspace_id, slug, title, type, branch, base, worktree, state,
                           index_state, created_at, updated_at)
       VALUES ('s', 'w', 'cycle', 'Cycle exemple', 'feat', 'main', 'main', ?, 'merged', 'disabled', ?, ?)`,
    ).run(aidHome, createdAt, createdAt);
    const prefixe = ns ?? 'exemple';
    const phases = ['plan', 'dev-handoff', 'review'].map((phase) => `${prefixe}/${phase}/cycle`);
    const note = `${prefixe}/notes/cycle`;
    const decision = `${prefixe}/decision/cycle`;
    const supprimee = `${prefixe}/notes/supprimee`;
    const ailleurs = `${prefixe}/notes/ailleurs`;
    for (const slug of [...phases, note, decision, supprimee, ailleurs]) {
      memory.put(slug, 'Contenu', { kind: 'create' }, 'agent');
    }
    const ecrire = (type: AidEvent['type'], slug: string, op?: string) =>
      store.append({
        source: 'daemon',
        topicId: 's',
        type,
        data: { slug, ...(op !== undefined && { op }) },
      });
    const events = [
      ecrire('memory.page', note, 'put'),
      ecrire('memory.page', phases[0]!, 'append'),
      ecrire('memory.decision', decision),
      ecrire('memory.page', supprimee, 'delete'),
      ecrire('memory.page', supprimee, 'rm'),
      ecrire('memory.page', `${prefixe}/notes/absente`, 'put'),
    ];
    store.append({ source: 'daemon', type: 'memory.page', data: { slug: ailleurs, op: 'put' } });
    const input = loadCycleInput({ db, memory, store }, 's');
    expect(input).toMatchObject({ topic, namespace: prefixe, events });
    expect(input?.pages.map(({ slug }) => slug)).toEqual([...phases, note, decision]);
    expect(loadCycleInput({ db, memory, store }, 'absent')).toBeNull();
  } finally {
    db.close();
    rmSync(aidHome, { recursive: true, force: true });
  }
});

test('62.4 : le récit marque les faits candidats et les place après les phases', () => {
  const fait = {
    ...page('fait'),
    slug: 'exemple/fait/cycle.regle',
    frontmatter: { statut: 'candidat' },
  };
  const resultat = assembleCycleRecit({
    topic,
    namespace,
    pages: [page('annexe'), page('review'), fait, page('dev-handoff'), page('plan')],
    events: [],
  });
  if (!resultat.ok) throw new Error('Récit attendu');
  expect(resultat.recit.match(/^## .+$/gm)).toEqual([
    '## exemple/plan/cycle',
    '## exemple/dev-handoff/cycle',
    '## exemple/review/cycle',
    '## exemple/fait/cycle.regle (candidat)',
    '## exemple/annexe/cycle',
  ]);
});

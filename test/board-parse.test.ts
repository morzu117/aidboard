import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  decodeJsonString,
  parseCard,
  parseCards,
  parseGraph,
  parseObligations,
  parseProjects,
  parseThread,
  trustedAuthor,
} from '../src/shared/board.js';

const FIXTURES = join(import.meta.dirname, 'fixtures/board');
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as unknown;

test('projets : champs inconnus ignorés, auteur lu dans la colonne désignée', () => {
  const r = parseProjects(fixture('projects-list'));
  expect(r?.value).toEqual([
    { id: 42, slug: 'projet-test', title: 'Projet de test', status: 'active', author: 'peer-a' },
  ]);
  expect(r?.schemaVersion).toBeNull();
});

test('cartes : résumé, responsable et échéance absents ou présents, obligations ouvertes comptées', () => {
  const r = parseCards(fixture('cards-list-42'));
  expect(r?.value).toEqual([
    {
      id: 101,
      projectId: 42,
      title: 'Carte de test sans responsable',
      stage: 'idea',
      assignee: null,
      dueAt: null,
      openObligations: 0,
    },
    {
      id: 102,
      projectId: 42,
      title: 'Carte de test en construction',
      stage: 'build',
      assignee: 'peer-b',
      dueAt: '2026-11-07T11:00:00+00:00',
      openObligations: 1,
    },
  ]);
});

test('carte : corps brut, liens, historique avec une entrée dérivée du gateway', () => {
  const r = parseCard(fixture('cards-show-102'));
  expect(r?.value.body).toBe('Corps de la carte 102.\n<b>pas du HTML</b>');
  expect(r?.value.author).toBe('peer-a');
  expect(r?.value.links).toEqual({ pr: 'https://github.com/exemple/depot/pull/1' });
  expect(r?.value.stageHistory.map((e) => e.by)).toEqual(['peer-a', 'gateway (ligne 9000)']);
});

test('graphe : étapes dans l’ordre reçu, state en entier, missing et flow.unconfirmed', () => {
  const r = parseGraph(fixture('cards-graph-101'));
  expect(r?.value.steps.map((s) => s.step)).toEqual(['build', 'validate', 'spec-review']);
  expect(r?.value.steps[0]?.state).toMatch(/^unstaffable .* then ask\)$/);
  expect(r?.value.steps[2]?.mandatory).toBe(false);
  expect(r?.value.missing).toEqual(['build', 'validate']);
  expect(r?.value.unconfirmed).toEqual(['build', 'validate']);
  expect(r?.value.stageImplied).toBe('pre-build (graph unfilled)');
});

test('fil : l’auteur vient de credential_author, jamais de claimed_from ; capped à la limite', () => {
  const json = fixture('cards-thread-101');
  const r = parseThread(json, 1000);
  expect(r?.value.messages.map((m) => m.author)).toEqual(['peer-a', 'peer-b']);
  expect(r?.value.messages[1]?.content).toContain('<script>');
  expect(r?.value.capped).toBe(false);
  expect(parseThread(json, 2)?.value.capped).toBe(true);
});

test('obligations : status fait foi, withdrawn + requested est fermée (#1456), truncated remonté', () => {
  const retiree = parseObligations(fixture('obligations-list-101'));
  expect(retiree?.value.obligations[0]).toMatchObject({
    id: 9101,
    status: 'withdrawn',
    state: 'requested',
    closed: true,
    closeOutcome: null,
    closeEvidence: "carte d'idéation, pas de build",
  });
  expect(retiree?.value.truncated).toBe(false);
  const ouverte = parseObligations(fixture('obligations-list-102'));
  expect(ouverte?.value.obligations[0]).toMatchObject({ status: 'open', closed: false });
  expect(ouverte?.value.truncated).toBe(true);
  // fallback_fired reste ouverte
  const ff = parseObligations({ obligations: [{ id: 1, status: 'fallback_fired' }] });
  expect(ff?.value.obligations[0]?.closed).toBe(false);
  // un closed_at resté sur une obligation rouverte ne la ferme pas ; sans status, closed_at décide
  const rouverte = parseObligations({
    obligations: [{ id: 2, status: 'open', closed_at: '2026-11-01T00:00:00Z' }],
  });
  expect(rouverte?.value.obligations[0]?.closed).toBe(false);
  const sansStatus = parseObligations({
    obligations: [{ id: 3, closed_at: '2026-11-01T00:00:00Z' }],
  });
  expect(sansStatus?.value.obligations[0]?.closed).toBe(true);
});

test('JSON dans une chaîne : valide décodé, invalide gardé tel quel', () => {
  const r = parseObligations(fixture('obligations-list-101'));
  expect(r?.value.obligations[0]?.fallbackPolicy).toEqual({ mode: 'escalate', target: 'peer-a' });
  expect(r?.value.obligations[0]?.needsExtra).toEqual([]);
  expect(decodeJsonString('{pas du json')).toBe('{pas du json');
  expect(decodeJsonString(undefined)).toBeNull();
});

test('trusted_author_column : carte, message, colonne absente, claimed_* refusé', () => {
  expect(
    trustedAuthor({ trusted_author_column: 'created_by', created_by: 'peer-a', claimed_by: 'x' }),
  ).toBe('peer-a');
  expect(
    trustedAuthor({
      trusted_author_column: 'credential_author',
      credential_author: 'peer-b',
      claimed_from: 'x',
    }),
  ).toBe('peer-b');
  expect(trustedAuthor({ trusted_author_column: 'created_by' })).toBe('inconnu');
  expect(trustedAuthor({ created_by: 'peer-a' })).toBe('inconnu');
  expect(trustedAuthor({ trusted_author_column: 'claimed_by', claimed_by: 'usurpateur' })).toBe(
    'inconnu',
  );
  expect(trustedAuthor(null)).toBe('inconnu');
});

test('champ absent ou d’un mauvais type : null, sans exception', () => {
  const r = parseCard({
    id: 7,
    title: 42,
    stage: null,
    stage_history: 'pas une liste',
    links: [1, 2],
  });
  expect(r?.value).toMatchObject({
    id: 7,
    title: null,
    stage: null,
    assignee: null,
    body: null,
    author: 'inconnu',
    stageHistory: [],
    links: {},
    openObligations: 0,
  });
  const g = parseGraph({
    steps: [null, 3, { step: 'build', mandatory: 'oui', row: 1.5 }],
    flow: 'x',
  });
  expect(g?.value.steps).toEqual([
    {
      step: 'build',
      mandatory: null,
      state: null,
      holder: null,
      due: null,
      row: null,
      events: [],
      priorRows: 0,
    },
  ]);
  expect(g?.value.unconfirmed).toEqual([]);
});

test('racine illisible : null', () => {
  expect(parseProjects(null)).toBeNull();
  expect(parseProjects({ projects: 'x' })).toBeNull();
  expect(parseCards([])).toBeNull();
  expect(parseCard({ id: 'x' })).toBeNull();
  expect(parseGraph({})).toBeNull();
  expect(parseThread({ messages: {} }, 10)).toBeNull();
  expect(parseObligations('{}')).toBeNull();
});

test('schema_version lu s’il est présent', () => {
  expect(parseProjects({ schema_version: '1', projects: [] })?.schemaVersion).toBe('1');
  expect(parseProjects({ schema_version: 2, projects: [] })?.schemaVersion).toBe('2');
  expect(parseProjects({ projects: [] })?.schemaVersion).toBeNull();
});

test('graphe : ligne objet et événements de la fixture, sans accept ni détail brut', () => {
  const etape = parseGraph(fixture('cards-graph-102'))?.value.steps[0];
  expect(etape?.row).toEqual({
    id: 9000,
    holder: 'peer-b',
    status: 'open',
    createdAt: '2026-11-04T07:00:00Z',
    takenAt: '2026-11-05T07:00:00Z',
    closedAt: null,
    closeOutcome: null,
  });
  expect(etape?.events).toEqual([
    { at: '2026-11-04T07:00:00Z', by: 'peer-a', kind: 'mint', holder: 'peer-b', outcome: null },
    { at: '2026-11-05T07:00:00Z', by: 'peer-b', kind: 'take', holder: null, outcome: null },
    { at: '2026-11-05T08:00:00Z', by: 'peer-a', kind: 'amend', holder: 'peer-a', outcome: null },
    { at: '2026-11-05T09:00:00Z', by: 'peer-a', kind: 'close', holder: null, outcome: 'PASS' },
  ]);
  expect(etape?.priorRows).toBe(2);
});

test('graphe : ligne entière compatible, objets lus champ par champ, autres valeurs refusées', () => {
  const lignes = [
    42,
    {},
    {
      id: '42',
      holder: 3,
      status: false,
      created_at: [],
      taken_at: {},
      closed_at: 'date',
      close_outcome: 'PASS',
    },
    null,
    '42',
    1.5,
    [],
    true,
  ];
  const etapes = parseGraph({ steps: lignes.map((row) => ({ row })) })?.value.steps;
  const vide = {
    id: null,
    holder: null,
    status: null,
    createdAt: null,
    takenAt: null,
    closedAt: null,
    closeOutcome: null,
  };
  expect(etapes?.map((etape) => etape.row)).toEqual([
    { ...vide, id: 42 },
    vide,
    { ...vide, closedAt: 'date', closeOutcome: 'PASS' },
    null,
    null,
    null,
    null,
    null,
  ]);
});

test('graphe : détails défensifs, limite de 200 caractères et kind obligatoire', () => {
  const details = [
    'illisible',
    JSON.stringify({ holder: 'a'.repeat(201), outcome: 'b'.repeat(201) }),
    JSON.stringify({ holder: 'a'.repeat(200), outcome: 'b'.repeat(200), autre: 'ignoré' }),
    'null',
    '[]',
    '42',
    JSON.stringify({ holder: 42, outcome: false }),
    { holder: 'peer-a' },
  ];
  const etape = parseGraph({
    steps: [
      {
        events: [
          ...details.map((detail) => ({ kind: 'inconnu', detail, at: 42, by: false })),
          null,
          {},
          { kind: 42 },
          { kind: '' },
        ],
        prior_rows: [1, 2, null, '3', {}, 1.5],
      },
    ],
  })?.value.steps[0];
  expect(etape?.events).toHaveLength(details.length);
  expect(etape?.events[2]).toEqual({
    at: null,
    by: null,
    kind: 'inconnu',
    holder: 'a'.repeat(200),
    outcome: 'b'.repeat(200),
  });
  expect(etape?.events.filter((_, i) => i !== 2)).toEqual(
    Array.from({ length: details.length - 1 }, () => ({
      at: null,
      by: null,
      kind: 'inconnu',
      holder: null,
      outcome: null,
    })),
  );
  expect(etape?.priorRows).toBe(2);
  expect(
    parseGraph({ steps: [{ events: {}, prior_rows: 'illisible' }] })?.value.steps[0],
  ).toMatchObject({ events: [], priorRows: 0 });
});

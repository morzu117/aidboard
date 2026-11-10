import { expect, test } from 'vitest';
import { parseCard, parseGraph, parseThread } from '../../src/shared/board.js';
import type { BoardCardSheet, BoardResult } from '../../src/shared/board.js';
import { chronologie } from '../../web/src/data/chronologie.js';

const reussite = <T>(data: T): BoardResult<T> => ({
  ok: true,
  data,
  readAt: '2026-11-08T00:00:00Z',
  schemaVersion: null,
});
const echec = { ok: false, kind: 'timeout', readAt: '2026-11-08T00:00:00Z' } as const;
const lectures = (carte = {}, graphe = {}, fil = {}) => ({
  card: reussite(parseCard({ id: 1, ...carte })!.value),
  graph: reussite(parseGraph({ steps: [], ...graphe })!.value),
  thread: reussite(parseThread({ messages: [], ...fil }, 1000)!.value),
});

test('tri décroissant, dates égales, absentes et illisibles, sans mutation', () => {
  const donnees = lectures(
    {
      stage_history: [
        { stage: 'idea', at: null, by: 'peer-a' },
        { stage: 'build', at: '2026-11-05T07:00:00.123456+00:00', by: 'peer-a' },
      ],
    },
    {
      steps: [
        {
          step: 'build',
          events: [
            { kind: 'take', at: '2026-11-05T07:00:00.123456+00:00' },
            { kind: 'amend', at: 'illisible' },
          ],
        },
      ],
    },
    {
      messages: [
        { id: 1, content: 'récent', created_at: '2026-11-06T00:00:00Z' },
        { id: 2, content: 'égal', created_at: '2026-11-05T07:00:00.123456+00:00' },
        { id: 3, content: 'sans date' },
      ],
    },
  );
  const avant = structuredClone(donnees);
  const resultat = chronologie(donnees);
  expect(resultat.entrees.map((e) => e.cle)).toEqual([
    'fil-1-0',
    'fil-2-1',
    'obligation-0-0',
    'etape-1',
    'fil-3-2',
    'obligation-0-1',
    'etape-0',
  ]);
  expect(new Set(resultat.entrees.map((e) => e.cle)).size).toBe(7);
  expect(donnees).toEqual(avant);
});

test('phrases des étapes et entrée déduite par le gateway', () => {
  const resultat = chronologie(
    lectures({
      stage_history: [
        { stage: 'idea', by: 'peer-a' },
        { stage: 'build', by: 'gateway', derived: true, row: 42 },
        {},
      ],
    }),
  );
  expect(resultat.entrees.map((e) => e.texte)).toEqual([
    'Étape → inconnu',
    'Étape → build (déduite par le gateway, ligne 42)',
    'Étape → idea',
  ]);
  expect(resultat.entrees[2]).toMatchObject({ auteur: 'peer-a', source: 'etape', date: null });
});

test.each([
  ['mint', 'ouverte pour peer-b'],
  ['take', 'prise'],
  ['amend', 'modifiée'],
  ['close', 'fermée : PASS'],
  ['decline', 'déclinée'],
  ['reassign', 'réattribuée à peer-b'],
  ['fallback', ': échéance passée'],
  ['withdraw', 'retirée'],
  ['release', 'rendue'],
  ['futur', ': événement futur'],
])('phrase de l’événement %s', (kind, phrase) => {
  const resultat = chronologie(
    lectures(
      {},
      {
        steps: [
          {
            step: 'build',
            events: [
              {
                kind,
                by: 'peer-a',
                detail: JSON.stringify({ holder: 'peer-b', outcome: 'PASS' }),
              },
            ],
          },
        ],
      },
    ),
  );
  expect(resultat.entrees).toEqual([
    {
      cle: 'obligation-0-0',
      date: null,
      source: 'obligation',
      auteur: 'peer-a',
      texte: `Obligation build ${phrase}`,
    },
  ]);
});

test('champs absents : compléments omis et auteur inconnu', () => {
  const resultat = chronologie(
    lectures({}, { steps: [{ events: ['mint', 'close', 'reassign'].map((kind) => ({ kind })) }] }),
  );
  expect(resultat.entrees.map((e) => e.texte)).toEqual([
    'Obligation inconnu réattribuée',
    'Obligation inconnu fermée',
    'Obligation inconnu ouverte',
  ]);
  expect(resultat.entrees.every((e) => e.auteur === 'inconnu')).toBe(true);
});

test.each([0, 139, 140, 141])('fil : coupe à 140 caractères, longueur %i', (longueur) => {
  const resultat = chronologie(
    lectures(
      {},
      {},
      {
        messages: [
          {
            id: 1,
            content: 'a'.repeat(longueur),
            credential_author: 'peer-b',
            trusted_author_column: 'credential_author',
          },
        ],
      },
    ),
  );
  expect(resultat.entrees[0]).toMatchObject({
    source: 'fil',
    auteur: 'peer-b',
    texte: 'a'.repeat(Math.min(140, longueur)) + (longueur > 140 ? '…' : ''),
  });
});

test('limites : fil plafonné et somme des lignes antérieures, sans inventer d’événement', () => {
  const donnees = lectures({}, { steps: [{ prior_rows: [1, 2] }, { prior_rows: [3] }] });
  donnees.thread = reussite({ messages: [], capped: true });
  expect(chronologie(donnees)).toEqual({
    entrees: [],
    limites: [{ lignesAnterieures: 3 }, 'fil-limite'],
  });
  expect(chronologie(lectures())).toEqual({ entrees: [], limites: [] });
});

test.each([
  ['card', 'etapes', 'etape'],
  ['graph', 'obligations', 'obligation'],
  ['thread', 'fil', 'fil'],
] as const)('échec de %s : les autres sources restent présentes', (lecture, limite, source) => {
  const donnees: Pick<BoardCardSheet, 'card' | 'graph' | 'thread'> = lectures(
    { stage_history: [{ stage: 'build' }] },
    { steps: [{ events: [{ kind: 'take' }] }] },
    { messages: [{ id: 1, content: 'message' }] },
  );
  donnees[lecture] = echec;
  const resultat = chronologie(donnees);
  expect(resultat.limites).toEqual([{ 'non-lu': limite }]);
  expect(resultat.entrees).toHaveLength(2);
  expect(resultat.entrees.every((e) => e.source !== source)).toBe(true);
});

test('trois lectures en échec : toutes les limites', () => {
  expect(chronologie({ card: echec, graph: echec, thread: echec })).toEqual({
    entrees: [],
    limites: [{ 'non-lu': 'etapes' }, { 'non-lu': 'obligations' }, { 'non-lu': 'fil' }],
  });
});

test('même milliseconde : fractions précises puis réception inverse, y compris les zéros finaux', () => {
  const dates = [
    '2026-11-05T07:00:00.123456Z',
    '2026-11-05T07:00:00.123457Z',
    '2026-11-05T07:00:00.123455Z',
    '2026-11-05T07:00:00.1234560Z',
    '2026-11-05T07:00:00.123Z',
    '2026-11-05T08:00:00.123000+01:00',
    '2026-11-05T07:00:00.1234560001Z',
  ];
  const donnees = lectures(
    {},
    {
      steps: [{ events: dates.map((at) => ({ kind: 'amend', at })) }],
    },
  );
  const attendu = [1, 6, 3, 0, 2, 5, 4].map((indice) => `obligation-0-${indice}`);
  expect(chronologie(donnees).entrees.map((e) => e.cle)).toEqual(attendu);
  expect(chronologie(donnees).entrees.map((e) => e.cle)).toEqual(attendu);
});

test.each(['Z', '+00:00', ''])(
  'fractions nulles, précision variable et date sans fraction (fuseau %j)',
  (fuseau) => {
    const dates = ['', '.0000001', '.00000010', '.00000009', '.000'].map(
      (fraction) => `2026-11-05T07:00:00${fraction}${fuseau}`,
    );
    const resultat = chronologie(
      lectures({}, { steps: [{ events: dates.map((at) => ({ kind: 'amend', at })) }] }),
    );
    expect(resultat.entrees.map((e) => e.cle)).toEqual(
      [2, 1, 3, 4, 0].map((indice) => `obligation-0-${indice}`),
    );
  },
);

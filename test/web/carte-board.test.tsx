// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, expect, test } from 'vitest';
import {
  type BoardCardSheet,
  type BoardResult,
  parseCard,
  parseGraph,
  parseObligations,
  parseThread,
} from '../../src/shared/board.js';
import type { MeshState } from '../../src/shared/model.js';
import { CarteBoard } from '../../web/src/ecrans/CarteBoard.js';
import { FakeSocket, json, setup, snapshot } from './helpers.js';

// 24.8 : la fiche, bâtie sur les fixtures synthétiques passées par les vrais parseurs.

afterEach(cleanup);
const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement | null;
const ligne = (id: string) => node(id) as HTMLTableRowElement;

const BOARD = join(import.meta.dirname, '..', 'fixtures', 'board');
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(BOARD, `${name}.json`), 'utf8')) as unknown;
const READ_AT = new Date().toISOString();
const ok = <T,>(p: { value: T } | null): BoardResult<T> => ({
  ok: true,
  data: p!.value,
  readAt: READ_AT,
  schemaVersion: null,
});
const fiche = (id: 101 | 102): BoardCardSheet => ({
  card: ok(parseCard(fixture(`cards-show-${id}`))),
  graph: ok(parseGraph(fixture(`cards-graph-${id}`))),
  thread: ok(parseThread(fixture(`cards-thread-${id}`), 1000)),
  obligations: ok(parseObligations(fixture(`obligations-list-${id}`))),
});

const meshEtat: MeshState = {
  connected: true,
  tailscale: 'running',
  monitor: 'running',
  pending: 0,
  since: null,
  cell: 'morzu-mac',
};
const avecMesh = snapshot({ mesh: { state: meshEtat, inbox: [], tailscaleManage: false } });
const NAV = { 'GET /api/nav': json(200, { groups: [], placements: [], prefs: { reduit: false } }) };

async function ouvrir(route: string, sheets: Record<string, BoardCardSheet>, state = avecMesh) {
  const routes = Object.fromEntries(
    Object.entries(sheets).map(([id, s]) => [`GET /api/board/cards/${id}`, json(200, s)]),
  );
  const h = setup(
    <Routes>
      <Route path="/" element={<p>accueil</p>} />
      <Route path="/board" element={<p>board</p>} />
      <Route path="/board/cartes/:cardId" element={<CarteBoard />} />
    </Routes>,
    state,
    route,
    { ...NAV, ...routes },
  );
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  act(() => FakeSocket.all[0]!.open());
  return h;
}

test('carte 101 : corps brut, graphe complet, obligation retirée fermée, fil en texte brut', async () => {
  await ouvrir('/board/cartes/101', { 101: fiche(101) });
  await waitFor(() => expect(node('carte-board.corps.texte')).not.toBeNull());
  expect(node('carte-board.titre')!.textContent).toBe('Carte de test sans responsable');
  // le fil d'Ariane ramène au projet de la carte
  expect(node('carte-board.retour')!.getAttribute('href')).toBe('/board?projet=42');
  expect(node('carte-board.meta')!.textContent).toContain('sans responsable');
  expect(node('carte-board.meta')!.textContent).toContain('sans échéance');
  // corps : texte brut
  const corps = node('carte-board.corps.texte')!;
  expect(corps.querySelector('b')).toBeNull();
  expect(corps.textContent).toContain('<b>pas du HTML</b>');
  // graphe : ordre reçu, state en entier
  const etapes = [0, 1, 2].map((i) => ligne(`carte-board.graphe.etape-${i}`).cells[0]!.textContent);
  expect(etapes).toEqual(['build', 'validate', 'spec-review']);
  expect(node('carte-board.graphe.etape-0')!.textContent).toMatch(/unstaffable .* then ask\)/);
  expect(node('carte-board.graphe.manque')!.textContent).toBe('build, validate');
  expect(node('carte-board.graphe.non-confirme')!.textContent).toBe('build, validate');
  expect(node('carte-board.graphe.deduite')!.textContent).toBe('pre-build (graph unfilled)');
  // obligation withdrawn + requested : fermée, preuve « — » sans close_outcome
  const o = ligne('carte-board.obligation-9101');
  const cells = [...o.cells].map((c) => c.textContent);
  expect(cells[3]).toBe('withdrawn');
  expect(cells[4]).toBe('requested');
  expect(cells[5]).toMatch(/^oui/);
  expect(cells[6]).toBe('—');
  expect(node('carte-board.obligations.tronquee')).toBeNull();
  // fil : auteur de credential_author, contenu jamais interprété
  const fil = document.querySelector('.carte-board-fil')!;
  expect(fil.querySelector('script')).toBeNull();
  expect(fil.textContent).toContain('<script>');
  expect([...fil.querySelectorAll('.carte-board-auteur')].map((e) => e.textContent)).toEqual([
    'peer-a',
    'peer-b',
  ]);
  expect(node('carte-board.fil.limite')).toBeNull();
  expect(node('carte-board.pastille')!.textContent).toMatch(/Board lu il y a/);
  // lecture seule
  expect(
    document.querySelector('.carte-board textarea, .carte-board input:not([type=checkbox])'),
  ).toBeNull();
  expect(screen.queryByText(/Prendre|Commenter/)).toBeNull();
});

test('carte 102 : liste tronquée, entrée dérivée « gateway (ligne N) », lien GitHub', async () => {
  await ouvrir('/board/cartes/102', { 102: fiche(102) });
  await waitFor(() => expect(node('carte-board.obligations.tronquee')).not.toBeNull());
  expect(node('carte-board.obligations.tronquee')!.textContent).toBe('Liste tronquée par le board');
  expect(node('carte-board.chronologie')!.textContent).toContain('gateway (ligne 9000)');
  const pr = node('carte-board.lien-pr')!.querySelector('a')!;
  expect(pr.getAttribute('href')).toBe('https://github.com/exemple/depot/pull/1');
  expect(pr.getAttribute('rel')).toContain('noopener');
});

test('fil plafonné : « Fil limité à 1000 messages »', async () => {
  const s = fiche(101);
  await ouvrir('/board/cartes/101', {
    101: {
      ...s,
      thread: { ...s.thread, ...(s.thread.ok && { data: { ...s.thread.data, capped: true } }) },
    },
  });
  await waitFor(() => expect(node('carte-board.fil.limite')).not.toBeNull());
  expect(node('carte-board.fil.limite')!.textContent).toBe('Fil limité à 1000 messages');
});

test('une partie en échec affiche son message à sa place, le reste s’affiche', async () => {
  const s = fiche(102);
  await ouvrir('/board/cartes/102', {
    102: { ...s, graph: { ok: false, kind: 'forbidden', readAt: READ_AT } },
  });
  await waitFor(() => expect(node('carte-board.graphe.message')).not.toBeNull());
  expect(node('carte-board.graphe.message')!.textContent).toContain(
    'Tu ne peux pas lire cette carte',
  );
  expect(node('carte-board.graphe.message.retour')!.getAttribute('href')).toBe('/board');
  expect(node('carte-board.corps.texte')).not.toBeNull();
  expect(node('carte-board.obligations.tronquee')).not.toBeNull();
});

test('carte inexistante (404) : « Cette carte n’existe pas », retour au board, pas de Relire', async () => {
  const absente: BoardResult<never> = { ok: false, kind: 'not-found', readAt: READ_AT };
  await ouvrir('/board/cartes/103', {
    103: { card: absente, graph: absente, thread: absente, obligations: absente },
  });
  await waitFor(() => expect(node('carte-board.corps.message')).not.toBeNull());
  expect(node('carte-board.corps.message')!.textContent).toContain('Cette carte n’existe pas');
  expect(node('carte-board.corps.message.retour')!.getAttribute('href')).toBe('/board');
  expect(node('carte-board.corps.message.relire')).toBeNull();
});

test('lien d’un pair hors GitHub : affiché en texte, jamais cliquable', async () => {
  const s = fiche(102);
  const card = s.card.ok
    ? {
        ...s.card,
        data: { ...s.card.data, links: { pr: 'javascript:alert(1)', doc: 'http://exemple.test' } },
      }
    : s.card;
  await ouvrir('/board/cartes/102', { 102: { ...s, card } });
  await waitFor(() => expect(node('carte-board.lien-pr')).not.toBeNull());
  expect(document.querySelector('.carte-board-liens a')).toBeNull();
  expect(node('carte-board.lien-pr')!.textContent).toContain('javascript:alert(1)');
});

test('identifiant invalide : retour au board ; sans mesh : retour à l’accueil', async () => {
  await ouvrir('/board/cartes/abc', {});
  await screen.findByText('board');
  cleanup();
  await ouvrir('/board/cartes/101', {}, snapshot());
  await screen.findByText('accueil');
});

test('D110 : la carte ne se lit pas (gateway muet) : « Board indisponible » ; une partie refusée n’en a pas', async () => {
  const s = fiche(101);
  const h = await ouvrir('/board/cartes/101', {
    101: { ...s, card: { ok: false, kind: 'unreachable', readAt: READ_AT } },
  });
  await waitFor(() => expect(node('carte-board.bandeau')).not.toBeNull());
  expect(node('carte-board.bandeau.constat')!.textContent).toBe('Board indisponible');
  h.respond.set('GET /api/board/cards/101?fresh=1', json(200, s));
  fireEvent.click(node('carte-board.bandeau.action')!);
  await waitFor(() => expect(node('carte-board.bandeau')).toBeNull());
  expect(h.calls.some((c) => c.url === '/api/board/cards/101?fresh=1')).toBe(true);
  cleanup();
  await ouvrir('/board/cartes/101', {
    101: { ...s, graph: { ok: false, kind: 'unreachable', readAt: READ_AT } },
  });
  await waitFor(() => expect(node('carte-board.graphe.message')).not.toBeNull());
  expect(node('carte-board.bandeau')).toBeNull();
});

const entreesChronologie = () => [...node('carte-board.chronologie')!.querySelectorAll('li')];

function ficheChronologie() {
  const s = fiche(102);
  if (!s.card.ok || !s.graph.ok || !s.thread.ok) throw new Error('Fixture illisible');
  s.card.data.stageHistory = [{ stage: 'build', by: 'peer-a', at: '2026-01-01T10:00:00Z' }];
  s.graph.data.steps = [
    {
      ...s.graph.data.steps[0]!,
      priorRows: 3,
      events: [
        { at: '2026-01-02T10:00:00Z', by: 'peer-b', kind: 'take', holder: null, outcome: null },
      ],
    },
  ];
  s.thread.data.messages = [
    {
      ...s.thread.data.messages[0]!,
      author: 'peer-c',
      createdAt: '2026-01-03T10:00:00Z',
      content: '<img src=x onerror=alert(1)>',
    },
  ];
  s.thread.data.capped = true;
  return s;
}

test('chronologie : ordre décroissant, date complète et message en texte brut', async () => {
  await ouvrir('/board/cartes/102', { 102: ficheChronologie() });
  await waitFor(() => expect(entreesChronologie()).toHaveLength(3));
  const entrees = entreesChronologie();
  expect(entrees.map((e) => e.querySelector('.carte-board-auteur')!.textContent)).toEqual([
    'peer-c',
    'peer-b',
    'peer-a',
  ]);
  expect(entrees[0]!.querySelector('[title]')!.getAttribute('title')).toBe('2026-01-03T10:00:00Z');
  expect(entrees[0]!.textContent).toContain('2026-01-03 10:00');
  expect(entrees[0]!.textContent).toContain('<img src=x onerror=alert(1)>');
  expect(document.querySelector('img')).toBeNull();
});

test('chronologie : les trois filtres sont cochés et masquent chacun leur source', async () => {
  await ouvrir('/board/cartes/102', { 102: ficheChronologie() });
  await waitFor(() => expect(entreesChronologie()).toHaveLength(3));
  for (const [source, auteur] of [
    ['etape', 'peer-a'],
    ['obligation', 'peer-b'],
    ['fil', 'peer-c'],
  ]) {
    const filtre = node(`carte-board.chronologie.filtre-${source}`) as HTMLInputElement;
    expect(filtre.checked).toBe(true);
    fireEvent.click(filtre);
    expect(entreesChronologie()).toHaveLength(2);
    expect(
      entreesChronologie()
        .map((e) => e.textContent)
        .join(''),
    ).not.toContain(auteur);
    fireEvent.click(filtre);
    expect(entreesChronologie()).toHaveLength(3);
  }
});

test('chronologie : limites du fil et des lignes antérieures', async () => {
  await ouvrir('/board/cartes/102', { 102: ficheChronologie() });
  await waitFor(() => expect(node('carte-board.chronologie.limites')).not.toBeNull());
  expect(node('carte-board.chronologie.limites')!.textContent).toContain(
    'Fil limité à 1000 messages : la chronologie peut être incomplète',
  );
  expect(node('carte-board.chronologie.limites')!.textContent).toContain(
    '3 lignes antérieures, sans leurs événements',
  );
});

test('chronologie : un fil non lu garde les étapes et obligations', async () => {
  const s = ficheChronologie();
  s.thread = { ok: false, kind: 'unreachable', readAt: READ_AT };
  await ouvrir('/board/cartes/102', { 102: s });
  await waitFor(() => expect(entreesChronologie()).toHaveLength(2));
  expect(entreesChronologie()[0]!.textContent).toContain('Obligation');
  expect(entreesChronologie()[1]!.textContent).toContain('Étape → build');
  expect(node('carte-board.chronologie.limites')!.textContent).toContain('Fil non lu');
});

test('chronologie : limites des étapes et obligations non lues', async () => {
  const s = ficheChronologie();
  s.card = { ok: false, kind: 'forbidden', readAt: READ_AT };
  s.graph = { ok: false, kind: 'forbidden', readAt: READ_AT };
  await ouvrir('/board/cartes/102', { 102: s });
  await waitFor(() => expect(entreesChronologie()).toHaveLength(1));
  expect(node('carte-board.chronologie.limites')!.textContent).toContain('Étapes non lues');
  expect(node('carte-board.chronologie.limites')!.textContent).toContain('Obligations non lues');
});

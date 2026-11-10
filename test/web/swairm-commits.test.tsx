// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { AidClient } from '../../web/src/data/client.js';
import { AidProvider } from '../../web/src/data/useAidState.js';
import { Contenu } from '../../web/src/ecrans/CarteBoard.js';
import { parseCard, parseGraph, parseThread, parseObligations } from '../../src/shared/board.js';
import type { LecturePrSwairm } from '../../src/shared/swairm-trailers.js';
import { FakeSocket, json, setup, snapshot } from './helpers.js';

const ok = <T,>(data: T) => ({ ok: true, data, readAt: '2026-11-11', schemaVersion: null });
const fiche = {
  card: ok(parseCard({ id: 1, body: 'Swairm: exemple/depot#feat/exemple' })!.value),
  graph: ok(parseGraph({ steps: [] })!.value),
  thread: ok(parseThread({ messages: [] }, 1000)!.value),
  obligations: ok(parseObligations({ obligations: [] })!.value),
};
const lecture: LecturePrSwairm = {
  etat: 'ok',
  pr: { number: 7, state: 'OPEN', url: 'https://github.com/exemple/depot/pull/7' },
  commits: [
    {
      sha: 'abcdef0123456789',
      date: '2026-11-11T09:00:00Z',
      step: '<b>s1</b>',
      proof: 'passed',
      attempt: 2,
      drone: null,
    },
  ],
};
const node = (id: string) => document.querySelector(`[data-node="${id}"]`);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
async function ouvrir(reponse: LecturePrSwairm | null = lecture) {
  const h = setup(<Contenu cardId={1} />, snapshot(), '/', {
    'GET /api/board/cards/1': json(200, fiche),
    'GET /api/swairm/board/1/commits': json(reponse ? 200 : 404, reponse ?? {}),
  });
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  act(() => FakeSocket.all[0]!.open());
  await waitFor(() => expect(node('carte-board.chronologie')).not.toBeNull());
  return h;
}

test('case Commits cochée, filtre, sha court, auteur inconnu et texte brut, pied PR', async () => {
  await ouvrir();
  const caseCommits = node('carte-board.chronologie.filtre-commit') as HTMLInputElement;
  expect(caseCommits.checked).toBe(true);
  expect(screen.getByText('Pas <b>s1</b> prouvé (passed), essai 2 · abcdef0')).toBeTruthy();
  expect(node('carte-board.chronologie')?.querySelector('b')).toBeNull();
  expect(screen.getByText('inconnu')).toBeTruthy();
  expect(screen.getByText(/PR #7 \(ouverte\)/)).toBeTruthy();
  expect(screen.getByRole('link', { name: lecture.pr!.url })).toHaveProperty(
    'href',
    lecture.pr!.url,
  );
  fireEvent.click(caseCommits);
  expect(screen.queryByText(/Pas <b>s1/)).toBeNull();
  fireEvent.click(caseCommits);
  expect(screen.getByText(/Pas <b>s1/)).toBeTruthy();
});

test('lecture à l’ouverture seulement, ni Relire ni focus ni minuteur ne relisent la PR', async () => {
  const h = await ouvrir();
  const nombre = () => h.calls.filter((c) => c.url === '/api/swairm/board/1/commits').length;
  expect(nombre()).toBe(1);
  fireEvent.click(node('carte-board.relire')!);
  vi.useFakeTimers();
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(120000);
  });
  expect(nombre()).toBe(1);
});

test('carte sans lien : aucune case Commits ; erreur PR non bloquante sur une carte reliée', async () => {
  await ouvrir(null);
  expect(node('carte-board.chronologie.filtre-commit')).toBeNull();
  cleanup();
  await ouvrir({ etat: 'non-lu', raison: 'gh absent', pr: null, commits: [] });
  expect(screen.getByText('PR non lue : gh absent')).toBeTruthy();
  expect(node('carte-board.chronologie.filtre-commit')).not.toBeNull();
});

test('URL hors GitHub non cliquable et drone affiché en texte brut', async () => {
  await ouvrir({
    ...lecture,
    pr: { number: 7, state: '<b>OPEN</b>', url: 'https://example.com/pr/7' },
    commits: [{ ...lecture.commits[0]!, drone: '<b>machine-a</b>' }],
  });
  expect(screen.queryByRole('link', { name: 'https://example.com/pr/7' })).toBeNull();
  expect(screen.getByText('<b>machine-a</b>')).toBeTruthy();
  expect(node('carte-board.chronologie')?.querySelector('b')).toBeNull();
});

test('host : aucune lecture des commits, même avant la réception de l’état appareil', async () => {
  const appels: string[] = [];
  const client = new AidClient({
    flux: 'signal',
    fetchImpl: (async (url: string) => {
      appels.push(url);
      return new Response(JSON.stringify(url === '/api/board/cards/1' ? fiche : { mesh: null }), {
        status: 200,
      });
    }) as typeof fetch,
    socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
  });
  render(
    <MemoryRouter>
      <AidProvider client={client}>
        <Contenu cardId={1} />
      </AidProvider>
    </MemoryRouter>,
  );
  await waitFor(() => expect(client.getSnapshot().appareil).toBeTruthy());
  act(() => FakeSocket.all.at(-1)!.open());
  expect(appels).not.toContain('/api/swairm/board/1/commits');
});

test.each([
  ['OPEN', 'ouverte'],
  ['MERGED', 'mergée'],
  ['CLOSED', 'fermée'],
])('pied PR : état %s affiché « %s »', async (state, libelle) => {
  await ouvrir({ ...lecture, pr: { ...lecture.pr!, state } });
  expect(screen.getByText(`PR #7 (${libelle})`)).toBeTruthy();
});

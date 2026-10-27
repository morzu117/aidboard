// @vitest-environment jsdom
import { act, cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import type { StoredEvent } from '../../src/shared/events.js';
import type { StateSnapshot } from '../../src/shared/state.js';
import { FilActivite } from '../../web/src/ecrans/FilActivite.js';
import { FakeSocket, json, setup, snapshot } from './helpers.js';

afterEach(cleanup);

const node = (id: string) => document.querySelector(`[data-node="${id}"]`);
const heure = (ts: string) =>
  new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

const ev = (over: Partial<StoredEvent> = {}): StoredEvent => ({
  seq: 1,
  v: 1,
  id: 'ev_1',
  ts: '2026-10-27T10:15:00.000Z',
  source: 'daemon',
  type: 'topic.state',
  data: {},
  ...over,
});

const ouvrir = (events: StoredEvent[], over: Partial<StateSnapshot> = {}) =>
  setup(<FilActivite />, snapshot(over), '/', {
    'GET /api/events/recent?limit=20': json(200, { events }),
  });

test('une ligne avec sujet affiche heure, type, contexte et lie vers le sujet', async () => {
  const e = ev({
    topicId: 'tp_1',
    type: 'topic.state',
    context: { topicBranch: 'feat/x', topicTitle: 'Un sujet', workspaceName: 'proj' },
  });
  ouvrir([e]);
  await waitFor(() => expect(node('1-1.activite.ligne-1')).not.toBeNull());
  expect(node('1-1.activite.ligne-1.heure')?.textContent).toBe(heure(e.ts));
  expect(node('1-1.activite.ligne-1.type')?.textContent).toBe('topic.state');
  expect(node('1-1.activite.ligne-1.contexte')?.textContent).toBe('feat/x · proj');
  const lien = within(node('1-1.activite.ligne-1') as HTMLElement).getByRole('link');
  expect(lien.getAttribute('href')).toBe('/sujets/tp_1');
});

test('une ligne sans sujet n’est pas un lien', async () => {
  ouvrir([ev()]);
  await waitFor(() => expect(node('1-1.activite.ligne-1')).not.toBeNull());
  expect(within(node('1-1.activite.ligne-1') as HTMLElement).queryByRole('link')).toBeNull();
});

test('liste vide : « Aucune activité récente »', async () => {
  ouvrir([]);
  await waitFor(() => expect(node('1-1.activite.vide')).not.toBeNull());
  expect(node('1-1.activite.vide')?.textContent).toBe('Aucune activité récente');
});

test('erreur de lecture : ligne discrète « Activité indisponible »', async () => {
  setup(<FilActivite />, snapshot(), '/', {
    'GET /api/events/recent?limit=20': json(500, { error: 'panne' }),
  });
  await waitFor(() => expect(node('1-1.activite.erreur')).not.toBeNull());
  expect(node('1-1.activite.erreur')?.textContent).toBe('Activité indisponible');
});

test('un changement de lastEventId relit le fil, sans nouvel abonnement socket', async () => {
  const h = ouvrir([ev({ id: 'ev_1', type: 'topic.state' })], { lastEventId: 'E1' });
  await waitFor(() => expect(node('1-1.activite.ligne-1.type')?.textContent).toBe('topic.state'));
  const nbSockets = FakeSocket.all.length;

  h.state = snapshot({ lastEventId: 'E2' });
  h.respond.set(
    'GET /api/events/recent?limit=20',
    json(200, { events: [ev({ id: 'ev_2', type: 'topic.phase' })] }),
  );
  await act(async () => {
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.push({ kind: 'event', event: { id: 'E2', type: 'cost', data: {} } });
    await new Promise((r) => setTimeout(r, 40));
  });

  await waitFor(() => expect(node('1-1.activite.ligne-1.type')?.textContent).toBe('topic.phase'));
  expect(FakeSocket.all.length).toBe(nbSockets);
});

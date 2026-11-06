// @vitest-environment jsdom
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Agent, MeshDm } from '../../src/shared/model.js';
import { Notifieur } from '../../web/src/ui/Notifieur.js';
import { agent, type Harness, setup, snapshot, topic, ws } from './helpers.js';

class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static all: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    FakeNotification.all.push(this);
  }
}

let visibility: DocumentVisibilityState = 'hidden';
beforeEach(() => {
  FakeNotification.all = [];
  FakeNotification.permission = 'granted';
  visibility = 'hidden';
  vi.stubGlobal('Notification', FakeNotification);
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.title = 'A-I-D';
});

const run = {
  id: 'run_1',
  topicId: 'tp_1',
  mode: 'standard' as const,
  state: 'open',
  createdAt: 't',
};
const etat = (agents: Agent[]) =>
  snapshot({ workspaces: [ws()], topics: [topic()], runs: [run], agents });
const demande = (id: string, over: Partial<Agent> = {}) =>
  agent({
    id: `ag_${id}`,
    kind: 'claude',
    status: 'needs_input',
    pending: { id, kind: 'question', question: `Question ${id} ?`, options: [] },
    ...over,
  });
const next = async (h: Harness, agents: Agent[]) => {
  h.state = etat(agents);
  await act(() => h.client.refresh());
};

test('une demande nouvelle, onglet caché : une notification, une seule fois', async () => {
  const h = setup(<Notifieur />, etat([]));
  await waitFor(() => expect(h.client.getSnapshot().state).not.toBeNull());
  await next(h, [demande('p1')]);
  expect(FakeNotification.all.map((n) => [n.title, n.options.body])).toEqual([
    ['claude attend ta réponse', 'Question p1 ?'],
  ]);
  await next(h, [demande('p1', { statusAt: 'plus tard' })]);
  await next(h, [demande('p1'), demande('p2')]);
  expect(FakeNotification.all.map((n) => n.options.tag)).toEqual(['p1', 'p2']);
});

test('onglet visible : aucune notification, même quand il se cache ensuite', async () => {
  visibility = 'visible';
  const h = setup(<Notifieur />, etat([]));
  await waitFor(() => expect(h.client.getSnapshot().state).not.toBeNull());
  await next(h, [demande('p1')]);
  visibility = 'hidden';
  await next(h, [demande('p1')]);
  expect(FakeNotification.all).toHaveLength(0);
});

test('sans autorisation, rien ; ce qui attend déjà au chargement ne déclenche pas de rafale', async () => {
  FakeNotification.permission = 'default';
  const h = setup(<Notifieur />, etat([]));
  await waitFor(() => expect(h.client.getSnapshot().state).not.toBeNull());
  await next(h, [demande('p1')]);
  expect(FakeNotification.all).toHaveLength(0);
  cleanup();
  FakeNotification.permission = 'granted';
  setup(<Notifieur />, etat([demande('p9')]));
  await waitFor(() => expect(document.title).toBe('(1) A-I-D'));
  expect(FakeNotification.all).toHaveLength(0);
});

function Lieu() {
  const l = useLocation();
  return <p data-testid="lieu">{`${l.pathname}${l.search}`}</p>;
}

test('un clic mène au terminal de l’agent', async () => {
  const h = setup(
    <>
      <Notifieur />
      <Routes>
        <Route path="*" element={<Lieu />} />
      </Routes>
    </>,
    etat([]),
  );
  await waitFor(() => expect(h.client.getSnapshot().state).not.toBeNull());
  const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
  await next(h, [demande('p1')]);
  act(() => FakeNotification.all[0]!.onclick!());
  expect(focus).toHaveBeenCalled();
  expect(screen.getByTestId('lieu').textContent).toBe('/sujets/tp_1?agent=ag_p1');
  expect(FakeNotification.all[0]!.close).toHaveBeenCalled();
});

test('le titre de l’onglet compte les agents qui attendent', async () => {
  const h = setup(<Notifieur />, etat([demande('p1'), demande('p2'), agent({ id: 'ag_x' })]));
  await waitFor(() => expect(document.title).toBe('(2) A-I-D'));
  await next(h, [demande('p1', { pausedAt: 't' })]);
  expect(document.title).toBe('A-I-D');
});

// 12.5 : un DM `question`/`unblock` du mesh notifie, une fois ; les autres kinds et les DM vus jamais
const dm = (id: number, kind: MeshDm['kind'], over: Partial<MeshDm> = {}): MeshDm => ({
  id,
  threadId: null,
  from: 'mesh-gw',
  to: 'morzu-mac',
  kind,
  content: `DM ${id}\nseconde ligne`,
  createdAt: 't',
  replyTo: null,
  obligationId: null,
  seenAt: null,
  decidedAt: null,
  ...over,
});
const mesh = (inbox: MeshDm[]) => ({
  state: {
    connected: true,
    tailscale: 'running' as const,
    monitor: 'running' as const,
    pending: 0,
    since: 't',
    cell: 'morzu-mac',
  },
  inbox,
  tailscaleManage: false,
});

test('mesh : question et unblock notifient, fyi/status/answer et les DM vus non ; le clic mène à la Boîte', async () => {
  const h = setup(
    <>
      <Notifieur />
      <Routes>
        <Route path="*" element={<Lieu />} />
      </Routes>
    </>,
    { ...etat([]), mesh: mesh([dm(1, 'question')]) },
  );
  await waitFor(() => expect(h.client.getSnapshot().state).not.toBeNull());
  // ce qui est déjà là au chargement ne notifie pas
  expect(FakeNotification.all).toHaveLength(0);
  h.state = {
    ...etat([]),
    mesh: mesh([
      dm(1, 'question'),
      dm(2, 'fyi'),
      dm(3, 'unblock'),
      dm(4, 'status'),
      dm(5, 'answer'),
      dm(6, 'question', { seenAt: 'vu' }),
    ]),
  };
  await act(() => h.client.refresh());
  expect(FakeNotification.all.map((n) => [n.title, n.options.body, n.options.tag])).toEqual([
    ['mesh-gw te sollicite sur le mesh', 'DM 3', 'mesh:3'],
  ]);
  await act(() => h.client.refresh());
  expect(FakeNotification.all).toHaveLength(1);
  const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
  act(() => FakeNotification.all[0]!.onclick!());
  expect(focus).toHaveBeenCalled();
  expect(screen.getByTestId('lieu').textContent).toBe('/boite');
});

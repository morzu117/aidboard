// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Agent, PendingRequest } from '../../src/shared/model.js';
import { AidClient } from '../../web/src/data/client.js';
import { AidProvider } from '../../web/src/data/useAidState.js';
import { Conversation } from '../../web/src/conversation/Conversation.js';
import { agent, json, snapshot } from './helpers.js';

class FakeWs {
  static all: FakeWs[] = [];
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWs.all.push(this);
  }
  close() {}
  text(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}
vi.stubGlobal('WebSocket', FakeWs);

// Harnais local : la conversation ouvre son propre AgentSocket (stub WebSocket ci-dessus) ; seul
// `useAid().call` doit venir d'un vrai AidClient, d'où ce rendu minimal plutôt que helpers.setup().
function mount(a: Agent) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const respond = new Map<string, () => Response>();
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url === '/api/state') return new Response(JSON.stringify(snapshot()), { status: 200 });
    const custom = respond.get(`${method} ${url}`);
    return custom ? custom() : new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const client = new AidClient({
    fetchImpl,
    socketFactory: () => ({ close() {} }) as unknown as WebSocket,
    backoffMs: [20],
    debounceMs: 5,
  });
  const view = render(
    <AidProvider client={client}>
      <Conversation agent={a} visible />
    </AidProvider>,
  );
  const sock = () => FakeWs.all.at(-1)!;
  const rerenderWith = (next: Agent) =>
    view.rerender(
      <AidProvider client={client}>
        <Conversation agent={next} visible />
      </AidProvider>,
    );
  return { calls, respond, sock, rerenderWith };
}

const streamAgent = (over: Partial<Agent> = {}): Agent =>
  agent({ id: 'ag_1', kind: 'claude', transport: 'stream', status: 'working', ...over });

beforeEach(() => {
  FakeWs.all = [];
});
afterEach(cleanup);

test('history puis event : bulle utilisateur, message assistant, groupe d’outils, dédoublonnage par seq ; texte jamais rendu en HTML', async () => {
  mount(streamAgent());
  const ws = FakeWs.all.at(-1)!;
  ws.onopen?.();
  ws.text({
    t: 'history',
    truncated: false,
    items: [
      {
        seq: 1,
        at: '2026-10-26T09:00:00.000Z',
        event: { type: 'message', role: 'user', text: 'Fais X' },
      },
      {
        seq: 2,
        at: '2026-10-26T09:00:01.000Z',
        event: { type: 'message', role: 'assistant', text: '<img src=x onerror=alert(1)> réponse' },
      },
      { seq: 3, at: 't3', event: { type: 'tool_start', toolId: 'a', name: 'ls', input: '.' } },
      {
        seq: 4,
        at: 't4',
        event: { type: 'tool_end', toolId: 'a', output: 'x\ny', isError: false },
      },
      { seq: 5, at: 't5', event: { type: 'tool_start', toolId: 'b', name: 'cat', input: 'f' } },
      { seq: 6, at: 't6', event: { type: 'tool_end', toolId: 'b', output: 'z', isError: false } },
    ],
  });
  await screen.findByText('Fais X');
  expect(screen.getByText(/réponse/).textContent).toContain('<img src=x onerror=alert(1)>');
  expect(document.querySelector('img')).toBeNull();
  expect(screen.getByText('2 commandes')).toBeTruthy();
  // doublon (reconnexion) : le même seq renvoyé en direct ne crée pas une seconde ligne
  ws.text({
    t: 'event',
    seq: 6,
    at: 't6',
    event: { type: 'tool_end', toolId: 'b', output: 'z', isError: false },
  });
  expect(screen.getAllByText('2 commandes')).toHaveLength(1);
});

test('historique tronqué : bandeau affiché', async () => {
  mount(streamAgent());
  const ws = FakeWs.all.at(-1)!;
  ws.onopen?.();
  ws.text({ t: 'history', truncated: true, items: [] });
  expect(
    await screen.findByText(
      'Historique tronqué : les messages les plus anciens ne sont pas affichés.',
    ),
  ).toBeTruthy();
});

test('ToolCallGroup : en cours / succès / erreur, « Voir le détail », « Tout déplier » agit sur tous les groupes', async () => {
  mount(streamAgent());
  const ws = FakeWs.all.at(-1)!;
  ws.onopen?.();
  ws.text({
    t: 'history',
    truncated: false,
    items: [
      { seq: 1, at: 't1', event: { type: 'message', role: 'user', text: 'Q1' } },
      {
        seq: 2,
        at: 't2',
        event: { type: 'tool_start', toolId: 'a', name: 'ok-tool', input: null },
      },
      {
        seq: 3,
        at: 't3',
        event: {
          type: 'tool_end',
          toolId: 'a',
          output: 'sortie ok\ndeuxième ligne',
          isError: false,
        },
      },
      {
        seq: 4,
        at: 't4',
        event: { type: 'tool_start', toolId: 'b', name: 'ko-tool', input: null },
      },
      { seq: 5, at: 't5', event: { type: 'tool_end', toolId: 'b', output: 'boom', isError: true } },
      {
        seq: 6,
        at: 't6',
        event: { type: 'tool_start', toolId: 'c', name: 'cours-tool', input: null },
      },
      { seq: 7, at: 't7', event: { type: 'turn_end', ok: true } },
      { seq: 8, at: 't8', event: { type: 'message', role: 'user', text: 'Q2' } },
      { seq: 9, at: 't9', event: { type: 'tool_start', toolId: 'd', name: 'autre', input: null } },
      {
        seq: 10,
        at: 't10',
        event: { type: 'tool_end', toolId: 'd', output: 'fin\nbis', isError: false },
      },
    ],
  });
  await screen.findByText('Q1');
  expect(screen.getByText('3 commandes')).toBeTruthy();
  expect(screen.getByText('1 commande')).toBeTruthy();
  expect(screen.getAllByText('✓')).toHaveLength(2);
  expect(screen.getByText('✗')).toBeTruthy();
  expect(screen.getByText('…')).toBeTruthy();
  // en condensé, seul le résultat court (première ligne) est visible, jamais le détail complet
  expect(screen.queryByText(/deuxième ligne/)).toBeNull();
  const detailBtns = screen.getAllByRole('button', { name: 'Voir le détail' });
  expect(detailBtns).toHaveLength(2);
  await userEvent.click(detailBtns[0]!);
  expect(screen.getByText(/deuxième ligne/)).toBeTruthy();
  expect(screen.queryByText(/bis/)).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Tout déplier' }));
  expect(screen.getByText(/bis/)).toBeTruthy();
});

test('DecisionCard : options réelles, réponse → POST answer, carte résolue quand agent.pending change', async () => {
  const pending: PendingRequest = {
    id: 'req_1',
    kind: 'question',
    question: 'Continuer ?',
    options: [
      { label: 'Oui', answer: 'yes' },
      { label: 'Non', answer: 'no' },
    ],
  };
  const a = streamAgent({ status: 'needs_input', pending });
  const h = mount(a);
  h.respond.set('POST /api/agents/ag_1/answer', json(200, { id: 'ag_1' }));
  const ws = h.sock();
  ws.onopen?.();
  ws.text({
    t: 'history',
    truncated: false,
    items: [
      { seq: 1, at: 't1', event: { type: 'message', role: 'user', text: 'Go' } },
      { seq: 2, at: 't2', event: { type: 'request', request: pending } },
    ],
  });
  await screen.findByText('Continuer ?');
  await userEvent.click(screen.getByRole('button', { name: 'Oui' }));
  await waitFor(() =>
    expect(
      h.calls.some(
        (c) =>
          c.method === 'POST' &&
          c.url === '/api/agents/ag_1/answer' &&
          (c.body as { pendingId: string; answer: string }).pendingId === 'req_1' &&
          (c.body as { pendingId: string; answer: string }).answer === 'yes',
      ),
    ).toBe(true),
  );
  // tant que agent.pending n'a pas changé côté store, la carte reste en attente (D59 : état poussé par le daemon)
  expect(screen.getByRole('button', { name: 'Oui' })).toBeTruthy();
  // le daemon a traité la réponse : l'agent n'a plus de demande en attente
  h.rerenderWith(streamAgent({ status: 'idle', pending: null }));
  expect(screen.queryByRole('button', { name: 'Oui' })).toBeNull();
  expect(screen.getByText('Réponse : Oui')).toBeTruthy();
});

test('Composer : agent au travail — envoi possible, « Arrêter » → POST interrupt, champ vide désactive l’envoi', async () => {
  const h = mount(streamAgent({ status: 'working' }));
  h.respond.set('POST /api/agents/ag_1/input', json(200, { id: 'ag_1' }));
  h.respond.set('POST /api/agents/ag_1/interrupt', json(200, { id: 'ag_1' }));
  const champ = screen.getByRole('textbox', { name: /Message à claude/ }) as HTMLTextAreaElement;
  const envoyer = screen.getByRole('button', { name: 'Envoyer' }) as HTMLButtonElement;
  expect(envoyer.disabled).toBe(true);
  await userEvent.type(champ, 'Bonjour');
  expect(envoyer.disabled).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: 'Arrêter' }));
  await waitFor(() =>
    expect(h.calls.some((c) => c.method === 'POST' && c.url === '/api/agents/ag_1/interrupt')).toBe(
      true,
    ),
  );
});

test('Composer : Entrée envoie, Maj+Entrée n’envoie pas', async () => {
  const h = mount(streamAgent({ status: 'working' }));
  h.respond.set('POST /api/agents/ag_1/input', json(200, { id: 'ag_1' }));
  const champ = screen.getByRole('textbox', { name: /Message à claude/ });
  await userEvent.type(champ, 'Salut');
  fireEvent.keyDown(champ, { key: 'Enter', shiftKey: true });
  expect(h.calls.some((c) => c.url === '/api/agents/ag_1/input')).toBe(false);
  fireEvent.keyDown(champ, { key: 'Enter' });
  await waitFor(() =>
    expect(
      h.calls.some(
        (c) =>
          c.method === 'POST' &&
          c.url === '/api/agents/ag_1/input' &&
          (c.body as { text: string }).text === 'Salut',
      ),
    ).toBe(true),
  );
});

test('Composer : demande en cours → envoi désactivé avec indication', async () => {
  mount(streamAgent({ status: 'needs_input' }));
  expect(screen.getByText('Répondre d’abord à la demande')).toBeTruthy();
  const champ = screen.getByRole('textbox', { name: /Message à claude/ }) as HTMLTextAreaElement;
  expect(champ.disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Envoyer' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

test('Composer : après exit reçu sur le canal → désactivé, « Agent arrêté »', async () => {
  const h = mount(streamAgent({ status: 'working' }));
  h.sock().onopen?.();
  h.sock().text({ t: 'exit', exitCode: 0, signal: null, reason: 'exit' });
  expect(await screen.findByText('Agent arrêté')).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: /Message à claude/ })).toBeNull();
});

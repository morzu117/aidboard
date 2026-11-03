// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Agent, PendingRequest } from '../../src/shared/model.js';
import { AidClient } from '../../web/src/data/client.js';
import { AidProvider } from '../../web/src/data/useAidState.js';
import { Conversation } from '../../web/src/conversation/Conversation.js';
import { tourNonConnecte } from '../../web/src/conversation/thread.js';
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
function mount(a: Agent, opts: { visible?: boolean; actionsHost?: HTMLDivElement | null } = {}) {
  const visible = opts.visible ?? true;
  // par défaut, un hôte de portail réel attaché au document (findable par `screen`) : les tests
  // qui ne portent pas sur le portail lui-même gardent le même comportement qu'avant son ajout.
  let actionsHost: HTMLDivElement | null;
  if ('actionsHost' in opts) {
    actionsHost = opts.actionsHost ?? null;
  } else {
    actionsHost = document.createElement('div');
    document.body.appendChild(actionsHost);
    autoHosts.push(actionsHost);
  }
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
      <Conversation agent={a} visible={visible} actionsHost={actionsHost} />
    </AidProvider>,
  );
  const sock = () => FakeWs.all.at(-1)!;
  const rerenderWith = (next: Agent, nextVisible = visible) =>
    view.rerender(
      <AidProvider client={client}>
        <Conversation agent={next} visible={nextVisible} actionsHost={actionsHost} />
      </AidProvider>,
    );
  return { calls, respond, sock, rerenderWith };
}

const streamAgent = (over: Partial<Agent> = {}): Agent =>
  agent({ id: 'ag_1', kind: 'claude', transport: 'stream', status: 'working', ...over });

beforeEach(() => {
  FakeWs.all = [];
});
// hôtes de portail créés par défaut par mount() : retirés du DOM entre les tests.
let autoHosts: HTMLDivElement[] = [];
afterEach(() => {
  cleanup();
  for (const el of autoHosts) el.remove();
  autoHosts = [];
});

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
  expect(screen.getByText(/réponse/).closest('.md-p')!.textContent).toContain(
    '<img src=x onerror=alert(1)>',
  );
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
    ],
  });
  await screen.findByText('Q1');
  expect(screen.getByText('3 commandes')).toBeTruthy();
  expect(screen.getByText('✓')).toBeTruthy();
  expect(screen.getByText('✗')).toBeTruthy();
  expect(screen.getByText('…')).toBeTruthy();
  // en condensé, seul le résultat court (première ligne) est visible, jamais le détail complet
  expect(screen.queryByText(/deuxième ligne/)).toBeNull();
  const detailBtns = screen.getAllByRole('button', { name: 'Voir le détail' });
  expect(detailBtns).toHaveLength(1);
  await userEvent.click(detailBtns[0]!);
  expect(screen.getByText(/deuxième ligne/)).toBeTruthy();
  // le tour se termine : l'outil encore ouvert (« cours-tool ») bascule en « interrompu », plus de spinner
  ws.text({ t: 'event', seq: 7, at: 't7', event: { type: 'turn_end', ok: true } });
  ws.text({ t: 'event', seq: 8, at: 't8', event: { type: 'message', role: 'user', text: 'Q2' } });
  ws.text({
    t: 'event',
    seq: 9,
    at: 't9',
    event: { type: 'tool_start', toolId: 'd', name: 'autre', input: null },
  });
  ws.text({
    t: 'event',
    seq: 10,
    at: 't10',
    event: { type: 'tool_end', toolId: 'd', output: 'fin\nbis', isError: false },
  });
  await screen.findByText('interrompu');
  expect(screen.queryByText('…')).toBeNull();
  expect(screen.getByText('1 commande')).toBeTruthy();
  expect(screen.queryByText(/bis/)).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Tout déplier' }));
  expect(screen.getByText(/bis/)).toBeTruthy();
});

test('Repères et Tout déplier (correctif 3) : portés dans l’emplacement fourni par Sujet, pas dans la conversation', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const h = mount(streamAgent(), { actionsHost: host });
  const ws = h.sock();
  ws.onopen?.();
  ws.text({
    t: 'history',
    truncated: false,
    items: [
      { seq: 1, at: 't1', event: { type: 'message', role: 'user', text: 'Q1' } },
      { seq: 2, at: 't2', event: { type: 'tool_start', toolId: 'a', name: 'ls', input: null } },
      { seq: 3, at: 't3', event: { type: 'tool_end', toolId: 'a', output: 'ok', isError: false } },
    ],
  });
  await screen.findByText('Q1');
  expect(host.querySelector('[data-node="1-3.conversation.reperes"]')).toBeTruthy();
  expect(host.querySelector('[data-node="1-3.conversation.tout"]')).toBeTruthy();
  // connecté dès le départ (pas de reconnexion) : la barre elle-même n'a plus de raison d'exister.
  expect(document.querySelector('.conversation-barre')).toBeNull();
  host.remove();
});

test('Repères et Tout déplier (correctif 3) : absents de l’emplacement fourni quand la conversation est masquée', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const h = mount(streamAgent(), { actionsHost: host, visible: false });
  const ws = h.sock();
  ws.onopen?.();
  ws.text({
    t: 'history',
    truncated: false,
    items: [
      { seq: 1, at: 't1', event: { type: 'message', role: 'user', text: 'Q1' } },
      { seq: 2, at: 't2', event: { type: 'tool_start', toolId: 'a', name: 'ls', input: null } },
      { seq: 3, at: 't3', event: { type: 'tool_end', toolId: 'a', output: 'ok', isError: false } },
    ],
  });
  await waitFor(() => expect(FakeWs.all.length).toBeGreaterThan(0));
  expect(host.children.length).toBe(0);
  h.rerenderWith(streamAgent(), true);
  await waitFor(() =>
    expect(host.querySelector('[data-node="1-3.conversation.reperes"]')).toBeTruthy(),
  );
  host.remove();
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

test('Composer : après exit sans message (A.6) → pas de « Agent arrêté », le champ reste actif', async () => {
  const h = mount(streamAgent({ status: 'working' }));
  h.sock().onopen?.();
  h.sock().text({ t: 'exit', exitCode: 0, signal: null, reason: 'exit' });
  expect(screen.queryByText('Agent arrêté')).toBeNull();
  expect(screen.getByRole('textbox', { name: /Message à claude/ })).toBeTruthy();
});

test('exit avec message (A.6) : « Session interrompue », le champ reste actif', async () => {
  const h = mount(streamAgent({ status: 'working' }));
  const ws = h.sock();
  ws.onopen?.();
  // le texte du diagnostic de crash arrive dans l'événement (ligne `agent_messages`), pas dans le
  // cadre `t: 'exit'` (qui ne porte qu'exitCode/signal/reason et pilote la fermeture du canal).
  ws.text({
    t: 'event',
    seq: 1,
    at: 't1',
    event: { type: 'exit', code: 1, signal: null, message: 'process mort' },
  });
  expect(
    await screen.findByText(
      'Session interrompue : process mort. Elle reprendra au prochain message.',
    ),
  ).toBeTruthy();
  expect(screen.getByRole('textbox', { name: /Message à claude/ })).toBeTruthy();
});

test('reprise transparente (A.6) : après exit, le statut repart « working » → un nouveau canal s’ouvre', async () => {
  const h = mount(streamAgent({ status: 'idle' }));
  h.sock().onopen?.();
  h.sock().text({ t: 'exit', exitCode: 0, signal: null, reason: 'exit' });
  expect(FakeWs.all).toHaveLength(1);

  h.rerenderWith(streamAgent({ status: 'working' }));
  expect(FakeWs.all).toHaveLength(2);
  const ws2 = FakeWs.all.at(-1)!;
  ws2.onopen?.();
  ws2.text({
    t: 'history',
    truncated: false,
    items: [{ seq: 1, at: 't1', event: { type: 'message', role: 'user', text: 'repris' } }],
  });
  expect(await screen.findByText('repris')).toBeTruthy();
});

test('ToolCallGroup : un outil encore ouvert à turn_end ou à exit est affiché « interrompu », jamais en cours ; un tool_end rejoué pour cet outil ne casse rien', async () => {
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
        event: { type: 'tool_start', toolId: 'a', name: 'lent-tool', input: null },
      },
      { seq: 3, at: 't3', event: { type: 'turn_end', ok: false, error: 'interrompu' } },
    ],
  });
  await screen.findByText('Q1');
  expect(screen.getAllByText('interrompu')).toHaveLength(1);
  expect(screen.queryByText('…')).toBeNull();
  // tool_end rejoué (reconnexion) pour un outil déjà clos comme interrompu : ne doit rien casser
  ws.text({
    t: 'event',
    seq: 8,
    at: 't8',
    event: { type: 'tool_end', toolId: 'a', output: 'trop tard', isError: false },
  });
  expect(screen.getAllByText('interrompu')).toHaveLength(1);
  // idem avec exit : un second tour, un outil ouvert qui reste ouvert jusqu'à l'arrêt de l'agent
  ws.text({ t: 'event', seq: 5, at: 't5', event: { type: 'message', role: 'user', text: 'Q2' } });
  ws.text({
    t: 'event',
    seq: 6,
    at: 't6',
    event: { type: 'tool_start', toolId: 'b', name: 'autre-tool', input: null },
  });
  ws.text({ t: 'event', seq: 7, at: 't7', event: { type: 'exit', message: 'stoppé' } });
  await waitFor(() => expect(screen.getAllByText('interrompu')).toHaveLength(2));
  expect(screen.queryByText('…')).toBeNull();
});

test('ToolCallGroup : une entrée longue est tronquée dans la ligne condensée', async () => {
  mount(streamAgent());
  const ws = FakeWs.all.at(-1)!;
  ws.onopen?.();
  const longEntree = 'x'.repeat(1000);
  ws.text({
    t: 'history',
    truncated: false,
    items: [
      { seq: 1, at: 't1', event: { type: 'message', role: 'user', text: 'Q1' } },
      {
        seq: 2,
        at: 't2',
        event: { type: 'tool_start', toolId: 'a', name: 'long-tool', input: longEntree },
      },
      { seq: 3, at: 't3', event: { type: 'tool_end', toolId: 'a', output: 'ok', isError: false } },
    ],
  });
  await screen.findByText('Q1');
  expect(screen.queryByText(longEntree)).toBeNull();
  const entree = document.querySelector('.outil-entree');
  expect(entree?.textContent && entree.textContent.length).toBeLessThan(1000);
  expect(entree?.textContent).toContain('…');
});

test('ToolCallGroup : aria-expanded bascule avec « Voir le détail »', async () => {
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
      { seq: 3, at: 't3', event: { type: 'tool_end', toolId: 'a', output: 'ok', isError: false } },
    ],
  });
  await screen.findByText('Q1');
  const bouton = screen.getByRole('button', { name: 'Voir le détail' });
  expect(bouton.getAttribute('aria-expanded')).toBe('false');
  await userEvent.click(bouton);
  expect(
    screen.getByRole('button', { name: 'Replier le détail' }).getAttribute('aria-expanded'),
  ).toBe('true');
});

test('DecisionCard : un second clic après une réponse envoyée avec succès n’envoie pas de second POST', async () => {
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
  const bouton = screen.getByRole('button', { name: 'Oui' }) as HTMLButtonElement;
  await userEvent.click(bouton);
  await waitFor(() =>
    expect(h.calls.filter((c) => c.url === '/api/agents/ag_1/answer')).toHaveLength(1),
  );
  // agent.pending n'a pas encore changé côté store (D59) : le bouton reste affiché mais désactivé
  expect(bouton.disabled).toBe(true);
  await userEvent.click(bouton);
  expect(h.calls.filter((c) => c.url === '/api/agents/ag_1/answer')).toHaveLength(1);
});

test('Composer : double clic sur « Arrêter » n’envoie qu’un seul POST interrupt', async () => {
  const h = mount(streamAgent({ status: 'working' }));
  h.respond.set('POST /api/agents/ag_1/interrupt', json(200, { id: 'ag_1' }));
  const bouton = screen.getByRole('button', { name: 'Arrêter' });
  fireEvent.click(bouton);
  fireEvent.click(bouton);
  await waitFor(() =>
    expect(h.calls.filter((c) => c.url === '/api/agents/ag_1/interrupt')).toHaveLength(1),
  );
});

const OPTIONS_CLAUDE = {
  modes: [
    { id: 'default', label: 'Demander' },
    { id: 'acceptEdits', label: 'Modifs auto' },
    { id: 'auto', label: 'Auto' },
    { id: 'plan', label: 'Plan' },
  ],
  models: [
    { id: 'opus', label: 'Opus 5.5', efforts: ['low', 'high', 'max'] },
    { id: 'sonnet', label: 'Sonnet 5.5', efforts: ['low', 'high', 'max'] },
  ],
  efforts: ['low', 'high', 'max'],
};

function mountReglages(over: Partial<Agent> = {}) {
  const m = mount(streamAgent({ status: 'idle', permissionMode: 'default', ...over }));
  m.respond.set(
    'GET /api/agents/ag_1/options',
    () => new Response(JSON.stringify(OPTIONS_CLAUDE), { status: 200 }),
  );
  m.respond.set(
    'PATCH /api/agents/ag_1/settings',
    () =>
      new Response(JSON.stringify({ mode: 'auto', model: null, effort: null }), { status: 200 }),
  );
  return m;
}

test('chip mode (16.5) : affiche le mode de l’agent, le menu liste les modes, un choix envoie le PATCH', async () => {
  const { calls } = mountReglages();
  const chip = await screen.findByRole('button', { name: 'Mode : Demander' });
  await waitFor(() => expect(calls.some((c) => c.url === '/api/agents/ag_1/options')).toBe(true));
  await userEvent.click(chip);
  const menu = await screen.findByRole('menu', { name: 'Mode' });
  expect(
    Array.from(menu.querySelectorAll('[role="menuitemradio"]')).map((b) => b.textContent),
  ).toEqual(['✓Demander', 'Modifs auto', 'Auto', 'Plan']);
  await userEvent.click(screen.getByRole('menuitemradio', { name: 'Auto' }));
  await waitFor(() =>
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({
      url: '/api/agents/ag_1/settings',
      body: { mode: 'auto' },
    }),
  );
  expect(await screen.findByRole('button', { name: 'Mode : Auto' })).toBeTruthy();
  expect(screen.queryByRole('menu')).toBeNull();
});

test('chip modèle : « Par défaut » sans réglage, puis modèle et effort choisis dans le même menu', async () => {
  const { calls, respond } = mountReglages();
  await userEvent.click(await screen.findByRole('button', { name: 'Modèle : Par défaut' }));
  await screen.findByRole('menuitemradio', { name: 'Opus 5.5' });
  respond.set(
    'PATCH /api/agents/ag_1/settings',
    () =>
      new Response(JSON.stringify({ mode: 'default', model: 'opus', effort: null }), {
        status: 200,
      }),
  );
  await userEvent.click(screen.getByRole('menuitemradio', { name: 'Opus 5.5' }));
  await screen.findByRole('button', { name: 'Modèle : Opus 5.5' });

  await userEvent.click(screen.getByRole('button', { name: 'Modèle : Opus 5.5' }));
  respond.set(
    'PATCH /api/agents/ag_1/settings',
    () =>
      new Response(JSON.stringify({ mode: 'default', model: 'opus', effort: 'max' }), {
        status: 200,
      }),
  );
  await userEvent.click(await screen.findByRole('menuitemradio', { name: 'max' }));
  expect(await screen.findByRole('button', { name: 'Modèle : Opus 5.5 · max' })).toBeTruthy();
  expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([
    { model: 'opus' },
    { effort: 'max' },
  ]);
});

test('réglage refusé par le daemon : le chip revient à l’état de l’agent, l’erreur est affichée', async () => {
  const { respond } = mountReglages();
  respond.set(
    'PATCH /api/agents/ag_1/settings',
    () =>
      new Response(JSON.stringify({ error: 'mode inconnu pour claude : plan' }), { status: 422 }),
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Mode : Demander' }));
  await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Plan' }));
  expect((await screen.findByRole('alert')).textContent).toContain('mode inconnu');
  expect(screen.getByRole('button', { name: 'Mode : Demander' })).toBeTruthy();
});

test('l’instantané fait foi : un réglage changé ailleurs met le chip à jour', async () => {
  const { rerenderWith } = mountReglages();
  await screen.findByRole('button', { name: 'Mode : Demander' });
  rerenderWith(streamAgent({ status: 'idle', permissionMode: 'plan', model: 'sonnet' }));
  expect(await screen.findByRole('button', { name: 'Mode : Plan' })).toBeTruthy();
  expect(await screen.findByRole('button', { name: 'Modèle : Sonnet 5.5' })).toBeTruthy();
});

test('Échap ferme le menu de réglage', async () => {
  mountReglages();
  await userEvent.click(await screen.findByRole('button', { name: 'Mode : Demander' }));
  await screen.findByRole('menu', { name: 'Mode' });
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('menu')).toBeNull();
});

const fichier = (name: string, type: string, contenu = 'abc') =>
  new File([contenu], name, { type });

test('pièces jointes (16.6) : le trombone ajoute des puces retirables, l’envoi porte nom, type et base64', async () => {
  const { calls } = mountReglages();
  const input = document.querySelector<HTMLInputElement>('[data-node$=".composer.fichiers"]')!;
  expect(screen.getByRole('button', { name: 'Joindre des fichiers' })).toBeTruthy();
  await userEvent.upload(input, [
    fichier('capture.png', 'image/png', 'png!'),
    fichier('notes.txt', 'text/plain', 'salut'),
    fichier('brut', ''),
  ]);
  const liste = screen.getByRole('list', { name: 'Pièces jointes' });
  expect(liste.textContent).toContain('capture.png');
  await userEvent.click(screen.getByRole('button', { name: 'Retirer brut' }));
  expect(liste.textContent).not.toContain('brut');

  // texte vide permis dès qu'une pièce est jointe
  const envoyer = screen.getByRole('button', { name: 'Envoyer' }) as HTMLButtonElement;
  expect(envoyer.disabled).toBe(false);
  await userEvent.click(envoyer);
  await waitFor(() =>
    expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/input'))?.body).toEqual({
      text: '',
      attachments: [
        { name: 'capture.png', type: 'image/png', data: btoa('png!') },
        { name: 'notes.txt', type: 'text/plain', data: btoa('salut') },
      ],
    }),
  );
  await waitFor(() => expect(screen.queryByRole('list', { name: 'Pièces jointes' })).toBeNull());
});

test('pièces jointes : collage d’image et glisser-déposer ; bornes de nombre et de taille', async () => {
  mountReglages();
  const champ = screen.getByRole('textbox');
  fireEvent.paste(champ, {
    clipboardData: { files: [fichier('colle.png', 'image/png')], getData: () => '' },
  });
  expect(screen.getByRole('list', { name: 'Pièces jointes' }).textContent).toContain('colle.png');

  const zone = document.querySelector('[data-node$=".composer"]')!;
  fireEvent.drop(zone, {
    dataTransfer: { files: [fichier('a.txt', 'text/plain'), fichier('b.txt', 'text/plain')] },
  });
  expect(screen.getAllByRole('listitem')).toHaveLength(3);

  fireEvent.drop(zone, {
    dataTransfer: {
      files: [fichier('c', 'text/plain'), fichier('d', 'text/plain'), fichier('e', 'text/plain')],
    },
  });
  expect((await screen.findByRole('alert')).textContent).toContain('5 pièces jointes au plus');
  expect(screen.getAllByRole('listitem')).toHaveLength(3);

  const gros = fichier('gros.bin', 'application/octet-stream');
  Object.defineProperty(gros, 'size', { value: 10 * 1024 * 1024 + 1 });
  fireEvent.drop(zone, { dataTransfer: { files: [gros] } });
  expect((await screen.findByRole('alert')).textContent).toContain('gros.bin dépasse 10 Mio');
});

test('pièces jointes : pas de trombone pour un agent PTY', () => {
  mount(agent({ id: 'ag_1', kind: 'claude', transport: 'pty', status: 'idle' }));
  expect(screen.queryByRole('button', { name: 'Joindre des fichiers' })).toBeNull();
});

test('bulle utilisateur : liste les noms des pièces jointes', async () => {
  mount(streamAgent());
  const ws = FakeWs.all.at(-1)!;
  ws.onopen?.();
  ws.text({
    t: 'history',
    truncated: false,
    items: [
      {
        seq: 1,
        at: '2026-10-30T09:00:00.000Z',
        event: {
          type: 'message',
          role: 'user',
          text: 'regarde',
          attachments: [{ name: 'capture.png', type: 'image/png', size: 4 }],
        },
      },
    ],
  });
  await screen.findByText('regarde');
  expect(screen.getByRole('list', { name: 'Pièces jointes' }).textContent).toContain('capture.png');
});

test('tourNonConnecte : consigne /login sur le serveur, consigne locale, null pour toute autre erreur', () => {
  expect(tourNonConnecte('authentication_failed', 'claude', 'vps-ovh')).toBe(
    'claude n’est pas connecté sur vps-ovh : ouvre un terminal ssh sur vps-ovh, lance claude puis /login, et renvoie ton message.',
  );
  expect(tourNonConnecte('authentication_failed', 'claude')).toBe(
    'claude n’est pas connecté : lance claude dans un terminal puis /login, et renvoie ton message.',
  );
  expect(tourNonConnecte('success', 'claude', 'vps-ovh')).toBeNull();
  expect(tourNonConnecte('interrompu', 'claude')).toBeNull();
  expect(tourNonConnecte(undefined, 'claude')).toBeNull();
});

test('turn_end authentication_failed (local) : consigne /login à la place de « Tour en erreur »', async () => {
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
        event: {
          type: 'message',
          role: 'assistant',
          text: 'Failed to authenticate: OAuth session expired and could not be refreshed',
        },
      },
      {
        seq: 3,
        at: 't3',
        event: { type: 'turn_end', ok: false, error: 'authentication_failed' },
      },
    ],
  });
  expect(
    await screen.findByText(
      'claude n’est pas connecté : lance claude dans un terminal puis /login, et renvoie ton message.',
    ),
  ).toBeTruthy();
  expect(
    screen.getByText('Failed to authenticate: OAuth session expired and could not be refreshed'),
  ).toBeTruthy();
  expect(screen.queryByText(/Tour en erreur/)).toBeNull();
});

test('turn_end dont l’erreur est un texte libre : « Tour en erreur : <texte> »', async () => {
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
        event: { type: 'turn_end', ok: false, error: 'Credit balance is too low' },
      },
    ],
  });
  expect(await screen.findByText('Tour en erreur : Credit balance is too low')).toBeTruthy();
});

// ---- Chantier 23 (B.1, D91) : le chip « Remote » à côté du modèle

const RC = '/api/agents/ag_1/remote-control';
const URL_SESSION = 'https://claude.ai/code/session_fake1';
const chipRemote = () => document.querySelector<HTMLElement>('[data-node$=".composer.remote"]');
const lecturesRemote = (calls: Array<{ method: string; url: string }>) =>
  calls.filter((c) => c.method === 'GET' && c.url === RC).length;

/**
 * Comme mount(), mais l'état du remote-control est servi dès le premier rendu (le chip le lit au montage,
 * avant que mount() ne rende la main) ; `lecture.etat` se change en cours de test.
 */
function mountRemote(etat: object | (() => Response), over: Partial<Agent> = {}) {
  const lecture = { etat };
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const respond = new Map<string, () => Response>();
  respond.set(`GET ${RC}`, () =>
    typeof lecture.etat === 'function'
      ? (lecture.etat as () => Response)()
      : new Response(JSON.stringify(lecture.etat), { status: 200 }),
  );
  respond.set('GET /api/agents/ag_1/options', json(200, OPTIONS_CLAUDE));
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
  render(
    <AidProvider client={client}>
      <Conversation
        agent={streamAgent({ status: 'idle', permissionMode: 'default', ...over })}
        visible
        actionsHost={null}
      />
    </AidProvider>,
  );
  return { calls, respond, lecture };
}

test('chip Remote : absent pour codex, sans même lire l’état', async () => {
  const { calls } = mountRemote({ status: 'off' }, { kind: 'codex' });
  await waitFor(() => expect(calls.some((c) => c.url === '/api/agents/ag_1/options')).toBe(true));
  await screen.findByRole('button', { name: /^Modèle/ });
  expect(chipRemote()).toBeNull();
  expect(lecturesRemote(calls)).toBe(0);
});

test('chip Remote : absent si l’état est `unsupported` ou si la lecture échoue', async () => {
  const a = mountRemote({ status: 'unsupported' });
  await waitFor(() => expect(lecturesRemote(a.calls)).toBe(1));
  await screen.findByRole('button', { name: /^Modèle/ });
  expect(chipRemote()).toBeNull();
  cleanup();

  const b = mountRemote(() => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }));
  await waitFor(() => expect(lecturesRemote(b.calls)).toBe(1));
  await screen.findByRole('button', { name: /^Modèle/ });
  expect(chipRemote()).toBeNull();
});

test.each([
  ['off', 'Remote'],
  ['connecting', 'Remote · connexion…'],
  ['connected', 'Remote · connecté'],
  ['error', 'Remote · erreur'],
] as const)('chip Remote : état %s → « %s »', async (status, libelle) => {
  mountRemote({ status, url: status === 'off' || status === 'error' ? undefined : URL_SESSION });
  await waitFor(() => expect(chipRemote()?.textContent).toBe(libelle));
  expect(chipRemote()!.getAttribute('data-etat')).toBe(status);
  expect(screen.getByRole('button', { name: `Remote-control : ${libelle}` })).toBe(chipRemote());
});

test('chip Remote : Activer → POST {enabled:true}, bouton désactivé pendant la requête, puis lien vers la session', async () => {
  const { calls, respond } = mountRemote({ status: 'off' });
  let repondre: (r: Response) => void = () => {};
  respond.set(
    `POST ${RC}`,
    () => new Promise<Response>((r) => (repondre = r)) as unknown as Response,
  );
  await waitFor(() => expect(chipRemote()?.textContent).toBe('Remote'));
  await userEvent.click(chipRemote()!);
  const menu = await screen.findByRole('menu', { name: 'Remote-control' });
  expect(menu.querySelector('[data-node$=".remote-etat"]')?.textContent).toContain(
    'claude.ai/code',
  );
  expect(menu.querySelector('[data-node$=".remote-lien"]')).toBeNull();
  const bascule = screen.getByRole('menuitem', { name: 'Activer' });
  await userEvent.click(bascule);
  await waitFor(() =>
    expect(calls.find((c) => c.method === 'POST' && c.url === RC)?.body).toEqual({ enabled: true }),
  );
  expect((bascule as HTMLButtonElement).disabled).toBe(true);
  repondre(
    new Response(JSON.stringify({ status: 'connected', url: URL_SESSION }), { status: 200 }),
  );
  await waitFor(() => expect(chipRemote()?.textContent).toBe('Remote · connecté'));
  const lien = screen.getByRole('menuitem', { name: /Ouvrir la session/ }) as HTMLAnchorElement;
  expect(lien.getAttribute('href')).toBe(URL_SESSION);
  expect(lien.getAttribute('target')).toBe('_blank');
  const desactiver = screen.getByRole('menuitem', { name: 'Désactiver' }) as HTMLButtonElement;
  expect(desactiver.disabled).toBe(false);
  // même mécanique que les autres menus : Échap ferme
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('menu')).toBeNull();
});

test('chip Remote : Désactiver → POST {enabled:false}, le lien disparaît', async () => {
  const { calls, respond } = mountRemote({ status: 'connected', url: URL_SESSION });
  respond.set(`POST ${RC}`, json(200, { status: 'off' }));
  await waitFor(() => expect(chipRemote()?.textContent).toBe('Remote · connecté'));
  await userEvent.click(chipRemote()!);
  expect(await screen.findByRole('menuitem', { name: /Ouvrir la session/ })).toBeTruthy();
  await userEvent.click(screen.getByRole('menuitem', { name: 'Désactiver' }));
  await waitFor(() => expect(chipRemote()?.textContent).toBe('Remote'));
  expect(calls.filter((c) => c.method === 'POST' && c.url === RC).map((c) => c.body)).toEqual([
    { enabled: false },
  ]);
  expect(screen.queryByRole('menuitem', { name: /Ouvrir la session/ })).toBeNull();
  expect(screen.getByRole('menuitem', { name: 'Activer' })).toBeTruthy();
});

test('chip Remote : état `error` → message et « Réessayer », sans lien', async () => {
  // un `bridge_state` `failed` garde l'url de la session : le lien n'est pas proposé pour autant
  const { calls, respond } = mountRemote({
    status: 'error',
    url: URL_SESSION,
    error: 'refusé par claude',
  });
  respond.set(`POST ${RC}`, json(200, { status: 'connecting', url: URL_SESSION }));
  await waitFor(() => expect(chipRemote()?.textContent).toBe('Remote · erreur'));
  await userEvent.click(chipRemote()!);
  const menu = await screen.findByRole('menu', { name: 'Remote-control' });
  await waitFor(() =>
    expect(menu.querySelector('[data-node$=".remote-etat"]')?.textContent).toBe(
      'refusé par claude',
    ),
  );
  expect(menu.querySelector('[data-node$=".remote-lien"]')).toBeNull();
  await userEvent.click(screen.getByRole('menuitem', { name: 'Réessayer' }));
  await waitFor(() => expect(chipRemote()?.textContent).toBe('Remote · connexion…'));
  expect(calls.find((c) => c.method === 'POST' && c.url === RC)?.body).toEqual({ enabled: true });
  expect(screen.getByRole('menuitem', { name: /Ouvrir la session/ })).toBeTruthy();
});

test('chip Remote : un POST refusé passe par l’erreur du composer et relit l’état', async () => {
  const { calls, respond } = mountRemote({ status: 'off' });
  respond.set(`POST ${RC}`, json(502, { error: 'claude n’a pas répondu au remote_control' }));
  await waitFor(() => expect(chipRemote()?.textContent).toBe('Remote'));
  await userEvent.click(chipRemote()!);
  await screen.findByRole('menu', { name: 'Remote-control' });
  await waitFor(() => expect(lecturesRemote(calls)).toBe(2));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Activer' }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    'claude n’a pas répondu au remote_control',
  );
  await waitFor(() => expect(lecturesRemote(calls)).toBe(3));
  expect(chipRemote()?.textContent).toBe('Remote');
  expect((screen.getByRole('menuitem', { name: 'Activer' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});

test('chip Remote : relu toutes les 3 s tant qu’il est en connexion, plus une fois connecté', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    const { calls, lecture } = mountRemote({ status: 'connecting', url: URL_SESSION });
    await waitFor(() => expect(chipRemote()?.textContent).toBe('Remote · connexion…'));
    expect(lecturesRemote(calls)).toBe(1);
    await act(async () => vi.advanceTimersByTime(3_000));
    await waitFor(() => expect(lecturesRemote(calls)).toBe(2));
    lecture.etat = { status: 'connected', url: URL_SESSION };
    await act(async () => vi.advanceTimersByTime(3_000));
    await waitFor(() => expect(chipRemote()?.textContent).toBe('Remote · connecté'));
    expect(lecturesRemote(calls)).toBe(3);
    await act(async () => vi.advanceTimersByTime(12_000));
    expect(lecturesRemote(calls)).toBe(3);
  } finally {
    vi.useRealTimers();
  }
});

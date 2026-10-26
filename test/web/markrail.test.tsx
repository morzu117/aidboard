// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Agent } from '../../src/shared/model.js';
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

const scrollTo = vi.fn();

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
  render(
    <AidProvider client={client}>
      <Conversation agent={a} visible />
    </AidProvider>,
  );
  const sock = () => FakeWs.all.at(-1)!;
  return { calls, respond, sock };
}

const streamAgent = (over: Partial<Agent> = {}): Agent =>
  agent({ id: 'ag_1', kind: 'claude', transport: 'stream', status: 'idle', ...over });

const histoDeuxQuestions = {
  t: 'history',
  truncated: false,
  items: [
    {
      seq: 1,
      at: '2026-10-26T09:00:00.000Z',
      event: { type: 'message', role: 'user', text: 'Première question' },
    },
    {
      seq: 2,
      at: '2026-10-26T09:00:01.000Z',
      event: { type: 'message', role: 'assistant', text: 'Réponse' },
    },
    {
      seq: 3,
      at: '2026-10-26T09:01:00.000Z',
      event: { type: 'message', role: 'user', text: 'Seconde question' },
    },
  ],
};

beforeEach(() => {
  FakeWs.all = [];
  scrollTo.mockClear();
  Element.prototype.scrollTo = scrollTo;
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q }) as MediaQueryList);
  // jsdom ne fait aucune mise en page : offsetTop est toujours 0. On le fait refléter l'ordre
  // d'apparition des questions dans le fil, comme le ferait un vrai défilement vertical.
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement) {
      if (!this.hasAttribute('data-repere')) return 0;
      return Array.from(document.querySelectorAll('[data-repere]')).indexOf(this) * 100;
    },
  });
});
afterEach(cleanup);

test('aucune question : ni rail ni menu', async () => {
  mount(streamAgent());
  const ws = FakeWs.all.at(-1)!;
  ws.onopen?.();
  ws.text({ t: 'history', truncated: false, items: [] });
  await waitFor(() => expect(document.querySelector('.fil-conversation')).toBeTruthy());
  expect(document.querySelector('.repere-rail')).toBeNull();
  expect(screen.queryByRole('button', { name: /Repères ·/ })).toBeNull();
});

test('un trait par question ; clic sur un trait défile avec le bon décalage', async () => {
  mount(streamAgent());
  const ws = FakeWs.all.at(-1)!;
  ws.onopen?.();
  ws.text(histoDeuxQuestions);
  await screen.findByText('Première question');
  const traits = document.querySelectorAll('.repere-trait');
  expect(traits).toHaveLength(2);
  fireEvent.click(traits[0]!);
  expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: -16, behavior: 'smooth' }));
});

test('prefers-reduced-motion : défilement en behavior auto', async () => {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q }) as MediaQueryList);
  mount(streamAgent());
  const ws = FakeWs.all.at(-1)!;
  ws.onopen?.();
  ws.text(histoDeuxQuestions);
  await screen.findByText('Première question');
  fireEvent.click(document.querySelectorAll('.repere-trait')[0]!);
  expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }));
});

test('historique avec marked:true : trait marqué au chargement', async () => {
  mount(streamAgent());
  const ws = FakeWs.all.at(-1)!;
  ws.onopen?.();
  ws.text({
    t: 'history',
    truncated: false,
    items: [
      {
        seq: 1,
        at: 't1',
        marked: true,
        event: { type: 'message', role: 'user', text: 'Question marquée' },
      },
    ],
  });
  await screen.findByText('Question marquée');
  expect(document.querySelector('.repere-trait--marque')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Démarquer la question' })).toBeTruthy();
});

test('étoile : clic → PUT mark puis état marqué ; rien ne change si la route échoue', async () => {
  const h = mount(streamAgent());
  h.respond.set('PUT /api/agents/ag_1/messages/1/mark', json(200, { seq: 1, marked: true }));
  const ws = h.sock();
  ws.onopen?.();
  ws.text({
    t: 'history',
    truncated: false,
    items: [{ seq: 1, at: 't1', event: { type: 'message', role: 'user', text: 'Q1' } }],
  });
  const etoile = await screen.findByRole('button', { name: 'Marquer la question' });
  await userEvent.click(etoile);
  await waitFor(() =>
    expect(
      h.calls.some(
        (c) =>
          c.method === 'PUT' &&
          c.url === '/api/agents/ag_1/messages/1/mark' &&
          (c.body as { marked: boolean }).marked === true,
      ),
    ).toBe(true),
  );
  expect(await screen.findByRole('button', { name: 'Démarquer la question' })).toBeTruthy();
  expect(document.querySelector('.message-utilisateur--marquee')).toBeTruthy();

  // seconde question : la route échoue, rien ne doit changer
  ws.text({ t: 'event', seq: 2, at: 't2', event: { type: 'message', role: 'user', text: 'Q2' } });
  h.respond.set('PUT /api/agents/ag_1/messages/2/mark', () => new Response('{}', { status: 500 }));
  const etoile2 = await screen.findByRole('button', { name: 'Marquer la question' });
  await userEvent.click(etoile2);
  await waitFor(() =>
    expect(h.calls.some((c) => c.url === '/api/agents/ag_1/messages/2/mark')).toBe(true),
  );
  expect(screen.getAllByRole('button', { name: 'Marquer la question' })).toHaveLength(1);
});

// La correction A.7 retire role="menu"/"menuitem" (pas de navigation clavier de menu réelle derrière) :
// le conteneur est une région étiquetée, les lignes des boutons ordinaires.
const nomRegion = 'Questions de cette discussion';

test('menu Repères : N/M, clic sur une ligne défile et ferme, Échap ferme et rend le focus au bouton', async () => {
  mount(streamAgent());
  const ws = FakeWs.all.at(-1)!;
  ws.onopen?.();
  ws.text(histoDeuxQuestions);
  await screen.findByText('Première question');
  const bouton = screen.getByRole('button', { name: /Repères · 1\/2/ });
  await userEvent.click(bouton);
  const region = screen.getByRole('region', { name: nomRegion });
  await userEvent.click(within(region).getByRole('button', { name: /Seconde question/ }));
  expect(screen.queryByRole('region', { name: nomRegion })).toBeNull();
  expect(scrollTo).toHaveBeenCalled();

  await userEvent.click(bouton);
  expect(screen.getByRole('region', { name: nomRegion })).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('region', { name: nomRegion })).toBeNull();
  expect(document.activeElement).toBe(bouton);
});

test('clic sur le bouton Repères avec le menu ouvert referme, troisième clic rouvre', async () => {
  mount(streamAgent());
  const ws = FakeWs.all.at(-1)!;
  ws.onopen?.();
  ws.text(histoDeuxQuestions);
  await screen.findByText('Première question');
  const bouton = screen.getByRole('button', { name: /Repères · 1\/2/ });

  await userEvent.click(bouton);
  expect(screen.getByRole('region', { name: nomRegion })).toBeTruthy();
  await userEvent.click(bouton);
  expect(screen.queryByRole('region', { name: nomRegion })).toBeNull();
  await userEvent.click(bouton);
  expect(screen.getByRole('region', { name: nomRegion })).toBeTruthy();
});

test('menu Repères : la ligne active porte aria-current, les autres non', async () => {
  mount(streamAgent());
  const ws = FakeWs.all.at(-1)!;
  ws.onopen?.();
  ws.text(histoDeuxQuestions);
  await screen.findByText('Première question');
  await userEvent.click(screen.getByRole('button', { name: /Repères · 1\/2/ }));
  const region = screen.getByRole('region', { name: nomRegion });
  expect(
    within(region)
      .getByRole('button', { name: /Première question/ })
      .getAttribute('aria-current'),
  ).toBe('true');
  expect(
    within(region)
      .getByRole('button', { name: /Seconde question/ })
      .getAttribute('aria-current'),
  ).toBeNull();
});

test('raccourcis j/k/m/e actifs sur le fil, inactifs dans le composer ou avec Ctrl', async () => {
  mount(streamAgent({ status: 'working' }));
  const ws = FakeWs.all.at(-1)!;
  ws.onopen?.();
  // le groupe d'outils suit la seconde question : « j » doit l'activer avant que « e » agisse sur lui
  ws.text({
    ...histoDeuxQuestions,
    items: [
      ...histoDeuxQuestions.items,
      { seq: 4, at: 't4', event: { type: 'tool_start', toolId: 'a', name: 'ls', input: null } },
      {
        seq: 5,
        at: 't5',
        event: { type: 'tool_end', toolId: 'a', output: 'ligne1\nligne2', isError: false },
      },
    ],
  });
  await screen.findByText('Première question');
  const fil = screen.getByRole('log');

  fireEvent.keyDown(fil, { key: 'j' });
  expect(screen.getByRole('button', { name: /Repères · 2\/2/ })).toBeTruthy();

  fireEvent.keyDown(fil, { key: 'm' });
  expect(await screen.findByRole('button', { name: 'Démarquer la question' })).toBeTruthy();

  // 'e' sur la question active (la seconde, qui porte le groupe d'outils) déplie son détail
  expect(screen.queryByText(/ligne2/)).toBeNull();
  fireEvent.keyDown(fil, { key: 'e' });
  expect(screen.getByText(/ligne2/)).toBeTruthy();

  fireEvent.keyDown(fil, { key: 'k' });
  expect(screen.getByRole('button', { name: /Repères · 1\/2/ })).toBeTruthy();

  // Ctrl+j : aucun effet
  fireEvent.keyDown(fil, { key: 'j', ctrlKey: true });
  expect(screen.getByRole('button', { name: /Repères · 1\/2/ })).toBeTruthy();

  // depuis la zone de saisie : aucun effet (pas de bascule de marque de la première question)
  const champ = screen.getByRole('textbox', { name: /Message à claude/ });
  fireEvent.keyDown(champ, { key: 'm' });
  expect(screen.getAllByRole('button', { name: 'Marquer la question' })).toHaveLength(1);
});

test('raccourcis inactifs en composition, ou depuis un champ éditable descendant du fil', async () => {
  mount(streamAgent());
  const ws = FakeWs.all.at(-1)!;
  ws.onopen?.();
  ws.text(histoDeuxQuestions);
  await screen.findByText('Première question');
  const fil = screen.getByRole('log');

  fireEvent.keyDown(fil, { key: 'j', isComposing: true });
  expect(screen.getByRole('button', { name: /Repères · 1\/2/ })).toBeTruthy();

  // un champ éditable à l'intérieur du fil (ex. un contrôle interne futur) : la frappe bulle
  // jusqu'au fil mais ne doit pas déclencher le raccourci.
  const champInterne = document.createElement('textarea');
  fil.appendChild(champInterne);
  fireEvent.keyDown(champInterne, { key: 'j' });
  expect(screen.getByRole('button', { name: /Repères · 1\/2/ })).toBeTruthy();

  // depuis un bouton interne au fil (l'étoile) : raccourci toujours actif, c'est voulu.
  const etoile = screen.getAllByRole('button', { name: 'Marquer la question' })[0]!;
  fireEvent.keyDown(etoile, { key: 'j' });
  expect(screen.getByRole('button', { name: /Repères · 2\/2/ })).toBeTruthy();
});

test('le fil décrit ses raccourcis via aria-describedby, aria-label court', async () => {
  mount(streamAgent());
  const ws = FakeWs.all.at(-1)!;
  ws.onopen?.();
  ws.text(histoDeuxQuestions);
  await screen.findByText('Première question');
  const fil = screen.getByRole('log', { name: 'Fil de conversation' });
  const id = fil.getAttribute('aria-describedby');
  expect(id).toBeTruthy();
  expect(document.getElementById(id!)?.textContent).toMatch(/j et k/);
});

import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import type { Agent, Topic, Workspace } from '../../src/shared/model.js';
import type { FsListing } from '../../src/shared/fs.js';
import type { StateSnapshot } from '../../src/shared/state.js';
import { AidClient } from '../../web/src/data/client.js';
import { AidProvider } from '../../web/src/data/useAidState.js';

export class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  close() {}
  open() {
    this.onopen?.();
  }
  push(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

export const ws = (over: Partial<Workspace> = {}): Workspace => ({
  id: 'ws_1',
  name: 'aid',
  root: '/r',
  remote: 'origin',
  baseBranch: 'main',
  worktreesDir: '/w',
  namespace: null,
  createdAt: 't',
  ...over,
});

export const topic = (over: Partial<Topic> = {}): Topic => ({
  id: 'tp_1',
  workspaceId: 'ws_1',
  slug: 's',
  title: 'Mon sujet',
  type: 'feat',
  branch: 'feat/s',
  base: 'main',
  worktree: '/w/s',
  state: 'active',
  phase: null,
  indexState: 'disabled',
  index: null,
  worktreeMissing: false,
  prNumber: null,
  prUrl: null,
  stashRef: null,
  createdAt: '2026-10-15T10:00:00.000Z',
  updatedAt: new Date().toISOString(),
  ...over,
});

export const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'ag_1',
  runId: 'run_1',
  kind: 'shell',
  role: 'free',
  transport: 'pty',
  status: 'starting',
  cwd: '/w/s',
  command: ['sh'],
  pid: 1,
  exitCode: null,
  issue: null,
  statusReason: null,
  statusMessage: null,
  statusSource: null,
  statusAt: null,
  statusDetail: null,
  lastTool: null,
  pending: null,
  pausedAt: null,
  createdAt: 't',
  updatedAt: 't',
  ...over,
});

export const snapshot = (over: Partial<StateSnapshot> = {}): StateSnapshot => ({
  lastEventId: null,
  workspaces: [],
  topics: [],
  runs: [],
  agents: [],
  actions: [],
  ...over,
});

export const listing = (over: Partial<FsListing> = {}): FsListing => ({
  path: '/home/moi',
  parent: '/home',
  home: '/home/moi',
  isRepo: false,
  entries: [
    { name: 'docs', path: '/home/moi/docs', isRepo: false },
    { name: 'mon-depot', path: '/home/moi/mon-depot', isRepo: true },
  ],
  truncated: false,
  ...over,
});

export interface Harness {
  calls: Array<{ method: string; url: string; body: unknown }>;
  respond: Map<string, (body: unknown) => Response>;
  state: StateSnapshot | 'down';
  client: AidClient;
}

export function setup(
  ui: ReactElement,
  state: StateSnapshot | 'down',
  route = '/',
  // Pré-enregistrées avant le montage : un effet qui part dès le premier rendu
  // (avant que le test n'ait la main pour appeler h.respond.set) ne les rate pas.
  routes: Record<string, (body: unknown) => Response> = {},
): Harness {
  FakeSocket.all = [];
  const h: Harness = {
    calls: [],
    respond: new Map(Object.entries(routes)),
    state,
    client: undefined as never,
  };
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    h.calls.push({ method, url, body });
    if (url === '/api/state') {
      if (h.state === 'down') throw new TypeError('connexion refusée');
      return new Response(JSON.stringify(h.state), { status: 200 });
    }
    const custom =
      h.respond.get(`${method} ${url}`) ??
      (url.startsWith('/api/fs/dirs') ? h.respond.get('GET /api/fs/dirs') : undefined);
    if (custom) return custom(body);
    if (url.startsWith('/api/fs/dirs'))
      return new Response(JSON.stringify(listing()), { status: 200 });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  h.client = new AidClient({
    fetchImpl,
    socketFactory: (u) => new FakeSocket(u) as unknown as WebSocket,
    backoffMs: [20, 20, 20],
    debounceMs: 5,
  });
  render(
    <MemoryRouter initialEntries={[route]}>
      <AidProvider client={h.client}>{ui}</AidProvider>
    </MemoryRouter>,
  );
  return h;
}

// 204 n'autorise aucun corps (le constructeur Response le refuse même vide) : on l'omet.
export const json = (status: number, body: object) => () =>
  new Response(status === 204 ? null : JSON.stringify(body), { status });

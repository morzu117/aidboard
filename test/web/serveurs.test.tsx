// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import type { Server, ServerStatus, ServerTest } from '../../src/shared/model.js';
import type { AidClient, ClientSnapshot } from '../../web/src/data/client.js';
import { ServeursStore, SERVEURS_RELECTURE_MS } from '../../web/src/data/serveurs.js';
import { Serveurs } from '../../web/src/ecrans/Serveurs.js';
import { FakeSocket, json, setup, snapshot } from './helpers.js';

afterEach(cleanup);
const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement | null;

const serveur = (over: Partial<Server> = {}): Server => ({
  id: 'srv_1',
  name: 'vps-ovh',
  mode: 'command',
  target: 'vps',
  sshOptions: null,
  loadProfile: true,
  workdir: '~',
  shell: 'bash',
  keepSession: true,
  permissionMode: 'default',
  confirmDestructive: true,
  allowedDirs: ['~'],
  groupName: 'Serveurs',
  color: '#5de0a1',
  detectedAgents: ['claude', 'codex'],
  lastTestAt: null,
  rules: [],
  createdAt: 't',
  updatedAt: 't',
  ...over,
});

const etat = (over: Partial<ServerStatus> = {}): ServerStatus => ({
  serverId: 'srv_1',
  state: 'connected',
  latencyMs: 12,
  checkedAt: '2026-10-30T10:00:00.000Z',
  reason: null,
  ...over,
});

const app = (
  <Routes>
    <Route path="/serveurs" element={<Serveurs />} />
    <Route path="/serveurs/nouveau" element={<p>création</p>} />
    <Route path="/serveurs/:id/configuration" element={<p>configuration</p>} />
  </Routes>
);

const ouvrir = (servers: Server[], statuses: ServerStatus[] = []) =>
  setup(app, snapshot(), '/serveurs', {
    'GET /api/servers': json(200, servers),
    'GET /api/servers/status': json(200, statuses),
    'GET /api/nav': json(200, { groups: [], placements: [], prefs: { reduit: false } }),
  });

test('une carte par serveur : état, cible, indicateurs (§11.1)', async () => {
  ouvrir(
    [
      serveur(),
      serveur({
        id: 'srv_2',
        name: 'build',
        mode: 'ssh_alias',
        target: 'build',
        detectedAgents: null,
        keepSession: false,
        workdir: '~/src',
      }),
    ],
    [
      etat(),
      etat({
        serverId: 'srv_2',
        state: 'unreachable',
        latencyMs: null,
        reason: 'Connection refused',
      }),
    ],
  );
  await waitFor(() => expect(node('serveurs.serveur-2')).not.toBeNull());
  expect(node('serveurs.serveur-1.nom')?.textContent).toBe('vps-ovh');
  expect(node('serveurs.serveur-1.etat')?.textContent).toBe('Connecté');
  expect(node('serveurs.serveur-1.cible')?.textContent).toBe('commande locale · vps');
  expect(node('serveurs.serveur-1.latence')?.textContent).toBe('12 ms');
  expect(node('serveurs.serveur-1.agents')?.textContent).toBe('claude · codex');
  expect(node('serveurs.serveur-1.repertoire')?.textContent).toBe('~');
  expect(node('serveurs.serveur-1.session')?.textContent).toBe('Active');
  expect(node('serveurs.serveur-1.raison')).toBeNull();

  expect(node('serveurs.serveur-2.etat')?.textContent).toBe('Injoignable');
  expect(node('serveurs.serveur-2.cible')?.textContent).toBe('alias ssh · build');
  expect(node('serveurs.serveur-2.latence')?.textContent).toBe('—');
  expect(node('serveurs.serveur-2.agents')?.textContent).toBe('non testé');
  expect(node('serveurs.serveur-2.session')?.textContent).toBe('Inactive');
  expect(node('serveurs.serveur-2.raison')?.textContent).toBe('Connection refused');

  // discussions (R.6) : aucune sur ce serveur, « Ouvrir la discussion » actif (il propose d'en créer une)
  expect(node('serveurs.serveur-1.ouvrir')?.getAttribute('aria-disabled')).toBeNull();
  await waitFor(() => expect(node('serveurs.serveur-1.discussions.vide')).not.toBeNull());
  expect(node('serveurs.serveur-1.discussions')?.textContent).toContain('Aucune discussion');
  expect(node('serveurs.ajout')).not.toBeNull();
  expect(node('serveurs.vide')).toBeNull();
  // lien « Serveurs » de la barre du haut, actif ici
  expect(node('serveurs.barre.nav-serveurs')?.getAttribute('aria-current')).toBe('page');
});

test('état vide : une seule carte pointillée qui mène à la création', async () => {
  ouvrir([]);
  await waitFor(() => expect(node('serveurs.vide')).not.toBeNull());
  expect(node('serveurs.ajouter')).toBeNull();
  expect(node('serveurs.ajout')).toBeNull();
  fireEvent.click(node('serveurs.vide.ajouter')!);
  await screen.findByText('création');
});

test('Configurer ouvre la configuration du serveur', async () => {
  ouvrir([serveur()], [etat()]);
  await waitFor(() => expect(node('serveurs.serveur-1')).not.toBeNull());
  fireEvent.click(node('serveurs.serveur-1.configurer')!);
  await screen.findByText('configuration');
});

test('menu ··· : tester, reconnecter, supprimer après confirmation', async () => {
  const h = ouvrir([serveur()], [etat()]);
  h.respond.set('POST /api/servers/srv_1/test', json(202, {}));
  h.respond.set('POST /api/servers/srv_1/ping', json(200, etat()));
  h.respond.set('DELETE /api/servers/srv_1', json(204, {}));
  await waitFor(() => expect(node('serveurs.serveur-1')).not.toBeNull());

  const menu = () => {
    fireEvent.click(node('serveurs.serveur-1.plus')!);
    return within(screen.getByRole('menu', { name: 'Actions pour vps-ovh' }));
  };
  fireEvent.click(menu().getByRole('menuitem', { name: 'Tester la connexion' }));
  await waitFor(() =>
    expect(h.calls.some((c) => c.method === 'POST' && c.url === '/api/servers/srv_1/test')).toBe(
      true,
    ),
  );
  fireEvent.click(menu().getByRole('menuitem', { name: 'Reconnecter' }));
  await waitFor(() =>
    expect(h.calls.some((c) => c.method === 'POST' && c.url === '/api/servers/srv_1/ping')).toBe(
      true,
    ),
  );

  fireEvent.click(menu().getByRole('menuitem', { name: 'Supprimer' }));
  expect(h.calls.some((c) => c.method === 'DELETE')).toBe(false);
  fireEvent.click(node('serveurs.supprimer.confirmer')!);
  await waitFor(() => expect(node('serveurs.serveur-1')).toBeNull());
  expect(h.calls.some((c) => c.method === 'DELETE' && c.url === '/api/servers/srv_1')).toBe(true);
  expect(node('serveurs.vide')).not.toBeNull();
});

test('état en direct : un server.status éphémère met la carte à jour, un test fini relit la liste', async () => {
  const h = ouvrir(
    [serveur({ detectedAgents: null })],
    [etat({ state: 'unknown', latencyMs: null })],
  );
  await waitFor(() => expect(node('serveurs.serveur-1.etat')?.textContent).toBe('Non contrôlé'));
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  const sock = FakeSocket.all.at(-1)!;

  act(() =>
    sock.push({
      kind: 'ephemeral',
      type: 'server.status',
      status: etat({ state: 'connecting', latencyMs: null }),
    }),
  );
  expect(node('serveurs.serveur-1.etat')?.textContent).toBe('Connexion…');
  act(() =>
    sock.push({ kind: 'ephemeral', type: 'server.status', status: etat({ latencyMs: 31 }) }),
  );
  expect(node('serveurs.serveur-1.etat')?.textContent).toBe('Connecté');
  expect(node('serveurs.serveur-1.latence')?.textContent).toBe('31 ms');

  // fin d'un test : les agents détectés viennent de la liste relue
  h.respond.set('GET /api/servers', json(200, [serveur({ detectedAgents: ['claude'] })]));
  h.respond.set('GET /api/servers/status', json(200, [etat({ latencyMs: 31 })]));
  const fini: ServerTest = {
    serverId: 'srv_1',
    startedAt: 't',
    finishedAt: 't2',
    ok: true,
    error: null,
    steps: [],
    raw: '',
  };
  act(() => sock.push({ kind: 'ephemeral', type: 'server.test', test: fini }));
  await waitFor(() => expect(node('serveurs.serveur-1.agents')?.textContent).toBe('claude'));
});

test('lecture en échec : le message est affiché', async () => {
  setup(app, snapshot(), '/serveurs', {
    'GET /api/servers': json(500, { error: 'base indisponible' }),
    'GET /api/nav': json(200, { groups: [], placements: [], prefs: { reduit: false } }),
  });
  await waitFor(() => expect(node('serveurs.erreur')?.textContent).toContain('base indisponible'));
});

test('Reconnecter : la réponse du ping met la carte à jour, même sans éphémère', async () => {
  const h = ouvrir([serveur()], [etat({ state: 'unreachable', latencyMs: null, reason: 'x' })]);
  h.respond.set('POST /api/servers/srv_1/ping', json(200, etat({ latencyMs: 44 })));
  await waitFor(() => expect(node('serveurs.serveur-1.etat')?.textContent).toBe('Injoignable'));
  fireEvent.click(node('serveurs.serveur-1.plus')!);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Reconnecter' }));
  await waitFor(() => expect(node('serveurs.serveur-1.etat')?.textContent).toBe('Connecté'));
  expect(node('serveurs.serveur-1.latence')?.textContent).toBe('44 ms');
});

test('test de connexion : en cours puis échec affichés sur la carte', async () => {
  ouvrir([serveur()], [etat()]);
  await waitFor(() => expect(node('serveurs.serveur-1')).not.toBeNull());
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  const sock = FakeSocket.all.at(-1)!;
  const t: ServerTest = {
    serverId: 'srv_1',
    startedAt: 't',
    finishedAt: null,
    ok: null,
    error: null,
    steps: [],
    raw: '',
  };
  act(() => sock.push({ kind: 'ephemeral', type: 'server.test', test: t }));
  expect(node('serveurs.serveur-1.test')?.textContent).toBe('Test de connexion en cours…');
  act(() =>
    sock.push({
      kind: 'ephemeral',
      type: 'server.test',
      test: { ...t, finishedAt: 't2', ok: false, error: 'tmux absent du serveur' },
    }),
  );
  expect(node('serveurs.serveur-1.test')?.textContent).toBe(
    'Dernier test : tmux absent du serveur',
  );
});

test('suppression en échec : le dialogue reste ouvert avec l’erreur', async () => {
  const h = ouvrir([serveur()], [etat()]);
  h.respond.set('DELETE /api/servers/srv_1', json(500, { error: 'base verrouillée' }));
  await waitFor(() => expect(node('serveurs.serveur-1')).not.toBeNull());
  fireEvent.click(node('serveurs.serveur-1.plus')!);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Supprimer' }));
  fireEvent.click(node('serveurs.supprimer.confirmer')!);
  await waitFor(() =>
    expect(node('serveurs.supprimer.erreur')?.textContent).toContain('base verrouillée'),
  );
  expect(node('serveurs.serveur-1')).not.toBeNull();
});

test('état illisible : la liste s’affiche quand même, serveurs en « non contrôlé »', async () => {
  setup(app, snapshot(), '/serveurs', {
    'GET /api/servers': json(200, [serveur()]),
    'GET /api/servers/status': json(500, { error: 'x' }),
    'GET /api/nav': json(200, { groups: [], placements: [], prefs: { reduit: false } }),
  });
  await waitFor(() => expect(node('serveurs.serveur-1.etat')?.textContent).toBe('Non contrôlé'));
  expect(node('serveurs.erreur')).toBeNull();
});

/** Magasin seul, sur un faux client : réponses tenues à la main pour provoquer les courses. */
function fauxClient() {
  let snap: ClientSnapshot = { state: null, daemon: 'connecte', outputs: {} };
  const abonnes = new Set<() => void>();
  const attentes: Array<{ url: string; rendre: (v: unknown) => void }> = [];
  const client = {
    getSnapshot: () => snap,
    subscribe: (cb: () => void) => {
      abonnes.add(cb);
      return () => abonnes.delete(cb);
    },
    request: (_m: string, url: string) => new Promise((rendre) => attentes.push({ url, rendre })),
  } as unknown as AidClient;
  const pousser = (patch: Partial<ClientSnapshot>) => {
    snap = { ...snap, ...patch };
    for (const cb of abonnes) cb();
  };
  /** rend les lectures en attente : liste puis états */
  const repondre = async (servers: Server[], statuses: ServerStatus[]) => {
    const lot = attentes.splice(0);
    for (const a of lot) a.rendre(a.url === '/api/servers' ? servers : statuses);
    // microtâches seulement : marche aussi sous faux minuteurs
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return { client, pousser, repondre, attentes };
}

test('magasin : un éphémère reçu pendant une lecture n’est pas écrasé par sa réponse', async () => {
  const f = fauxClient();
  const store = new ServeursStore(f.client);
  const stop = store.subscribe(() => {});
  await f.repondre([serveur()], [etat({ state: 'unknown', latencyMs: null })]);
  void store.recharger();
  f.pousser({ serverStatuses: { srv_1: etat({ latencyMs: 9 }) } });
  await f.repondre([serveur()], [etat({ state: 'unreachable', latencyMs: null })]);
  expect(store.getSnapshot().statuses.srv_1).toMatchObject({ state: 'connected', latencyMs: 9 });
  // la lecture suivante, partie après, fait foi
  void store.recharger();
  await f.repondre([serveur()], [etat({ state: 'unreachable', latencyMs: null })]);
  expect(store.getSnapshot().statuses.srv_1!.state).toBe('unreachable');
  stop();
});

test('magasin : un serveur retiré pendant une lecture ne revient pas', async () => {
  const f = fauxClient();
  const store = new ServeursStore(f.client);
  const stop = store.subscribe(() => {});
  store.retirer('srv_1');
  await f.repondre([serveur(), serveur({ id: 'srv_2', name: 'b' })], [etat()]);
  expect(store.getSnapshot().servers!.map((s) => s.id)).toEqual(['srv_2']);
  stop();
});

test('magasin : la fin d’un test pendant une lecture en relance une à sa fin', async () => {
  const f = fauxClient();
  const store = new ServeursStore(f.client);
  const stop = store.subscribe(() => {});
  expect(f.attentes).toHaveLength(2);
  f.pousser({
    serverTests: {
      srv_1: {
        serverId: 'srv_1',
        startedAt: 't',
        finishedAt: 't2',
        ok: true,
        error: null,
        steps: [],
        raw: '',
      },
    },
  });
  expect(f.attentes).toHaveLength(2);
  await f.repondre([serveur({ detectedAgents: null })], [etat()]);
  expect(f.attentes).toHaveLength(2);
  await f.repondre([serveur({ detectedAgents: ['claude'] })], [etat()]);
  expect(store.getSnapshot().servers![0]!.detectedAgents).toEqual(['claude']);
  stop();
});

test('magasin : relecture périodique tant qu’un abonné reste, suspendue onglet caché', async () => {
  vi.useFakeTimers();
  try {
    const f = fauxClient();
    const store = new ServeursStore(f.client);
    const a = store.subscribe(() => {});
    const b = store.subscribe(() => {});
    await f.repondre([], []);
    await vi.advanceTimersByTimeAsync(SERVEURS_RELECTURE_MS);
    expect(f.attentes).toHaveLength(2);
    await f.repondre([], []);
    const cache = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(SERVEURS_RELECTURE_MS);
    expect(f.attentes).toHaveLength(0);
    cache.mockRestore();
    a();
    b();
    await vi.advanceTimersByTimeAsync(SERVEURS_RELECTURE_MS * 3);
    expect(f.attentes).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

test('arrêt non confirmé : « Supprimer quand même » refait la suppression forcée (décision D.2)', async () => {
  const h = ouvrir([serveur()], [etat()]);
  const refus = 'arrêt non confirmé par le serveur (1 agent) : il y tourne peut-être encore';
  h.respond.set('DELETE /api/servers/srv_1', json(409, { error: refus, unconfirmed: 1 }));
  h.respond.set('DELETE /api/servers/srv_1?force=1', json(204, {}));
  await waitFor(() => expect(node('serveurs.serveur-1')).not.toBeNull());
  fireEvent.click(node('serveurs.serveur-1.plus')!);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Supprimer' }));
  expect(node('serveurs.supprimer.confirmer')?.textContent).toBe('Supprimer');
  fireEvent.click(node('serveurs.supprimer.confirmer')!);
  await waitFor(() => expect(node('serveurs.supprimer.erreur')?.textContent).toBe(refus));
  expect(node('serveurs.supprimer.forcer')).not.toBeNull();
  expect(node('serveurs.supprimer.confirmer')?.textContent).toBe('Supprimer quand même');
  fireEvent.click(node('serveurs.supprimer.confirmer')!);
  await waitFor(() => expect(node('serveurs.serveur-1')).toBeNull());
  expect(h.calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([
    '/api/servers/srv_1',
    '/api/servers/srv_1?force=1',
  ]);
});

test('une autre erreur que l’arrêt non confirmé ne propose pas « quand même » (décision D.2)', async () => {
  const h = ouvrir([serveur()], [etat()]);
  h.respond.set('DELETE /api/servers/srv_1', json(409, { error: 'serveur occupé' }));
  await waitFor(() => expect(node('serveurs.serveur-1')).not.toBeNull());
  fireEvent.click(node('serveurs.serveur-1.plus')!);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Supprimer' }));
  fireEvent.click(node('serveurs.supprimer.confirmer')!);
  await waitFor(() => expect(node('serveurs.supprimer.erreur')).not.toBeNull());
  expect(node('serveurs.supprimer.forcer')).toBeNull();
  expect(node('serveurs.supprimer.confirmer')?.textContent).toBe('Supprimer');
});

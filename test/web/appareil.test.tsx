// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCard, parseGraph, parseThread, parseObligations } from '../../src/shared/board.js';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { EtatPourAppareil } from '../../src/shared/host.js';
import { AppAppareil } from '../../web/src/AppAppareil.js';
import * as dernierEtat from '../../web/src/data/dernierEtat.js';
import { SessionExpired, api } from '../../web/src/data/api.js';
import { detecterMode, type Moi, type ModeInterface } from '../../web/src/data/appareil.js';
import { AidClient } from '../../web/src/data/client.js';
import { Appairer, ATTENTE_MS, nomParDefaut } from '../../web/src/ecrans/Appairer.js';
import { Chemin, cheminCourant, FakeSocket } from './helpers.js';

// Chantier 31 (D176, D177, D180) : l'interface sur un appareil. Données synthétiques seulement.

const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement | null;
const reponse = (status: number, body: unknown, texte = false) =>
  new Response(texte ? String(body) : JSON.stringify(body), { status });

beforeEach(() => {
  FakeSocket.all = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

const MOI: Moi = {
  id: 'ap_1',
  nom: 'iPhone',
  expireA: new Date(Date.now() + 8 * 3600_000).toISOString(),
};
const T = '2026-11-07T10:00:00.000Z';

const etat = (over: Partial<EtatPourAppareil> = {}): EtatPourAppareil => ({
  lastEventId: null,
  workspaces: [{ id: 'ws_1', name: 'aid' }],
  topics: [
    {
      id: 'tp_1',
      workspaceId: 'ws_1',
      slug: 'mode-host',
      title: 'Mode host',
      type: 'feat',
      branch: 'feat/31',
      state: 'running',
      phase: 'build',
      prNumber: 12,
      createdAt: T,
      updatedAt: T,
    },
  ],
  runs: [{ id: 'run_1', topicId: 'tp_1', state: 'running', createdAt: T }],
  actions: [],
  agents: [
    {
      id: 'ag_1',
      runId: 'run_1',
      kind: 'claude',
      role: 'dev',
      transport: 'stream',
      status: 'waiting',
      statusReason: 'permission',
      statusAt: T,
      pausedAt: null,
      createdAt: T,
      updatedAt: T,
      attend: true,
    },
  ],
  ...over,
});

const AVEC_MESH = etat({
  mesh: {
    state: {
      connected: true,
      tailscale: 'ok',
      monitor: 'ok',
      pending: 0,
      since: null,
      cell: 'cell-test',
    },
    inbox: [],
  },
});

function harnais(routes: Record<string, (body: unknown) => Response>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const r = routes[`${method} ${url}`];
    return r ? r(body) : reponse(404, { error: 'introuvable' });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function monter(
  mode: Exclude<ModeInterface, { kind: 'mac' }>,
  route: string,
  routes: Record<string, (body: unknown) => Response> = {},
) {
  const h = harnais({ 'GET /api/state': () => reponse(200, etat()), ...routes });
  const client = new AidClient({
    fetchImpl: h.fetchImpl,
    socketFactory: (u) => new FakeSocket(u) as unknown as WebSocket,
    backoffMs: [20, 20, 20],
    debounceMs: 5,
    flux: 'signal',
    origin: { protocol: 'https:', host: 'aid-e2e.ts.net' },
  });
  render(
    <MemoryRouter initialEntries={[route]}>
      <AppAppareil mode={mode} client={client} />
      <Chemin />
    </MemoryRouter>,
  );
  return { ...h, client };
}

const joindre = async () => {
  await waitFor(() => expect(FakeSocket.all.length).toBe(1));
  act(() => FakeSocket.all[0]!.open());
};
const fermer = (code: number, reason: string) =>
  act(() =>
    (FakeSocket.all[0]!.onclose as unknown as (e: { code: number; reason: string }) => void)({
      code,
      reason,
    }),
  );

test('D180 : la détection, appareil sur 200, hors accès sur 401 avec raison, Mac sinon', async () => {
  const mode = (r: () => Response | Promise<Response>) =>
    detecterMode(vi.fn(async () => r()) as unknown as typeof fetch);
  expect(await mode(() => reponse(200, MOI))).toEqual({ kind: 'appareil', moi: MOI });
  for (const raison of ['inconnu', 'expire', 'revoque']) {
    expect(await mode(() => reponse(401, { error: 'Non authentifié', raison }))).toEqual({
      kind: 'hors-acces',
      raison,
    });
  }
  // le Mac : 404 avec sa session, 401 en texte sans elle, injoignable (la coquille hors-ligne)
  expect(await mode(() => reponse(404, { error: 'introuvable' }))).toEqual({ kind: 'mac' });
  expect(await mode(() => reponse(401, 'Non authentifié', true))).toEqual({ kind: 'mac' });
  expect(await mode(() => reponse(401, { raison: 'autre-chose' }))).toEqual({ kind: 'mac' });
  expect(
    await mode(() => {
      throw new TypeError('connexion refusée');
    }),
  ).toEqual({ kind: 'mac' });
});

test('D177 : un 401 du port des appareils garde sa raison ; celui du Mac, aucune', async () => {
  const f = (r: Response) => vi.fn(async () => r) as unknown as typeof fetch;
  const e1 = await api('GET', '/x', undefined, f(reponse(401, { raison: 'revoque' }))).catch(
    (e) => e,
  );
  expect(e1).toBeInstanceOf(SessionExpired);
  expect((e1 as SessionExpired).raison).toBe('revoque');
  const e2 = await api('GET', '/x', undefined, f(reponse(401, 'Non authentifié', true))).catch(
    (e) => e,
  );
  expect((e2 as SessionExpired).raison).toBeNull();
});

test('D180 : /ws/signal au lieu de /ws/events, l’état masqué relu à chaque changed', async () => {
  let n = 0;
  const h = monter({ kind: 'appareil', moi: MOI }, '/', {
    'GET /api/state': () => {
      n += 1;
      return reponse(200, etat({ agents: n > 1 ? [] : etat().agents }));
    },
  });
  await joindre();
  expect(FakeSocket.all[0]!.url).toBe('wss://aid-e2e.ts.net/ws/signal');
  await waitFor(() => expect(node('appareil.sujet.tp_1')).not.toBeNull());
  act(() => FakeSocket.all[0]!.push({ kind: 'changed' }));
  await waitFor(() => expect(node('appareil.accueil.vide')).not.toBeNull());
  expect(h.calls.filter((c) => c.url === '/api/state')).toHaveLength(2);
  // aucun événement ne passe par ce flux : un message d'une autre forme ne relit rien
  act(() => FakeSocket.all[0]!.push({ kind: 'event', event: { id: 'ev_1' } }));
  await new Promise((r) => setTimeout(r, 30));
  expect(h.calls.filter((c) => c.url === '/api/state')).toHaveLength(2);
});

test('D195 : deux onglets sans swarph, permission sans bouton', async () => {
  monter({ kind: 'appareil', moi: MOI }, '/');
  await joindre();
  const navigation = screen.getByRole('navigation', { name: 'Navigation' });
  expect([...navigation.querySelectorAll('a')].map((a) => a.textContent)).toEqual([
    'À traiter',
    'Sujets',
  ]);
  expect(screen.getByText('Ton Mac · tailnet')).toBeTruthy();
  expect(screen.getByText("Une autorisation t'attend, sur le Mac")).toBeTruthy();
  expect(node('appareil.accueil')!.querySelectorAll('button')).toHaveLength(0);
  fireEvent.click(screen.getByRole('link', { name: 'Sujets' }));
  expect(screen.getByRole('heading', { name: 'Sujets' })).toBeTruthy();
});

test('D180 : les adresses du Mac n’existent pas sur un appareil, retour à l’accueil', async () => {
  for (const route of ['/machines', '/reglages', '/boite', '/board']) {
    monter({ kind: 'appareil', moi: MOI }, route);
    await joindre();
    await waitFor(() => expect(cheminCourant(), route).toBe('/'));
    cleanup();
    FakeSocket.all = [];
  }
});

test('D178, D180 : avec le mesh, le Board en lecture, par les routes de la liste', async () => {
  const projets = {
    ok: true,
    data: [{ id: 42, slug: 'p', title: 'P', status: 'active', author: 'a' }],
    readAt: T,
    schemaVersion: null,
  };
  const h = monter({ kind: 'appareil', moi: MOI }, '/board', {
    'GET /api/state': () => reponse(200, AVEC_MESH),
    'GET /api/board/projects': () => reponse(200, projets),
    'GET /api/board/projects/42/cards': () =>
      reponse(200, { ok: true, data: [], readAt: T, schemaVersion: null }),
  });
  await joindre();
  await waitFor(() => expect(node('board.identite')?.textContent).toContain('cell-test'));
  expect(node('appareil.barre.board')).not.toBeNull();
  expect(screen.getByRole('navigation', { name: 'Navigation' }).querySelectorAll('a')).toHaveLength(
    3,
  );
  await waitFor(() =>
    expect(h.calls.some((c) => c.url === '/api/board/projects/42/cards')).toBe(true),
  );
  // rien que la liste de D174
  const permis = ['/api/state', '/api/board/projects', '/api/board/projects/42/cards'];
  expect(h.calls.every((c) => permis.includes(c.url.split('?')[0]!))).toBe(true);
});

test('D177 : la socket fermée en 4401 revoque, l’écran plein Accès coupé', async () => {
  monter({ kind: 'appareil', moi: MOI }, '/');
  await joindre();
  await waitFor(() => expect(node('appareil.sujet.tp_1')).not.toBeNull());
  fermer(4401, 'revoque');
  await waitFor(() =>
    expect(node('appareil.hors-acces.phrase')?.textContent).toBe(
      'Accès coupé. Nouveau QR requis pour revenir.',
    ),
  );
  expect(node('appareil.barre')).toBeNull();
  expect(document.querySelectorAll('a, button')).toHaveLength(0);
});

test('D177 : la socket fermée en 4401 expire, Accès expiré ; une coupure ordinaire reconnecte', async () => {
  monter({ kind: 'appareil', moi: MOI }, '/');
  await joindre();
  fermer(1006, '');
  await waitFor(() => expect(FakeSocket.all.length).toBe(2));
  expect(node('appareil.hors-acces')).toBeNull();
  act(() => FakeSocket.all[1]!.open());
  act(() =>
    (FakeSocket.all[1]!.onclose as unknown as (e: { code: number; reason: string }) => void)({
      code: 4401,
      reason: 'expire',
    }),
  );
  await waitFor(() =>
    expect(node('appareil.hors-acces.phrase')?.textContent).toBe(
      'Accès expiré. Nouveau QR requis pour revenir.',
    ),
  );
});

test('D177 : un 401 expire sur l’état, Accès expiré', async () => {
  monter({ kind: 'appareil', moi: MOI }, '/', {
    'GET /api/state': () => reponse(401, { error: 'Non authentifié', raison: 'expire' }),
  });
  await waitFor(() => expect(node('appareil.hors-acces')?.dataset.fin).toBe('expire'));
});

test('D180 : hors accès au démarrage, l’écran plein dit comment revenir, sans rien lire', async () => {
  const h = monter({ kind: 'hors-acces', raison: 'inconnu' }, '/');
  expect(node('appareil.hors-acces.phrase')?.textContent).toContain('Ajouter un appareil');
  expect(h.calls).toHaveLength(0);
  expect(FakeSocket.all).toHaveLength(0);
});

test('D177 : Appareils connectés, révoquer un autre appareil, sans confirmation', async () => {
  let liste = [
    {
      id: 'ap_1',
      nom: 'iPhone',
      creeA: T,
      dernierContact: null,
      expireA: MOI.expireA,
      etat: 'actif',
      moi: true,
    },
    {
      id: 'ap_2',
      nom: 'iPad',
      creeA: T,
      dernierContact: new Date().toISOString(),
      expireA: MOI.expireA,
      etat: 'actif',
      moi: false,
    },
  ];
  const h = monter({ kind: 'appareil', moi: MOI }, '/appareils', {
    'GET /api/appareils': () => reponse(200, liste),
    'DELETE /api/appareils/ap_2': () => {
      liste = liste.map((a) => (a.id === 'ap_2' ? { ...a, etat: 'revoque' } : a));
      return reponse(200, { ok: true });
    },
  });
  await joindre();
  await waitFor(() => expect(node('appareils.ap_2')).not.toBeNull());
  expect(node('appareils.ap_1')?.textContent).toContain('iPhone · cet appareil');
  expect(node('appareils.ap_1.revoquer')).toBeNull();
  expect(node('appareils.ap_2')?.textContent).toContain("vu à l'instant");
  fireEvent.click(node('appareils.ap_2.revoquer')!);
  await waitFor(() => expect(node('appareils.ap_2')).toBeNull());
  expect(h.calls.some((c) => c.method === 'DELETE' && c.url === '/api/appareils/ap_2')).toBe(true);
});

test('D177 : Me déconnecter, puis l’écran plein, et plus rien ne se lit', async () => {
  const h = monter({ kind: 'appareil', moi: MOI }, '/appareils', {
    'GET /api/appareils': () =>
      reponse(200, [
        {
          id: 'ap_1',
          nom: 'iPhone',
          creeA: T,
          dernierContact: null,
          expireA: MOI.expireA,
          etat: 'actif',
          moi: true,
        },
      ]),
    'POST /api/appareils/moi/deconnexion': () => reponse(200, { ok: true }),
  });
  await joindre();
  await waitFor(() => expect(node('appareils.deconnecter')).not.toBeNull());
  fireEvent.click(node('appareils.deconnecter')!);
  await waitFor(() =>
    expect(node('appareil.hors-acces.phrase')?.textContent).toBe(
      'Appareil déconnecté. Nouveau QR requis pour revenir.',
    ),
  );
  const avant = h.calls.length;
  act(() => FakeSocket.all[0]!.push({ kind: 'changed' }));
  await new Promise((r) => setTimeout(r, 30));
  expect(h.calls.length).toBe(avant);
});

// --- /appairer ---

function appairer(routes: Record<string, (body: unknown) => Response>, hash = '#code-synthetique') {
  window.history.replaceState(null, '', `/appairer${hash}`);
  const h = harnais(routes);
  const recharger = vi.fn();
  render(<Appairer fetchImpl={h.fetchImpl} recharger={recharger} />);
  return { ...h, recharger };
}

test('D180 : le nom proposé suit l’appareil', () => {
  expect(nomParDefaut('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('iPhone');
  expect(nomParDefaut('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)')).toBe('iPad');
  expect(nomParDefaut('Mozilla/5.0 (Linux; Android 15)')).toBe('Android');
  expect(nomParDefaut('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)')).toBe('Mac');
  expect(nomParDefaut('x')).toBe('Appareil');
});

test('D176 : sans code dans le fragment, rien n’est réclamé', () => {
  const h = appairer({}, '');
  expect(node('appairer.sans-code')?.textContent).toContain('QR affiché sur le Mac');
  expect(node('appairer.demander')).toBeNull();
  expect(h.calls).toHaveLength(0);
});

test('D176, D180 : le fragment quitte l’adresse, la réclamation attend un geste, puis le code court, puis recharge', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  let etatDemande = 'attente';
  const h = appairer({
    'POST /appairage/reclamer': () => reponse(200, { demandeId: 'dm_1', codeCourt: '4821' }),
    'GET /appairage/dm_1': () => reponse(200, { etat: etatDemande }),
  });
  expect(window.location.hash).toBe('');
  expect(window.location.pathname).toBe('/appairer');
  // un aperçu de lien qui ouvrirait la page ne réclame rien
  expect(h.calls).toHaveLength(0);
  fireEvent.change(node('appairer.nom')!, { target: { value: 'Mon iPhone' } });
  fireEvent.click(screen.getByText('Demander l’accès'));
  await waitFor(() => expect(node('appairer.code-court')?.textContent).toBe('4821'));
  expect(h.calls[0]).toEqual({
    method: 'POST',
    url: '/appairage/reclamer',
    body: { code: 'code-synthetique', nom: 'Mon iPhone' },
  });
  await act(async () => {
    vi.advanceTimersByTime(ATTENTE_MS);
  });
  await waitFor(() => expect(h.calls.filter((c) => c.url === '/appairage/dm_1')).toHaveLength(1));
  expect(h.recharger).not.toHaveBeenCalled();
  etatDemande = 'approuve';
  await act(async () => {
    vi.advanceTimersByTime(ATTENTE_MS);
  });
  await waitFor(() => expect(h.recharger).toHaveBeenCalledTimes(1));
  expect(node('appairer.approuve')).not.toBeNull();
});

test('D176 : refusée ou expirée pendant l’attente, le message, et l’attente s’arrête', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const h = appairer({
    'POST /appairage/reclamer': () => reponse(200, { demandeId: 'dm_1', codeCourt: '4821' }),
    'GET /appairage/dm_1': () => reponse(404, { error: 'Code inconnu, expiré ou déjà utilisé' }),
  });
  fireEvent.click(screen.getByText('Demander l’accès'));
  await waitFor(() => expect(node('appairer.code-court')).not.toBeNull());
  await act(async () => {
    vi.advanceTimersByTime(ATTENTE_MS);
  });
  await waitFor(() =>
    expect(node('appairer.erreur')?.textContent).toContain('refusée, annulée ou expirée'),
  );
  const n = h.calls.length;
  await act(async () => {
    vi.advanceTimersByTime(ATTENTE_MS * 3);
  });
  expect(h.calls.length).toBe(n);
  expect(h.recharger).not.toHaveBeenCalled();
});

test('D176 : code faux (404) ou trop d’essais (429), le message de chacun', async () => {
  appairer({
    'POST /appairage/reclamer': () =>
      reponse(404, { error: 'Code inconnu, expiré ou déjà utilisé' }),
  });
  fireEvent.click(screen.getByText('Demander l’accès'));
  await waitFor(() =>
    expect(node('appairer.erreur')?.textContent).toContain('Code inconnu, expiré ou déjà utilisé'),
  );
  cleanup();
  appairer({ 'POST /appairage/reclamer': () => reponse(429, { error: 'Trop d’essais' }) });
  fireEvent.click(screen.getByText('Demander l’accès'));
  await waitFor(() =>
    expect(node('appairer.erreur')?.textContent).toBe('Trop d’essais : réessaie dans une minute.'),
  );
});

test('D180 : /appairer s’ouvre même sans accès, sans rien lire de l’état', async () => {
  window.history.replaceState(null, '', '/appairer#x');
  const h = monter({ kind: 'hors-acces', raison: 'inconnu' }, '/appairer');
  expect(node('appairer')).not.toBeNull();
  expect(h.calls).toHaveLength(0);
});

const question = {
  pendingId: 'q_1',
  texte: 'Quel choix ?',
  options: ['Premier', 'Second'],
  coupee: true,
};
const avecAgent = (champs: Partial<EtatPourAppareil['agents'][number]>) =>
  etat({ agents: [{ ...etat().agents[0]!, ...champs }] });

test('D195 : choix indexé, annulation sans appel, confirmation et Tranché conservé pour la même question', async () => {
  const h = monter({ kind: 'appareil', moi: MOI }, '/', {
    'GET /api/state': () => reponse(200, avecAgent({ question })),
    'POST /api/appareils/agents/ag_1/reponse': () => reponse(200, { ok: true }),
  });
  await joindre();
  expect(screen.getByText(/texte coupé, la suite sur le Mac/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Second' }));
  fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
  expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Second' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));
  await screen.findByText('Tranché');
  expect(h.calls.find((c) => c.method === 'POST')?.body).toEqual({ pendingId: 'q_1', option: 1 });
  await act(() => h.client.refresh());
  expect(screen.getByText('Tranché')).toBeTruthy();
});

for (const [raison, texte] of Object.entries({
  mode: 'Cet agent accepte seul ses actions : tranche sur le Mac.',
  nature: "C'est une autorisation : elle se donne sur le Mac.",
  perimee: 'Déjà tranchée, ou la question a changé.',
  deja_tranchee: 'Déjà tranchée, ou la question a changé.',
  option: 'Réponse refusée.',
})) {
  test(`D195 : refus ${raison}`, async () => {
    monter({ kind: 'appareil', moi: MOI }, '/', {
      'GET /api/state': () => reponse(200, avecAgent({ question })),
      'POST /api/appareils/agents/ag_1/reponse': () => reponse(403, { raison }),
    });
    await joindre();
    fireEvent.click(screen.getByRole('button', { name: 'Premier' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));
    await screen.findByText(texte);
  });
}

for (const status of [200, 409]) {
  test(`D195 : marquer le tour, réponse ${status}, puis état relu`, async () => {
    let relu = false;
    const h = monter({ kind: 'appareil', moi: MOI }, '/', {
      'GET /api/state': () =>
        reponse(
          200,
          avecAgent({
            attend: false,
            tour: { id: 'tour_1', resume: 'Tour terminé', marque: relu ? 'relu' : null },
          }),
        ),
      'POST /api/appareils/agents/ag_1/tour': () => reponse(status, {}),
    });
    await joindre();
    fireEvent.click(screen.getByRole('button', { name: 'Marquer relu' }));
    await screen.findByText(status === 409 ? 'Ce tour a changé.' : 'Tour relu');
    expect(h.calls.find((c) => c.method === 'POST')?.body).toEqual({
      tourId: 'tour_1',
      etat: 'relu',
    });
    relu = true;
    await act(() => h.client.refresh());
    expect(screen.queryByText('Tour terminé')).toBeNull();
  });
}

test('D195 : vide sans swarph', async () => {
  monter({ kind: 'appareil', moi: MOI }, '/', {
    'GET /api/state': () => reponse(200, etat({ agents: [] })),
  });
  await joindre();
  expect(screen.getByText("Rien n'attend ta réponse")).toBeTruthy();
  expect(screen.getByText("Tu seras prévenu dès qu'une décision arrive.")).toBeTruthy();
});

test('D195 : hors ligne garde les listes et désactive les écritures', async () => {
  let coupe = false;
  monter({ kind: 'appareil', moi: MOI }, '/', {
    'GET /api/state': () => {
      if (coupe) throw new TypeError('hors ligne');
      return reponse(
        200,
        avecAgent({
          question,
          tour: { id: 'tour_1', resume: 'À vérifier', marque: 'a_reprendre' },
        }),
      );
    },
  });
  await joindre();
  fireEvent.click(screen.getByRole('button', { name: 'Premier' }));
  coupe = true;
  fermer(1006, '');
  await screen.findByText('Mac injoignable');
  expect(screen.getByText('À vérifier')).toBeTruthy();
  expect([...node('appareil.accueil')!.querySelectorAll('button')].every((b) => b.disabled)).toBe(
    true,
  );
});

test('D195 : à reprendre envoie la marque, En cours reste en lecture', async () => {
  const h = monter({ kind: 'appareil', moi: MOI }, '/', {
    'GET /api/state': () =>
      reponse(
        200,
        avecAgent({
          attend: false,
          status: 'working',
          tour: { id: 'tour_2', resume: 'Résumé', marque: null },
        }),
      ),
    'POST /api/appareils/agents/ag_1/tour': () => reponse(200, {}),
  });
  await joindre();
  expect(screen.getByRole('region', { name: 'En cours' }).querySelectorAll('button')).toHaveLength(
    0,
  );
  fireEvent.click(screen.getByRole('button', { name: 'À reprendre sur le Mac' }));
  await waitFor(() =>
    expect(h.calls.find((c) => c.method === 'POST')?.body).toEqual({
      tourId: 'tour_2',
      etat: 'a_reprendre',
    }),
  );
});

test('D195 : le choix survit au nouvel état, seule une autre question le réinitialise', async () => {
  let courante: typeof question | undefined = question;
  let evenement = 0;
  const h = monter({ kind: 'appareil', moi: MOI }, '/', {
    'GET /api/state': () =>
      reponse(200, {
        ...avecAgent({ question: courante }),
        lastEventId: `ev_${++evenement}`,
      }),
  });
  await joindre();
  fireEvent.click(screen.getByRole('button', { name: 'Second' }));
  await act(() => h.client.refresh());
  expect(screen.getByRole('button', { name: 'Confirmer' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Second' }).getAttribute('aria-pressed')).toBe('true');
  courante = { ...question, pendingId: 'q_2' };
  await act(() => h.client.refresh());
  expect(screen.queryByRole('button', { name: 'Confirmer' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Second' }).getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(screen.getByRole('button', { name: 'Second' }));
  courante = undefined;
  await act(() => h.client.refresh());
  expect(screen.queryByRole('button', { name: 'Confirmer' })).toBeNull();
  courante = { ...question, pendingId: 'q_2' };
  await act(() => h.client.refresh());
  expect(screen.queryByRole('button', { name: 'Confirmer' })).toBeNull();
});

test('32.10 : sujets filtrés et nom en gras quand une permission attend', async () => {
  const courant = etat();
  courant.topics.push({ ...courant.topics[0]!, id: 'tp_2', title: 'Autre sujet', state: 'merged' });
  monter({ kind: 'appareil', moi: MOI }, '/sujets', {
    'GET /api/state': () => reponse(200, courant),
  });
  await joindre();
  expect(screen.getByRole('link', { name: 'Mode host' }).querySelector('strong')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Autre sujet' }).querySelector('strong')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'merged' }));
  expect(screen.getByRole('button', { name: 'merged' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByRole('link', { name: 'Mode host' })).toBeNull();
});

test('32.10 : suivre reprend la confirmation de 32.9 et mène au dernier tour', async () => {
  const h = monter({ kind: 'appareil', moi: MOI }, '/sujets/tp_1', {
    'GET /api/state': () =>
      reponse(
        200,
        avecAgent({ question, tour: { id: 'tour_1', resume: 'Résumé du tour', marque: null } }),
      ),
    'POST /api/appareils/agents/ag_1/reponse': () => reponse(200, {}),
  });
  await joindre();
  expect(screen.getByText('Phase ou état : build')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Premier' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));
  await screen.findByText('Tranché');
  expect(h.calls.find((appel) => appel.method === 'POST')?.body).toEqual({
    pendingId: question.pendingId,
    option: 0,
  });
  expect(screen.getByRole('link', { name: 'Livrer' }).getAttribute('href')).toBe(
    '/sujets/tp_1/livraison',
  );
  fireEvent.click(screen.getByRole('link', { name: 'Relire un tour' }));
  expect(screen.getByText('Résumé du tour')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Marquer relu' }));
  await waitFor(() =>
    expect(h.calls.some((appel) => appel.url.endsWith('/tour') && appel.method === 'POST')).toBe(
      true,
    ),
  );
});

for (const route of ['/sujets/tp_1', '/sujets/tp_1/tour']) {
  test(`32.10 : aucune écriture active hors ligne sur ${route}`, async () => {
    let coupe = false;
    const h = monter({ kind: 'appareil', moi: MOI }, route, {
      'GET /api/state': () => {
        if (coupe) throw new TypeError('hors ligne');
        return reponse(
          200,
          avecAgent({ question, tour: { id: 'tour_1', resume: 'Résumé conservé', marque: null } }),
        );
      },
    });
    await joindre();
    coupe = true;
    fermer(1006, '');
    await screen.findByText('Mac injoignable');
    expect(screen.getByText('Résumé conservé')).toBeTruthy();
    expect(
      [...document.querySelectorAll('main button')].every(
        (bouton) => (bouton as HTMLButtonElement).disabled,
      ),
    ).toBe(true);
    expect(h.calls.some((appel) => appel.method === 'POST')).toBe(false);
  });
}

test('32.10 : livraison en lecture, champs et merge toujours désactivé', async () => {
  const h = monter({ kind: 'appareil', moi: MOI }, '/sujets/tp_1/livraison', {
    'GET /api/appareils/sujets/tp_1/livraison': () =>
      reponse(200, {
        head: 'abc1234',
        fichiers: [{ nom: 'src/exemple.ts', ajouts: 3, retraits: 1 }],
        controles: [{ nom: 'gate', etat: 'success' }],
        revue: { etat: 'ancienne', surLaTete: false },
        blocage: 'Revue obsolète',
        prNumber: 12,
      }),
  });
  await joindre();
  await screen.findByText('Tête : abc1234');
  for (const texte of [
    'src/exemple.ts · +3 −1',
    'gate : success',
    'ancienne · Ne porte pas sur la tête',
    'Revue obsolète',
    'PR : #12',
    'Le merge se confirme sur le Mac.',
  ])
    expect(screen.getByText(texte)).toBeTruthy();
  const merger = screen.getByRole('button', { name: 'Merger' });
  expect((merger as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(merger);
  expect(h.calls.every((appel) => appel.method === 'GET')).toBe(true);
});

test('32.10 : informations depuis le seul état masqué', async () => {
  monter({ kind: 'appareil', moi: MOI }, '/informations', {
    'GET /api/state': () => reponse(200, AVEC_MESH),
  });
  await joindre();
  for (const texte of ['Cell swarph : cell-test', 'Sujets : 1', 'Agents : 1'])
    expect(screen.getByText(texte)).toBeTruthy();
});

test('32.10 : badge des décisions puis zéro, aucune permission demandée', async () => {
  const setAppBadge = vi.fn().mockResolvedValue(undefined);
  const clearAppBadge = vi.fn().mockResolvedValue(undefined);
  const requestPermission = vi.fn();
  vi.stubGlobal('Notification', { requestPermission });
  Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: setAppBadge });
  Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: clearAppBadge });
  let courant = avecAgent({ question });
  courant.agents.push({
    ...courant.agents[0]!,
    id: 'ag_2',
    question: undefined,
    attend: true,
    statusReason: 'permission',
  });
  monter({ kind: 'appareil', moi: MOI }, '/notifications', {
    'GET /api/state': () => reponse(200, courant),
  });
  await joindre();
  await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(2));
  expect(await screen.findByText('Ce navigateur ne reçoit pas les notifications.')).toBeTruthy();
  courant = etat({ agents: [] });
  act(() => FakeSocket.all[0]!.push({ kind: 'changed' }));
  await waitFor(() => expect(clearAppBadge).toHaveBeenCalled());
  expect(requestPermission).not.toHaveBeenCalled();
  Reflect.deleteProperty(navigator, 'setAppBadge');
  Reflect.deleteProperty(navigator, 'clearAppBadge');
  vi.unstubAllGlobals();
});

test('32.10 : notifications sans API de badge ni push', async () => {
  monter({ kind: 'appareil', moi: MOI }, '/notifications');
  await joindre();
  expect(await screen.findByText('Ce navigateur ne reçoit pas les notifications.')).toBeTruthy();
});

test('32.10 : lire une carte du 31 dans la coque mobile, sans écriture', async () => {
  const fixture = (nom: string): unknown =>
    JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/board', `${nom}.json`), 'utf8'));
  const ok = (data: unknown) => ({ ok: true, data, readAt: T, schemaVersion: null });
  const h = monter({ kind: 'appareil', moi: MOI }, '/board/cartes/101', {
    'GET /api/state': () => reponse(200, AVEC_MESH),
    'GET /api/board/cards/101': () =>
      reponse(200, {
        card: ok(parseCard(fixture('cards-show-101'))!.value),
        graph: ok(parseGraph(fixture('cards-graph-101'))!.value),
        thread: ok(parseThread(fixture('cards-thread-101'), 1000)!.value),
        obligations: ok(parseObligations(fixture('obligations-list-101'))!.value),
      }),
  });
  await joindre();
  await screen.findByRole('heading', { name: 'Carte de test sans responsable' });
  expect(node('appareil.barre')).toBeTruthy();
  expect(node('carte-board.retour')?.getAttribute('href')).toBe('/board?projet=42');
  expect(node('carte-board.corps.texte')?.textContent).toContain('<b>pas du HTML</b>');
  expect(h.calls.every((appel) => appel.method === 'GET')).toBe(true);
});

const LIVRAISON_DIFF = {
  head: 'a'.repeat(40),
  fichiers: [
    { nom: 'z.ts', ajouts: 2, retraits: 1 },
    { nom: 'a.ts', ajouts: 1, retraits: 0 },
  ],
  controles: [],
  revue: { etat: 'ok', surLaTete: true },
  blocage: null,
  prNumber: null,
};
const URL_LIVRAISON_DIFF = '/api/appareils/sujets/tp_1/livraison';
const urlDiff = (index = 0, tete = LIVRAISON_DIFF.head) =>
  `/api/appareils/sujets/tp_1/fichiers/${index}/diff?tete=${tete}`;

test.each([
  ['sensible', 200, 'Fichier sensible : il se lit sur le Mac.'],
  ['binaire', 200, 'Fichier binaire.'],
  ['coupe', 200, 'Suite sur le Mac.'],
  ['code_coupe', 403, 'La lecture du code est coupée sur le Mac.'],
  ['perimee', 409, 'La livraison a changé.'],
  ['fichier', 404, "Ce fichier n'est plus dans la livraison."],
  ['requete', 400, 'Demande de diff invalide.'],
])('32b.9 : réponse %s', async (etat, status, texte) => {
  const h = monter({ kind: 'appareil', moi: MOI }, '/sujets/tp_1/fichiers/0', {
    [`GET ${URL_LIVRAISON_DIFF}`]: () => reponse(200, LIVRAISON_DIFF),
    [`GET ${urlDiff()}`]: () =>
      reponse(
        status,
        status === 200
          ? { etat, lignes: etat === 'coupe' ? ['+suite'] : undefined }
          : { raison: etat },
      ),
  });
  expect(await screen.findByText(texte)).toBeTruthy();
  if (etat === 'coupe') expect(screen.getByText('+suite')).toBeTruthy();
  h.client.stop();
});

test('32b.9 : index du lien, tête parent et classes des lignes', async () => {
  const garder = vi.spyOn(dernierEtat, 'garder');
  const h = monter({ kind: 'appareil', moi: MOI }, '/sujets/tp_1/livraison', {
    [`GET ${URL_LIVRAISON_DIFF}`]: () => reponse(200, LIVRAISON_DIFF),
    [`GET ${urlDiff(1)}`]: () =>
      reponse(200, {
        etat: 'ok',
        lignes: ['+ajout', '-retrait', '@@ bloc', ' contexte', '+[masqué]'],
      }),
  });
  fireEvent.click(await screen.findByRole('link', { name: 'a.ts · +1 −0' }));
  await screen.findByText('+ajout');
  for (const [texte, classe] of [
    ['+ajout', 'ajout'],
    ['-retrait', 'retrait'],
    ['@@ bloc', 'bloc'],
    ['contexte', 'contexte'],
  ]) {
    expect(screen.getByText(texte!).closest(`.diff-${classe}`)).toBeTruthy();
  }
  expect(screen.getByText('[masqué]').className).toBe('diff-masque');
  expect(h.calls.filter((c) => c.url === URL_LIVRAISON_DIFF)).toHaveLength(1);
  expect(h.calls.some((c) => c.url === urlDiff(1))).toBe(true);
  expect(garder).toHaveBeenCalled();
  for (const [valeur] of garder.mock.calls) expect(valeur).toEqual(etat());
  garder.mockRestore();
  h.client.stop();
});

test('32b.9 : Relire renouvelle la livraison avant le diff', async () => {
  let nombre = 0;
  const tete = 'b'.repeat(40);
  const h = monter({ kind: 'appareil', moi: MOI }, '/sujets/tp_1/fichiers/0', {
    [`GET ${URL_LIVRAISON_DIFF}`]: () =>
      reponse(200, { ...LIVRAISON_DIFF, head: nombre++ ? tete : LIVRAISON_DIFF.head }),
    [`GET ${urlDiff()}`]: () => reponse(409, { raison: 'perimee' }),
    [`GET ${urlDiff(0, tete)}`]: () => reponse(200, { etat: 'ok', lignes: ['+nouveau'] }),
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Relire' }));
  await screen.findByText('+nouveau');
  expect(
    h.calls
      .filter((c) => c.url.includes('/livraison') || c.url.includes('/diff?'))
      .map((c) => c.url),
  ).toEqual([URL_LIVRAISON_DIFF, urlDiff(), URL_LIVRAISON_DIFF, urlDiff(0, tete)]);
  h.client.stop();
});

test('32b.9 : Relire un tour propose les mêmes index de fichiers', async () => {
  const h = monter({ kind: 'appareil', moi: MOI }, '/sujets/tp_1/tour', {
    [`GET ${URL_LIVRAISON_DIFF}`]: () => reponse(200, LIVRAISON_DIFF),
  });
  const lien = await screen.findByRole('link', { name: 'a.ts · +1 −0' });
  expect(lien.getAttribute('href')).toBe('/sujets/tp_1/fichiers/1');
  h.client.stop();
});

// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import type { BoardProject, BoardResult } from '../../src/shared/board.js';
import type { AidClient, ClientSnapshot } from '../../web/src/data/client.js';
import { BOARD_RELECTURE_MS, BoardStore } from '../../web/src/data/board.js';

// 24.6 (D97) : lecture à l'ouverture, au focus, toutes les 60 s ; rien daemon perdu ou onglet caché ;
// une réponse en retard n'écrase pas une plus récente.

afterEach(() => vi.useRealTimers());

const resultat = (readAt: string): BoardResult<BoardProject[]> => ({
  ok: true,
  data: [],
  readAt,
  schemaVersion: null,
});

function fauxClient(daemon: ClientSnapshot['daemon'] = 'connecte') {
  let snap: ClientSnapshot = { state: null, daemon, outputs: {} };
  const abonnes = new Set<() => void>();
  const attentes: Array<{
    url: string;
    rendre: (v: unknown) => void;
    refuser: (e: unknown) => void;
  }> = [];
  const client = {
    getSnapshot: () => snap,
    subscribe: (cb: () => void) => {
      abonnes.add(cb);
      return () => abonnes.delete(cb);
    },
    request: (_m: string, url: string) =>
      new Promise((rendre, refuser) => attentes.push({ url, rendre, refuser })),
  } as unknown as AidClient;
  const pousser = (patch: Partial<ClientSnapshot>) => {
    snap = { ...snap, ...patch };
    for (const cb of abonnes) cb();
  };
  const microtaches = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return { client, pousser, attentes, microtaches };
}

const magasin = (client: AidClient) =>
  new BoardStore<BoardResult<BoardProject[]>>(client, '/api/board/projects', (r) => r.readAt);

test('lecture à l’ouverture ; relire() passe ?fresh=1 ; luA suit le résultat', async () => {
  const f = fauxClient();
  const store = magasin(f.client);
  const stop = store.subscribe(() => {});
  expect(f.attentes.map((a) => a.url)).toEqual(['/api/board/projects']);
  expect(store.getSnapshot().enLecture).toBe(true);
  f.attentes.shift()!.rendre(resultat('2026-11-05T10:00:00.000Z'));
  await f.microtaches();
  expect(store.getSnapshot()).toMatchObject({
    enLecture: false,
    luA: '2026-11-05T10:00:00.000Z',
    erreur: null,
  });
  void store.relire();
  expect(f.attentes.map((a) => a.url)).toEqual(['/api/board/projects?fresh=1']);
  stop();
});

test('une réponse en retard n’écrase pas celle d’une lecture partie après', async () => {
  const f = fauxClient();
  const store = magasin(f.client);
  const stop = store.subscribe(() => {});
  void store.relire();
  const [vieille, recente] = f.attentes.splice(0);
  recente!.rendre(resultat('récente'));
  await f.microtaches();
  vieille!.rendre(resultat('vieille'));
  await f.microtaches();
  expect(store.getSnapshot().luA).toBe('récente');
  // une erreur en retard non plus
  void store.lire();
  void store.lire();
  const [e1, e2] = f.attentes.splice(0);
  e2!.rendre(resultat('dernière'));
  await f.microtaches();
  e1!.refuser(new Error('perdue'));
  await f.microtaches();
  expect(store.getSnapshot()).toMatchObject({ luA: 'dernière', erreur: null, enLecture: false });
  stop();
});

test('échec de la requête : erreur, le dernier résultat reste affiché', async () => {
  const f = fauxClient();
  const store = magasin(f.client);
  const stop = store.subscribe(() => {});
  f.attentes.shift()!.rendre(resultat('t1'));
  await f.microtaches();
  void store.relire();
  f.attentes.shift()!.refuser(new Error('mesh désactivé'));
  await f.microtaches();
  expect(store.getSnapshot()).toMatchObject({ luA: 't1', erreur: 'mesh désactivé' });
  stop();
});

test('toutes les 60 s et au focus, seulement onglet visible et daemon joint ; plus rien une fois fermé', async () => {
  vi.useFakeTimers();
  const f = fauxClient();
  const store = magasin(f.client);
  const stop = store.subscribe(() => {});
  f.attentes.splice(0);
  await vi.advanceTimersByTimeAsync(BOARD_RELECTURE_MS);
  expect(f.attentes).toHaveLength(1);
  window.dispatchEvent(new Event('focus'));
  expect(f.attentes).toHaveLength(2);
  f.attentes.splice(0);
  const cache = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  await vi.advanceTimersByTimeAsync(BOARD_RELECTURE_MS);
  window.dispatchEvent(new Event('focus'));
  expect(f.attentes).toHaveLength(0);
  cache.mockRestore();
  f.pousser({ daemon: 'reconnexion' });
  await vi.advanceTimersByTimeAsync(BOARD_RELECTURE_MS);
  expect(f.attentes).toHaveLength(0);
  // daemon retrouvé : une lecture tout de suite
  f.pousser({ daemon: 'connecte' });
  expect(f.attentes).toHaveLength(1);
  stop();
  f.attentes.splice(0);
  await vi.advanceTimersByTimeAsync(BOARD_RELECTURE_MS * 2);
  window.dispatchEvent(new Event('focus'));
  expect(f.attentes).toHaveLength(0);
});

test('daemon injoignable à l’ouverture : aucune lecture avant son retour', () => {
  const f = fauxClient('reconnexion');
  const store = magasin(f.client);
  const stop = store.subscribe(() => {});
  expect(f.attentes).toHaveLength(0);
  f.pousser({ daemon: 'connecte' });
  expect(f.attentes).toHaveLength(1);
  stop();
});

import { afterEach, expect, test, vi } from 'vitest';
import type { MeshExecResult } from '../../src/daemon/mesh/exec.js';
import { BoardReader, THREAD_LIMIT } from '../../src/daemon/mesh/board.js';
import { SwarphReader } from '../../src/daemon/mesh/lectures.js';
import { classerErreurProxy } from '../../src/daemon/mesh/lecteur.js';
import {
  argumentsLectureValides,
  creerProxyClient,
  VERBES_LECTURE,
  VERBES_PROXY,
  type ResultatProxy,
} from '../../src/daemon/mesh/proxy.js';
import { creerFauxProxy } from '../fixtures/faux-proxy.js';

const proxies: Awaited<ReturnType<typeof creerFauxProxy>>[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((p) => p.fermer()));
});
async function preparer() {
  const proxy = await creerFauxProxy({ reponse: { ok: true, status: 200, body: {} } });
  proxies.push(proxy);
  const read = vi.fn<(args: string[], options?: unknown) => Promise<MeshExecResult>>(async () => ({
    ok: true,
    timedOut: false,
    stdout: '{}',
    stderr: '',
  }));
  let temps = 0;
  const deps = {
    mesh: { read, current: vi.fn() },
    cell: 'peer-a',
    log: vi.fn(),
    proxySocket: proxy.socket,
    now: () => temps,
  };
  return {
    proxy,
    deps,
    board: new BoardReader(deps),
    swarph: new SwarphReader(deps),
    tick: () => {
      temps += 5000;
    },
  };
}

test('table des verbes de lecture : argv traduits exactement, aucun CLI, liens sans appel', async () => {
  const { proxy, deps, board, swarph } = await preparer();
  await board.projects();
  await board.cards(12);
  await board.card(34);
  await board.obligations(56);
  await swarph.peers();
  await swarph.rights();
  await swarph.memory();
  await swarph.memory('tag-a');
  await swarph.memory('', {}, 'lesson');
  const page = await swarph.page('page-a');
  expect(page.links).toMatchObject({ ok: false, kind: 'not-configured' });
  const requetes = proxy.lignes.map((l) => {
    const { verb, args } = JSON.parse(l);
    return { verb, args };
  });
  expect(requetes).toEqual([
    { verb: 'board.projects.list', args: {} },
    { verb: 'board.cards.list', args: { project: 12 } },
    { verb: 'board.card.get', args: { id: 34 } },
    { verb: 'board.cards.graph', args: { id: 34 } },
    { verb: 'board.cards.thread', args: { id: 34, limit: THREAD_LIMIT } },
    { verb: 'board.obligations.list', args: { card_id: 34 } },
    { verb: 'board.obligations.list', args: { card_id: 56 } },
    { verb: 'mesh.peers', args: {} },
    { verb: 'rights', args: {} },
    { verb: 'memory.list', args: { limit: 100 } },
    { verb: 'memory.list', args: { limit: 100, tag: 'tag-a' } },
    { verb: 'memory.list', args: { limit: 100, type: 'lesson' } },
    { verb: 'memory.get', args: { slug: 'page-a' } },
  ]);
  expect(deps.mesh.read).not.toHaveBeenCalled();
  await swarph.codegraph('requete');
  expect(deps.mesh.read).toHaveBeenCalledTimes(1);
  expect(deps.mesh.read.mock.calls[0]![0][0]).toBe('codegraph');
  expect(proxy.lignes).toHaveLength(13);
});

test('CLI : aucune connexion au proxy', async () => {
  const { proxy, deps } = await preparer();
  const cli = { ...deps, proxySocket: '', gateway: 'https://example.com' };
  await new BoardReader(cli).card(1);
  const swarph = new SwarphReader(cli);
  await swarph.peers();
  await swarph.rights();
  await swarph.memory();
  await swarph.page('page-a');
  expect(deps.mesh.read).toHaveBeenCalledTimes(9);
  expect(proxy.nombreConnexions).toBe(0);
});

test('cache de 5 s, fusion même fresh, expiration et sansCache en proxy', async () => {
  const { board, swarph, proxy, tick } = await preparer();
  await Promise.all([
    board.projects(),
    board.projects({ fresh: true }),
    swarph.rights(),
    swarph.rights({ fresh: true }),
  ]);
  expect(proxy.lignes).toHaveLength(2);
  await board.projects();
  await swarph.rights();
  expect(proxy.lignes).toHaveLength(2);
  tick();
  await board.projects();
  await swarph.rights();
  expect(proxy.lignes).toHaveLength(4);
  await board.projects({ fresh: true });
  await swarph.rights({ fresh: true });
  await board.obligations(1);
  await board.obligations(1);
  expect(proxy.lignes).toHaveLength(8);
});

const erreurs: [ResultatProxy, string | null][] = [
  [{ ok: true, status: 200, body: {} }, null],
  ...(
    [
      'proxy_unavailable',
      'connexion',
      'upstream_unreachable',
      'upstream_ambiguous',
      'interrompu',
    ] as const
  ).map((code): [ResultatProxy, string] => [{ ok: false, code }, 'unreachable']),
  ...([401, 403, 404, 500] as const).map((status, i): [ResultatProxy, string] => [
    { ok: false, code: 'upstream_error', status },
    ['credential', 'forbidden', 'not-found', 'unknown'][i]!,
  ]),
  [{ ok: false, code: 'upstream_error' }, 'unknown'],
  [{ ok: false, code: 'delai' }, 'timeout'],
  [{ ok: false, code: 'format' }, 'format'],
  ...(['verb_not_allowed', 'bad_args', 'peer_not_allowed'] as const).map(
    (code): [ResultatProxy, string] => [{ ok: false, code }, 'unknown'],
  ),
];
test.each(erreurs)('D280 classement pur %j', (resultat, kind) => {
  expect(classerErreurProxy(resultat)).toBe(kind);
});

test.each(VERBES_PROXY)('lecture refuse une écriture avant connexion : %s', async (verb) => {
  const { proxy } = await preparer();
  const client = creerProxyClient({ socket: proxy.socket, verbes: VERBES_LECTURE });
  expect(() => client.appeler(verb, {})).toThrow();
  expect(proxy.nombreConnexions).toBe(0);
});

test('Argument types : entiers sans conversion, bornes, slug et champs fermés', () => {
  for (const project of [true, '1', 0, -1, 1.5])
    expect(argumentsLectureValides('board.cards.list', { project })).toBe(false);
  for (const limit of [0, 1001, true, '100'])
    expect(argumentsLectureValides('memory.list', { limit })).toBe(false);
  for (const slug of ['', '../page', 'a/b', 'a'.repeat(201)])
    expect(argumentsLectureValides('memory.get', { slug })).toBe(false);
  expect(argumentsLectureValides('memory.get', { slug: 'a'.repeat(200) })).toBe(true);
  expect(argumentsLectureValides('memory.list', { limit: 1000 })).toBe(true);
  expect(argumentsLectureValides('rights', { inconnu: 1 })).toBe(false);
});

test.each([401, 403, 404, 503])(
  'D280 via socket : statut %s conservé, detail effacé, aucun repli',
  async (status) => {
    const proxy = await creerFauxProxy({
      reponse: { ok: false, error: 'upstream_error', status, detail: 'detail-prive-test' },
    });
    proxies.push(proxy);
    const read = vi.fn();
    const log = vi.fn();
    const board = new BoardReader({
      mesh: { read },
      cell: 'peer-a',
      proxySocket: proxy.socket,
      log,
    });
    const resultat = await board.projects();
    expect(resultat).toMatchObject({
      ok: false,
      kind: { 401: 'credential', 403: 'forbidden', 404: 'not-found', 503: 'unknown' }[status],
    });
    expect(JSON.stringify([resultat, log.mock.calls])).not.toContain('detail-prive-test');
    expect(read).not.toHaveBeenCalled();
  },
);

test('Argument types : bad_args local ne connecte pas et ne convertit pas', async () => {
  const { proxy } = await preparer();
  const client = creerProxyClient({ socket: proxy.socket, verbes: VERBES_LECTURE });
  expect(await client.appeler('board.cards.list', { project: '1' })).toEqual({
    ok: false,
    code: 'bad_args',
  });
  expect(proxy.nombreConnexions).toBe(0);
});

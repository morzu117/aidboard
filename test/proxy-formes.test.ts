import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import {
  parseCard,
  parseCards,
  parseGraph,
  parseObligations,
  parseProjects,
  parseThread,
} from '../src/shared/board.js';
import { parseMemoryList, parseMemoryPage, parsePeers, parseRights } from '../src/shared/swarph.js';
import { BoardReader, THREAD_LIMIT } from '../src/daemon/mesh/board.js';
import { SwarphReader } from '../src/daemon/mesh/lectures.js';
import { creerFauxProxy } from './fixtures/faux-proxy.js';

const fixture = (nom: string, dossier = 'proxy'): unknown =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', dossier, `${nom}.json`), 'utf8'),
  ) as unknown;

// D279 : formes gateway du lab (DM 94888 et 94957), jamais une projection du CLI.
test('pairs proxy : noms obligatoires, version inconnue vide, aucune donnée technique conservée', () => {
  const resultat = parsePeers(fixture('mesh-peers'));
  expect(resultat?.value).toEqual([
    { nom: 'peer-a', version: '1.0' },
    { nom: 'peer-b', version: '' },
    { nom: 'peer-c', version: '' },
  ]);
  for (const pair of resultat!.value) {
    expect(pair).not.toHaveProperty('url');
    expect(pair).not.toHaveProperty('capabilities');
  }
  expect(parsePeers('peer-a 1.0')?.value).toEqual(resultat?.value.slice(0, 1));
  expect(
    parsePeers({ peers: [null, {}, { name: 2 }, { name: '' }, { name: ' ' }] })?.value,
  ).toEqual([]);
  expect(parsePeers({ peers: [{ name: 'peer-a' }] })?.value).toEqual([
    { nom: 'peer-a', version: '' },
  ]);
  expect(parsePeers({ peers: [] })?.value).toEqual([]);
  expect(parsePeers({ peers: 'illisible' })).toBeNull();
});

const lecturesBoard = [
  ['projects-list', parseProjects],
  ['cards-list-42', parseCards],
  ['cards-show-101', parseCard],
  ['cards-graph-101', parseGraph],
  ['cards-thread-101', (json: unknown) => parseThread(json, THREAD_LIMIT)],
  ['obligations-list-101', parseObligations],
] as const;

test.each(lecturesBoard)('board %s : équivalence des formes CLI et gateway', (nom, parseur) => {
  const proxy = parseur(fixture(nom));
  expect(proxy).not.toBeNull();
  expect(proxy).toEqual(parseur(fixture(nom, 'board')));
});

test('rights : équivalence CLI et gateway avec un nom de pair de documentation', () => {
  const cli = fixture('rights', 'board') as Record<string, unknown>;
  expect(parseRights(fixture('rights'))).toEqual(parseRights({ ...cli, peer: 'peer-a' }));
});

test.each(['memory-list', 'memory-list-pages'])(
  'Memory %s : enveloppe et sortie dépaquetée',
  (nom) => {
    const page = (fixture('memory-get') as { result: unknown }).result;
    expect(parseMemoryList(fixture(nom))).toEqual(parseMemoryList([page]));
    expect(parseMemoryList(fixture(nom))?.value).toEqual([
      { slug: 'page-a', title: 'Page A', type: 'note', tags: ['test'] },
    ]);
  },
);

test('Memory get : enveloppe et page nue équivalentes', () => {
  const json = fixture('memory-get') as { result: unknown };
  expect(parseMemoryPage(json)).toEqual(parseMemoryPage(json.result));
  expect(parseMemoryPage(json)?.value.content).toBe('Texte de peer-a.');
});

test('Memory : enveloppe illisible sans repli et listes vides valides', () => {
  for (const result of [null, false, 42, 'illisible', {}, { pages: null }, { result: [] }]) {
    expect(parseMemoryList({ result })).toBeNull();
    expect(parseMemoryPage({ slug: 'page-a', result })).toBeNull();
  }
  for (const result of [[], { pages: [] }]) expect(parseMemoryList({ result })?.value).toEqual([]);
  expect(parseMemoryList({ pages: [] })).toBeNull();
  expect(parseMemoryPage({ result: [] })).toBeNull();
});

const proxies: Awaited<ReturnType<typeof creerFauxProxy>>[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.fermer()));
});

async function preparer(corps: Record<string, unknown>) {
  // Le faux proxy enregistre la requête avant de lire sa réponse : chaque verbe
  // reçoit ainsi sa propre fixture, y compris les quatre lectures parallèles de la fiche.
  const proxy = await creerFauxProxy({
    get reponse() {
      const { verb } = JSON.parse(proxy.lignes.at(-1)!) as { verb: string };
      return { ok: true, status: 200, body: corps[verb] };
    },
  });
  proxies.push(proxy);
  const read = vi.fn();
  const deps = {
    mesh: { read, current: vi.fn() },
    cell: 'peer-a',
    proxySocket: proxy.socket,
    log: vi.fn(),
  };
  return { proxy, read, swarph: new SwarphReader(deps), board: new BoardReader(deps) };
}

test('cells, Memory et fiche complète : formes gateway de bout en bout sans CLI', async () => {
  const { proxy, read, swarph, board } = await preparer({
    'mesh.peers': fixture('mesh-peers'),
    rights: fixture('rights'),
    'memory.list': fixture('memory-list-pages'),
    'memory.get': fixture('memory-get'),
    'board.card.get': fixture('cards-show-101'),
    'board.cards.graph': fixture('cards-graph-101'),
    'board.cards.thread': fixture('cards-thread-101'),
    'board.obligations.list': fixture('obligations-list-101'),
  });
  expect(await swarph.peers()).toMatchObject({
    ok: true,
    data: parsePeers(fixture('mesh-peers'))!.value,
  });
  expect(await swarph.rights()).toMatchObject({
    ok: true,
    data: parseRights(fixture('rights'))!.value,
  });
  expect(await swarph.memory()).toMatchObject({
    ok: true,
    data: parseMemoryList(fixture('memory-list-pages'))!.value,
  });
  const page = await swarph.page('page-a');
  expect(page.page).toMatchObject({
    ok: true,
    data: parseMemoryPage(fixture('memory-get'))!.value,
  });
  expect(page.links).toMatchObject({ ok: false, kind: 'proxy-indisponible' });
  const fiche = await board.card(101);
  for (const [partie, nom, parseur] of [
    ['card', 'cards-show-101', parseCard],
    ['graph', 'cards-graph-101', parseGraph],
    ['thread', 'cards-thread-101', (json: unknown) => parseThread(json, THREAD_LIMIT)],
    ['obligations', 'obligations-list-101', parseObligations],
  ] as const)
    expect(fiche[partie]).toMatchObject({ ok: true, data: parseur(fixture(nom))!.value });
  expect(proxy.lignes).toHaveLength(8);
  expect(JSON.parse(proxy.lignes[0]!).args).toEqual({});
  expect(read).not.toHaveBeenCalled();
});

test('Memory tableau via proxy et enveloppes illisibles classées format', async () => {
  const { swarph, read } = await preparer({
    'memory.list': fixture('memory-list'),
    'memory.get': { result: null },
  });
  expect(await swarph.memory()).toMatchObject({ ok: true });
  expect((await swarph.page('page-a')).page).toMatchObject({ ok: false, kind: 'format' });
  const autre = await preparer({ 'memory.list': { result: { pages: false } } });
  expect(await autre.swarph.memory()).toMatchObject({ ok: false, kind: 'format' });
  expect(read).not.toHaveBeenCalled();
  expect(autre.read).not.toHaveBeenCalled();
});

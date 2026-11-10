import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { BoardReader, THREAD_LIMIT } from '../src/daemon/mesh/board.js';
import { SwarphReader } from '../src/daemon/mesh/lectures.js';
import {
  parseProjects,
  parseCards,
  parseCard,
  parseGraph,
  parseThread,
  parseObligations,
} from '../src/shared/board.js';
import { parsePeers, parseRights, parseMemoryList, parseMemoryPage } from '../src/shared/swarph.js';
const python = process.env.AID_SWARPH_PROXY_PYTHON;
const disponible = !!python && spawnSync(python, ['-c', 'pass'], { timeout: 5000 }).status === 0;
const jeton = 'jeton-de-test';
const nettoyages: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const nettoyer of nettoyages.splice(0).reverse()) await nettoyer();
});

const fixture = (nom: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/proxy', `${nom}.json`), 'utf8'));
const formes: Record<string, string> = {
  '/board/projects': 'projects-list',
  '/board/cards': 'cards-list-42',
  '/board/cards/101': 'cards-show-101',
  '/board/cards/101/graph': 'cards-graph-101',
  '/board/cards/101/thread': 'cards-thread-101',
  '/board/obligations': 'obligations-list-101',
  '/peers': 'mesh-peers',
  '/peers/peer-a/grants': 'rights',
};
// Même dispositif que la suite d'écritures, avec son lanceur Python inchangé.
async function preparer(status = 200, forme = 'memory-list') {
  // Le proxy refuse les ancêtres inscriptibles par la cellule, même un TMPDIR partagé.
  const dossier = await mkdtemp(join(process.cwd(), 'node_modules', '.aid-vrai-'));
  nettoyages.push(() => rm(dossier, { recursive: true, force: true }));
  await chmod(dossier, 0o700);
  const requetes: {
    methode: string;
    chemin: string;
    corps: unknown;
    entetes: import('node:http').IncomingHttpHeaders;
  }[] = [];
  const gateway = createServer(async (req, res) => {
    const morceaux = [];
    for await (const morceau of req) morceaux.push(morceau);
    const corps = Buffer.concat(morceaux).toString();
    requetes.push({
      methode: req.method!,
      chemin: req.url!,
      corps: corps ? JSON.parse(corps) : null,
      entetes: req.headers,
    });
    const chemin = new URL(req.url!, 'http://example.com').pathname;
    const nom =
      chemin === '/memory'
        ? JSON.parse(corps).op === 'get'
          ? 'memory-get'
          : forme
        : formes[chemin]!;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? fixture(nom) : { detail: jeton }));
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  let fermee = false;
  async function fermerGateway() {
    if (fermee) return;
    await new Promise<void>((resolve, reject) => gateway.close((e) => (e ? reject(e) : resolve())));
    fermee = true;
  }
  nettoyages.push(fermerGateway);
  const adresse = gateway.address() as { port: number };
  const socket = join(dossier, 'proxy.sock');
  const cheminConfig = join(dossier, 'config.json');
  await writeFile(join(dossier, 'token'), jeton, { mode: 0o600 });
  await writeFile(join(dossier, 'audit'), '', { mode: 0o640 });
  await chmod(join(dossier, 'audit'), 0o640);
  await writeFile(
    cheminConfig,
    JSON.stringify({
      cell_uid: process.getuid!() === 60000 ? 60001 : 60000,
      gateway_url: `http://127.0.0.1:${adresse.port}`,
      token_file: join(dossier, 'token'),
      socket_path: socket,
      audit_path: join(dossier, 'audit'),
    }),
    { mode: 0o600 },
  );
  const proxy = spawn(python!, ['test/fixtures/vrai-proxy.py', cheminConfig], { stdio: 'ignore' });
  const sortie = once(proxy, 'exit');
  nettoyages.push(async () => {
    proxy.kill();
    await sortie;
  });
  await vi.waitFor(
    () => {
      expect(proxy.exitCode, 'Le vrai proxy doit rester vivant').toBeNull();
      expect(existsSync(socket)).toBe(true);
    },
    { timeout: 3000 },
  );
  const read = vi.fn();
  const log = vi.fn();
  // Le proxy doit imposer peer-a même si le reader annonce une autre cellule.
  const deps = { mesh: { read, current: vi.fn() }, cell: 'peer-c', proxySocket: socket, log };
  return {
    board: new BoardReader(deps),
    swarph: new SwarphReader(deps),
    requetes,
    fermerGateway,
    verifier(resultat: unknown) {
      expect(JSON.stringify(resultat)).not.toContain(jeton);
      expect(JSON.stringify(log.mock.calls)).not.toContain(jeton);
      expect(read).not.toHaveBeenCalled();
      expect(requetes.length).toBeGreaterThan(0);
      for (const r of requetes) expect(r.entetes.authorization).toBe(`Bearer ${jeton}`);
    },
  };
}
type Contexte = Awaited<ReturnType<typeof preparer>>;
const requetesSansEntetes = (t: Contexte) =>
  t.requetes.map(({ methode, chemin, corps }) => ({ methode, chemin, corps }));
const lectures = [
  [
    'projets',
    '/board/projects?actor=peer-a',
    'projects-list',
    parseProjects,
    (t: Contexte) => t.board.projects(),
  ],
  [
    'cartes',
    '/board/cards?actor=peer-a&project=42',
    'cards-list-42',
    parseCards,
    (t: Contexte) => t.board.cards(42),
  ],
  ['cells', '/peers', 'mesh-peers', parsePeers, (t: Contexte) => t.swarph.peers()],
  ['rights', '/peers/peer-a/grants', 'rights', parseRights, (t: Contexte) => t.swarph.rights()],
] as const;
describe.skipIf(!disponible)('44.6 — lectures du vrai swarph proxy serve', () => {
  test.each(lectures)(
    '%s : requête exacte et valeur parsée',
    async (_nom, chemin, nom, parseur, lire) => {
      const t = await preparer();
      const resultat = await lire(t);
      expect(resultat).toMatchObject({ ok: true, data: parseur(fixture(nom))!.value });
      expect(requetesSansEntetes(t)).toEqual([{ methode: 'GET', chemin, corps: null }]);
      t.verifier(resultat);
    },
  );
  test('fiche, graphe, fil, obligations : actor, card_id et limit exacts', async () => {
    const t = await preparer();
    const resultat = await t.board.card(101);
    for (const [partie, nom, parseur] of [
      ['card', 'cards-show-101', parseCard],
      ['graph', 'cards-graph-101', parseGraph],
      ['thread', 'cards-thread-101', (json: unknown) => parseThread(json, THREAD_LIMIT)],
      ['obligations', 'obligations-list-101', parseObligations],
    ] as const)
      expect(resultat[partie]).toMatchObject({ ok: true, data: parseur(fixture(nom))!.value });
    expect(requetesSansEntetes(t).sort((a, b) => a.chemin.localeCompare(b.chemin))).toEqual(
      [
        '/board/cards/101?actor=peer-a',
        '/board/cards/101/graph?actor=peer-a',
        '/board/cards/101/thread?actor=peer-a&limit=1000',
        '/board/obligations?actor=peer-a&card_id=101',
      ]
        .map((chemin) => ({ methode: 'GET', chemin, corps: null }))
        .sort((a, b) => a.chemin.localeCompare(b.chemin)),
    );
    t.verifier(resultat);
  });
  test.each(['memory-list', 'memory-list-pages'])(
    'Memory %s : sans filtre, par tag, par type',
    async (forme) => {
      const t = await preparer(200, forme);
      const resultats = [];
      for (const [tag, type] of [
        ['', ''],
        ['test', ''],
        ['', 'note'],
      ] as const) {
        const resultat = await t.swarph.memory(tag, {}, type);
        expect(resultat).toMatchObject({ ok: true, data: parseMemoryList(fixture(forme))!.value });
        resultats.push(resultat);
      }
      expect(requetesSansEntetes(t)).toEqual(
        [{ limit: 100 }, { tag: 'test', limit: 100 }, { type: 'note', limit: 100 }].map((args) => ({
          methode: 'POST',
          chemin: '/memory',
          corps: { op: 'list', arguments: args },
        })),
      );
      t.verifier(resultats);
    },
  );
  test('Memory get et liens sans requête gateway supplémentaire', async () => {
    const t = await preparer();
    const resultat = await t.swarph.page('page-a');
    expect(resultat.page).toMatchObject({
      ok: true,
      data: parseMemoryPage(fixture('memory-get'))!.value,
    });
    expect(resultat.links).toMatchObject({ ok: false, kind: 'proxy-indisponible' });
    expect(requetesSansEntetes(t)).toEqual([
      { methode: 'POST', chemin: '/memory', corps: { op: 'get', arguments: { slug: 'page-a' } } },
    ]);
    expect((await t.swarph.page('page-a')).links).toMatchObject({
      ok: false,
      kind: 'proxy-indisponible',
    });
    expect(t.requetes).toHaveLength(1);
    t.verifier(resultat);
  });
  test.each([
    [403, 'forbidden'],
    [404, 'not-found'],
    [500, 'unknown'],
  ] as const)('gateway %s : %s sans fuite du détail', async (status, kind) => {
    const t = await preparer(status);
    const resultats = [await t.board.projects(), await t.swarph.memory()];
    for (const resultat of resultats) expect(resultat).toMatchObject({ ok: false, kind });
    expect(t.requetes).toHaveLength(2);
    t.verifier(resultats);
  });
  test('gateway arrêtée : unreachable sans repli CLI', async () => {
    const t = await preparer();
    t.verifier(await t.board.projects());
    await t.fermerGateway();
    const resultats = [await t.board.projects({ fresh: true }), await t.swarph.memory()];
    for (const resultat of resultats)
      expect(resultat).toMatchObject({ ok: false, kind: 'unreachable' });
    expect(t.requetes).toHaveLength(1);
    t.verifier(resultats);
  });
});

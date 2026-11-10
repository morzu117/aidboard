import Fastify from 'fastify';
import { afterEach, expect, test, vi } from 'vitest';
import { registerSwairmRoutes } from '../src/daemon/routes/swairm.js';
import { BoardReader } from '../src/daemon/mesh/board.js';
import { SwairmAsk } from '../src/daemon/swairm/ask.js';
import { SwairmPr } from '../src/daemon/swairm/pr.js';
import { issueRunToken } from '../src/daemon/security.js';
import { startTestDaemon, type TestDaemon } from './helpers/daemon.js';
import { parseConfig } from '../src/daemon/config.js';

let daemon: TestDaemon | undefined;
afterEach(async () => {
  await daemon?.d.stop();
  daemon = undefined;
});

test('route commits : admin seulement, 404 sans lien', async () => {
  daemon = await startTestDaemon();
  const url = '/api/swairm/board/1/commits';
  const h = { host: daemon.headers.host! };
  expect((await daemon.d.app.inject({ url, headers: h })).statusCode).toBe(401);
  const jeton = issueRunToken(daemon.d.auth, 'run-test');
  expect(
    (await daemon.d.app.inject({ url, headers: { ...h, authorization: `Bearer ${jeton}` } }))
      .statusCode,
  ).toBe(403);
  expect((await daemon.d.app.inject({ url, headers: daemon.headers })).statusCode).toBe(404);
});

test('route : lien unique, conflit et plusieurs sujets, sans lecture PR si ambigu', async () => {
  for (const [cards, statut] of [
    [[{ id: 1, body: 'Swairm: exemple/depot#feat/exemple' }], 200],
    [[{ id: 1, body: 'sans lien' }], 404],
    [[{ id: 1, body: 'Swairm: exemple/depot#feat/exemple\nSwairm: exemple/depot#autre' }], 404],
    [
      [
        { id: 1, body: 'Swairm: exemple/depot#feat/exemple' },
        { id: 2, body: 'Swairm: exemple/depot#feat/exemple' },
      ],
      404,
    ],
  ] as const) {
    const app = Fastify();
    const board = new BoardReader({
      mesh: {
        read: async () => ({
          ok: true,
          stdout: JSON.stringify({ cards, searched: cards.length }),
          stderr: '',
          timedOut: false,
        }),
      },
      cell: 'peer-a',
      log: () => undefined,
    });
    const pr = new SwairmPr('/tmp/aid-gh-inexistant/gh');
    const lire = vi.spyOn(pr, 'lire').mockResolvedValue({ pr: null, commits: [], etat: 'ok' });
    registerSwairmRoutes(app, new SwairmAsk(), board, undefined, undefined, pr);
    const r = await app.inject({ url: '/api/swairm/board/1/commits' });
    expect(r.statusCode).toBe(statut);
    expect(lire).toHaveBeenCalledTimes(statut === 200 ? 1 : 0);
    if (statut === 200) {
      expect(lire).toHaveBeenCalledWith('exemple/depot', 'feat/exemple');
      expect(r.json()).toEqual({ pr: null, commits: [], etat: 'ok' });
    }
    await app.close();
  }
});

test('config github.bin : défaut PATH, chemin et validation stricte', () => {
  expect(parseConfig('').github.bin).toBe('');
  expect(parseConfig('github:\n  bin: /tmp/faux-gh').github.bin).toBe('/tmp/faux-gh');
  for (const texte of ['github: non', 'github:\n  bin: 42', 'github:\n  inconnu: true'])
    expect(() => parseConfig(texte)).toThrow();
});

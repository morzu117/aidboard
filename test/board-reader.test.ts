import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import { openDb } from '../src/daemon/db.js';
import { EventStore } from '../src/daemon/events/store.js';
import { BoardReader, classify } from '../src/daemon/mesh/board.js';
import { type MeshExec, type MeshExecResult, meshExec } from '../src/daemon/mesh/exec.js';
import { MeshService } from '../src/daemon/mesh/service.js';

// 24.3 (D92-D95) : exécuteur substitué, ou faux swarph par le chemin du binaire ; jamais de réseau.

const FIXTURES = join(import.meta.dirname, 'fixtures');
const FAKE_SWARPH = join(FIXTURES, 'fake-swarph.sh');
const BOARD = join(FIXTURES, 'board');
const json = (name: string) => readFileSync(join(BOARD, `${name}.json`), 'utf8');
const ok = (stdout: string): MeshExecResult => ({ ok: true, timedOut: false, stdout, stderr: '' });
const fail = (over: Partial<MeshExecResult>): MeshExecResult => ({
  ok: false,
  timedOut: false,
  stdout: '',
  stderr: '',
  ...over,
});

function fake(answer: (args: string[]) => MeshExecResult | Promise<MeshExecResult>) {
  const calls: string[][] = [];
  const log: string[] = [];
  let clock = 1_000_000;
  const reader = new BoardReader({
    mesh: {
      read: async (args) => {
        calls.push(args);
        return answer(args);
      },
    },
    cell: 'morzu-mac',
    log: (l) => log.push(l),
    now: () => clock,
  });
  return { reader, calls, log, tick: (ms: number) => (clock += ms) };
}

// sert les fixtures selon les arguments, comme le faux swarph
const byArgs = (args: string[]): MeshExecResult => {
  const [, noun, verb, a, b] = args;
  if (noun === 'projects') return ok(json('projects-list'));
  if (noun === 'obligations') return ok(json(`obligations-list-${b}`));
  if (verb === 'list') return ok(json(`cards-list-${b}`));
  return ok(json(`cards-${verb}-${a}`));
};

const FORBIDDEN = ['--no-redact', '--token-file', 'inbox', '--consume'];

test('vecteurs d’arguments exacts pour chaque lecture, toujours --json --as <cell>', async () => {
  const t = fake(byArgs);
  await t.reader.projects();
  await t.reader.cards(42);
  await t.reader.card(101);
  expect(t.calls).toEqual([
    ['board', 'projects', 'list', '--json', '--as', 'morzu-mac'],
    ['board', 'cards', 'list', '--project', '42', '--json', '--as', 'morzu-mac'],
    ['board', 'cards', 'show', '101', '--json', '--as', 'morzu-mac'],
    ['board', 'cards', 'graph', '101', '--json', '--as', 'morzu-mac'],
    ['board', 'cards', 'thread', '101', '--limit', '1000', '--json', '--as', 'morzu-mac'],
    ['board', 'obligations', 'list', '--card', '101', '--json', '--as', 'morzu-mac'],
  ]);
  for (const args of t.calls) for (const f of FORBIDDEN) expect(args).not.toContain(f);
});

test('fiche : quatre parties assemblées, une partie en échec n’empêche pas les autres', async () => {
  const t = fake((args) =>
    args[2] === 'graph'
      ? fail({ stderr: 'gateway 403: no read grant on this project', exitCode: 1 })
      : byArgs(args),
  );
  const sheet = await t.reader.card(102);
  expect(sheet.card.ok && sheet.card.data.title).toBe('Carte de test en construction');
  expect(sheet.graph).toEqual({
    ok: false,
    kind: 'forbidden',
    readAt: expect.any(String) as string,
  });
  expect(sheet.thread.ok && sheet.thread.data.messages).toHaveLength(1);
  expect(sheet.obligations.ok && sheet.obligations.data.truncated).toBe(true);
});

test('un identifiant non entier est refusé avant toute exécution', async () => {
  const t = fake(byArgs);
  await expect(t.reader.cards(1.5)).rejects.toThrow(RangeError);
  await expect(t.reader.card(0)).rejects.toThrow(RangeError);
  await expect(t.reader.card(-3)).rejects.toThrow(RangeError);
  await expect(t.reader.card(Number.NaN)).rejects.toThrow(RangeError);
  expect(t.calls).toEqual([]);
});

test('classification : chaque erreur connue, et unknown jamais confondu avec unreachable', () => {
  expect(classify(ok('{}'))).toBeNull();
  expect(
    classify(
      fail({ stderr: 'swarph board: gateway 403: no read grant on this project', exitCode: 1 }),
    ),
  ).toBe('forbidden');
  expect(
    classify(fail({ stderr: 'swarph board: gateway unreachable: timed out', exitCode: 1 })),
  ).toBe('unreachable');
  expect(
    classify(fail({ stderr: "cannot resolve a mesh credential for 'morzu-mac'", exitCode: 1 })),
  ).toBe('credential');
  expect(classify(fail({ stderr: 'gateway 500: internal error', exitCode: 1 }))).toBe('unknown');
  // D95 bis : texte réel du gateway pour une carte absente ; un jeton révoqué est un problème d'identifiant
  expect(
    classify(fail({ stderr: 'swarph board: gateway 404: card 99999999 not found', exitCode: 1 })),
  ).toBe('not-found');
  expect(classify(fail({ stderr: 'swarph board: gateway 401: invalid token', exitCode: 1 }))).toBe(
    'credential',
  );
  expect(classify(fail({ stderr: 'error: argument: invalid choice', exitCode: 2 }))).toBe(
    'too-old',
  );
  expect(classify(fail({ spawnErrorCode: 'ENOENT', stderr: 'spawn swarph ENOENT' }))).toBe(
    'absent',
  );
  expect(classify(fail({ timedOut: true }))).toBe('timeout');
  expect(classify(fail({ spawnErrorCode: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }))).toBe('too-large');
});

test('JSON illisible ou de forme inattendue : format, et le stderr va au journal, jamais au résultat', async () => {
  const t = fake((args) =>
    args[1] === 'projects'
      ? ok('pas du json')
      : fail({ stderr: 'texte privé du gateway', exitCode: 1 }),
  );
  expect(await t.reader.projects()).toEqual({
    ok: false,
    kind: 'format',
    readAt: expect.any(String) as string,
  });
  const r = await t.reader.cards(42);
  expect(r).toEqual({ ok: false, kind: 'unknown', readAt: expect.any(String) as string });
  expect(JSON.stringify(r)).not.toContain('texte privé');
  expect(t.log.some((l) => l.includes('texte privé du gateway'))).toBe(true);
  const t2 = fake(() => ok('{"cards": "pas une liste"}'));
  expect(await t2.reader.cards(42)).toMatchObject({ ok: false, kind: 'format' });
});

test('une sortie au-delà de 4 Mo est refusée et signalée, le tampon n’est pas agrandi', async () => {
  const big: MeshExec = (_bin, _args, opts) =>
    meshExec(process.execPath, ['-e', "process.stdout.write('x'.repeat(5 * 1024 * 1024))"], opts);
  const log: string[] = [];
  const reader = new BoardReader({
    mesh: { read: (args) => big('swarph', args, { env: process.env, timeoutMs: 10_000 }) },
    cell: 'morzu-mac',
    log: (l) => log.push(l),
  });
  expect(await reader.projects()).toMatchObject({ ok: false, kind: 'too-large' });
  expect(log.join('\n')).toContain('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
});

test('cache de 5 s par commande, fresh le contourne', async () => {
  const t = fake(byArgs);
  await t.reader.projects();
  t.tick(4000);
  await t.reader.projects();
  expect(t.calls).toHaveLength(1);
  await t.reader.projects({ fresh: true });
  expect(t.calls).toHaveLength(2);
  t.tick(5000);
  await t.reader.projects();
  expect(t.calls).toHaveLength(3);
  // une autre commande a sa propre entrée
  await t.reader.cards(42);
  expect(t.calls).toHaveLength(4);
});

test('deux appels simultanés ne lancent qu’une exécution, fresh compris', async () => {
  let release: (r: MeshExecResult) => void = () => undefined;
  const t = fake(() => new Promise<MeshExecResult>((res) => (release = res)));
  const a = t.reader.projects();
  const b = t.reader.projects({ fresh: true });
  release(ok(json('projects-list')));
  const [ra, rb] = await Promise.all([a, b]);
  expect(t.calls).toHaveLength(1);
  expect(ra).toEqual(rb);
  expect(ra.ok).toBe(true);
});

test('une exécution qui rejette devient unknown, sans planter', async () => {
  const t = fake(() => Promise.reject(new Error('boom')));
  expect(await t.reader.projects()).toMatchObject({ ok: false, kind: 'unknown' });
});

function meshService(exec: MeshExec) {
  const home = mkdtempSync(join(tmpdir(), 'aid-board-'));
  const db = openDb(join(home, 'state.db'));
  const config = {
    ...DEFAULT_CONFIG.mesh,
    bin: FAKE_SWARPH,
    cell: 'morzu-mac',
    gateway: 'http://mesh-gw.example.ts.net:8788',
    stateRoot: join(home, 'swarph_state'),
    tailscale: { manage: false, bin: join(FIXTURES, 'fake-tailscale.sh') },
  };
  const svc = new MeshService({
    config,
    home,
    db,
    store: new EventStore(db),
    log: () => undefined,
    exec,
  });
  return { svc, home, config };
}

test('par MeshService.read et le faux swarph : JSON servi, journal limité à board … --json --as morzu-mac', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aid-board-log-'));
  const swarphLog = join(home, 'swarph.log');
  const { svc, config } = meshService((bin, args, opts) =>
    meshExec(bin, args, {
      ...opts,
      env: { ...opts.env, FAKE_SWARPH_LOG: swarphLog, FAKE_SWARPH_BOARD: BOARD },
    }),
  );
  const reader = new BoardReader({ mesh: svc, cell: 'morzu-mac', log: () => undefined });
  const projects = await reader.projects();
  expect(projects.ok && projects.data.map((p) => p.slug)).toEqual(['projet-test']);
  const sheet = await reader.card(101);
  expect(sheet.card.ok && sheet.graph.ok && sheet.thread.ok && sheet.obligations.ok).toBe(true);
  const lines = readFileSync(swarphLog, 'utf8').trim().split('\n');
  expect(lines).toHaveLength(5);
  for (const l of lines) expect(l).toMatch(/^board .* --json --as morzu-mac$/);
  expect(existsSync(join(config.stateRoot, 'morzu-mac', 'mesh-sidecar', 'inbox.log'))).toBe(false);
});

test('un connect() en cours dans serial() ne bloque pas une lecture', async () => {
  let releaseConnect: () => void = () => undefined;
  const gate = new Promise<void>((res) => (releaseConnect = res));
  let stuck = 0;
  // tout ce que connect() lance (Tailscale, monitor) reste suspendu tant que la porte est fermée
  const { svc } = meshService(async (_bin, args) => {
    if (args[0] === 'board') return ok(json('projects-list'));
    stuck++;
    await gate;
    return fail({ exitCode: 1 });
  });
  const connecting = svc.connect();
  await new Promise((r) => setTimeout(r, 20));
  expect(stuck).toBe(1);
  const reader = new BoardReader({ mesh: svc, cell: 'morzu-mac', log: () => undefined });
  const r = await reader.projects();
  expect(r.ok).toBe(true);
  releaseConnect();
  await connecting;
  svc.dispose();
});

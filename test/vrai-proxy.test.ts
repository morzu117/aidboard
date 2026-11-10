import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as patienter } from 'node:timers/promises';
import Fastify from 'fastify';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import { creerActionsConfirmation } from '../src/daemon/confirmations/actions.js';
import { creerPorte } from '../src/daemon/confirmations/porte.js';
import { creerReglage } from '../src/daemon/confirmations/reglage.js';
import { BoardReader } from '../src/daemon/mesh/board.js';
import { VERBES_LECTURE, creerProxyClient } from '../src/daemon/mesh/proxy.js';
import { registerEcrituresRoutes } from '../src/daemon/routes/ecritures.js';
import { parseObligations } from '../src/shared/board.js';
import { hashAccept } from '../src/shared/etats.js';
import { preparerPda } from './helpers/pda.js';

const python = process.env.AID_SWARPH_PROXY_PYTHON;
const disponible = !!python && spawnSync(python, ['-c', 'pass'], { timeout: 5000 }).status === 0;
const jeton = 'jeton-de-test';
const texte = 'Message de test';
const fil = '00000000-0000-4000-8000-000000000000';
const nettoyages: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const nettoyer of nettoyages.splice(0).reverse()) await nettoyer();
});

async function preparer(status = 201, closed_obligations: number[] = [], lectureSeule = false) {
  // Le proxy refuse les ancêtres inscriptibles par la cellule, même un TMPDIR partagé.
  const dossier = await mkdtemp(join(process.cwd(), 'node_modules', '.aid-vrai-'));
  nettoyages.push(() => rm(dossier, { recursive: true, force: true }));
  await chmod(dossier, 0o700);
  const requetes: { methode: string; chemin: string; corps: unknown; autorisation?: string }[] = [];
  const gateway = createServer(async (req, res) => {
    const morceaux = [];
    for await (const morceau of req) morceaux.push(morceau);
    const corps = Buffer.concat(morceaux).toString();
    requetes.push({
      methode: req.method!,
      chemin: req.url!,
      corps: corps ? JSON.parse(corps) : null,
      autorisation: req.headers.authorization,
    });
    res.writeHead(req.method === 'GET' ? 200 : status, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        req.method === 'GET'
          ? { id: 42, thread_uuid: fil, assignee: 'peer-b' }
          : { id: 72, open_obligations: [81], closed_obligations, detail: texte },
      ),
    );
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  nettoyages.push(
    () => new Promise<void>((resolve, reject) => gateway.close((e) => (e ? reject(e) : resolve()))),
  );
  const adresse = gateway.address() as { port: number };
  const socket = join(dossier, 'proxy.sock');
  const cheminConfig = join(dossier, 'config.json');
  await writeFile(join(dossier, 'token'), jeton, { mode: 0o600 });
  await writeFile(join(dossier, 'audit'), '', { mode: 0o640 });
  await chmod(join(dossier, 'audit'), 0o640);
  await writeFile(
    cheminConfig,
    JSON.stringify({
      read_only: lectureSeule,
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
  const t = preparerPda();
  nettoyages.push(t.nettoyer);
  const config = structuredClone(DEFAULT_CONFIG);
  config.mesh.cell = 'peer-a';
  config.mesh.proxySocket = socket;
  const board = new BoardReader({ mesh: { read: vi.fn() }, cell: 'peer-a', log: vi.fn() });
  vi.spyOn(board, 'obligations').mockResolvedValue({
    ok: true,
    data: {
      obligations: parseObligations({
        obligations: [{ id: 81, status: 'open', holder: 'peer-a', accept: 'Accept' }],
      })!.value.obligations,
      truncated: false,
      asOf: null,
    },
    schemaVersion: null,
    readAt: '',
  });
  const actions = creerActionsConfirmation({ ...t, config, board });
  const porte = creerPorte({ db: t.db, actions, file: () => null });
  expect(creerReglage(t.db).arme()).toBe(false);
  const app = Fastify();
  nettoyages.push(() => app.close());
  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (req) => {
    req.principal = { kind: 'admin', via: 'bearer' };
  });
  registerEcrituresRoutes(app, {
    cell: 'peer-a',
    board,
    porte,
    proxySocket: config.mesh.proxySocket,
    proxyLectureSeule: config.mesh.proxyLectureSeule,
  });
  return {
    requetes,
    socket,
    async envoyer(action: string, params: object) {
      const reponse = await app.inject({
        method: 'POST',
        url: `/api/swarph/${action.startsWith('obligation.') ? 'etat' : 'ecrire'}/envoyer`,
        payload: { action, params },
      });
      expect(reponse.statusCode).toBe(200);
      expect(reponse.body).not.toContain(jeton);
      expect(JSON.stringify(t.journal.mock.calls)).not.toContain(jeton);
      expect(requetes.every((r) => r.autorisation === `Bearer ${jeton}`)).toBe(true);
      return reponse.json();
    },
  };
}

describe.skipIf(!disponible)('L4 — vrai swarph proxy serve (35b.5 et 36.5)', () => {
  test.each([
    [
      'carte.note',
      { carte: 42, a: 'peer-b', kind: 'fyi', texte },
      { to_node: 'peer-b', thread_id: fil, kind: 'fyi' },
    ],
    [
      'dm.envoyer',
      { pair: 'peer-b', fil: null, kind: 'answer', texte },
      { to_node: 'peer-b', kind: 'answer' },
    ],
    [
      'canal.poster',
      { canal: 'general', kind: 'status', texte },
      { channel: 'general', kind: 'status' },
    ],
  ])(
    '%s : identité fixée par le proxy et réponse lue par A-I-D',
    async (action, params, attendu) => {
      const t = await preparer();
      expect(await t.envoyer(action, params)).toEqual({
        code: 'succes',
        id: 72,
        open_obligations: [81],
        status: 201,
      });
      expect(t.requetes.map(({ methode, chemin, corps }) => ({ methode, chemin, corps }))).toEqual([
        ...(action === 'carte.note'
          ? [{ methode: 'GET', chemin: '/board/cards/42?actor=peer-a', corps: null }]
          : []),
        {
          methode: 'POST',
          chemin: '/messages',
          corps: { from_node: 'peer-a', content: texte, ...attendu },
        },
      ]);
    },
  );

  test.each([
    [201, [81], 'obligation-close'],
    [500, [], 'upstream_error'],
  ] as const)('réponse messages %s / %j', async (status, closes, code) => {
    const t = await preparer(status, [...closes]);
    expect(
      await t.envoyer('dm.envoyer', { pair: 'peer-b', fil: null, kind: 'fyi', texte }),
    ).toEqual({ code, open_obligations: [], status });
    expect(t.requetes).toHaveLength(1);
  });

  const cible = { carte: 42, obligation: 81, attendu: { status: 'open' } };
  test.each(['take', 'decline', 'close-evidence', 'close-evidence_json'])(
    'état %s : chemin et corps exacts',
    async (verbe) => {
      const t = await preparer(200);
      const hash = await hashAccept('Accept');
      const preuve = verbe === 'close-evidence' ? { preuve: texte } : { preuves: { c1: texte } };
      const action =
        verbe === 'take'
          ? 'obligation.prendre'
          : verbe === 'decline'
            ? 'obligation.refuser'
            : 'obligation.clore';
      const params = verbe.startsWith('close')
        ? {
            ...cible,
            attendu: { status: 'open', acceptSha256: hash },
            issue: 'pass',
            ...preuve,
          }
        : { ...cible, ...(verbe === 'decline' && { motif: texte }) };
      expect(await t.envoyer(action, params)).toEqual({ code: 'succes', status: 200 });
      expect(t.requetes).toEqual([
        {
          methode: 'POST',
          chemin: `/board/obligations/81/${verbe.split('-')[0]}`,
          autorisation: `Bearer ${jeton}`,
          corps: {
            expect_status: 'open',
            ...(verbe === 'decline' && { why: texte }),
            ...(verbe.startsWith('close') && {
              expect_accept_sha256: hash,
              outcome: 'pass',
              ...(verbe === 'close-evidence'
                ? { evidence: texte }
                : { evidence_json: { c1: texte } }),
            }),
          },
        },
      ]);
    },
  );

  test('409 sans nouvelle tentative', async () => {
    const t = await preparer(409);
    expect(await t.envoyer('obligation.refuser', { ...cible, motif: texte })).toEqual({
      code: 'upstream_error',
      status: 409,
    });
    await patienter(50);
    expect(t.requetes).toHaveLength(1);
  });

  test('from_node forcé sur le fil : bad_args sans appel gateway', async () => {
    const t = await preparer();
    const resultat = await creerProxyClient({ socket: t.socket }).appeler('mesh.send', {
      to_node: 'peer-b',
      content: texte,
      from_node: 'peer-c',
    });
    expect(resultat).toEqual({ ok: false, code: 'bad_args' });
    expect(JSON.stringify(resultat)).not.toContain(jeton);
    expect(t.requetes).toHaveLength(0);
  });
});

test.skipIf(!disponible)(
  'D283 : le vrai proxy refuse les écritures mais sert les lectures',
  async () => {
    const t = await preparer(201, [], true);
    expect(
      await creerProxyClient({ socket: t.socket }).appeler('mesh.send', {
        to_node: 'peer-b',
        content: texte,
      }),
    ).toEqual({ ok: false, code: 'verb_not_allowed' });
    expect(t.requetes).toHaveLength(0);
    expect(
      await creerProxyClient({ socket: t.socket, verbes: VERBES_LECTURE }).appeler(
        'board.card.get',
        { id: 42 },
      ),
    ).toMatchObject({ ok: true });
    expect(t.requetes.map((r) => r.methode)).toEqual(['GET']);
  },
);

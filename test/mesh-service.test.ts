import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { DEFAULT_CONFIG, type MeshConfig } from '../src/daemon/config.js';
import { openDb } from '../src/daemon/db.js';
import { EventStore } from '../src/daemon/events/store.js';
import { meshExec } from '../src/daemon/mesh/exec.js';
import { parseInboxLine } from '../src/daemon/mesh/inbox.js';
import { MeshService, parseMonitorStatus } from '../src/daemon/mesh/service.js';
import { startTestDaemon, waitFor } from './helpers/daemon.js';

// 12.3 (D35, D37, D40) : faux swarph et faux Tailscale, AID_HOME et HOME temporaires, jamais de réseau.

const FAKE_SWARPH = join(import.meta.dirname, 'fixtures', 'fake-swarph.sh');
const FAKE_TAILSCALE = join(import.meta.dirname, 'fixtures', 'fake-tailscale.sh');

const record = (id: number, kind = 'question') =>
  JSON.stringify({
    id,
    thread_id: `th_${id}`,
    from_node: 'mesh-gw',
    to_node: 'morzu-mac',
    kind,
    content: `message ${id}`,
    created_at: `2026-10-20T10:00:${String(id % 60).padStart(2, '0')}+02:00`,
    read_at: null,
    priority: 'normal',
    reply_to: null,
    obligation_id: null,
    related_task_id: null,
  });

function setup(over: Partial<MeshConfig> = {}, fakeEnv: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'aid-mesh-'));
  const db = openDb(join(home, 'state.db'));
  const store = new EventStore(db);
  const log: string[] = [];
  const swarphLog = join(home, 'swarph.log');
  const tailscaleLog = join(home, 'tailscale.log');
  const tailscaleState = join(home, 'tailscale.state');
  const env = {
    FAKE_SWARPH_LOG: swarphLog,
    FAKE_TAILSCALE_LOG: tailscaleLog,
    FAKE_TAILSCALE_STATEFILE: tailscaleState,
    ...fakeEnv,
  };
  const config: MeshConfig = {
    ...DEFAULT_CONFIG.mesh,
    bin: FAKE_SWARPH,
    cell: 'morzu-mac',
    gateway: 'http://mesh-gw.example.ts.net:8788',
    stateRoot: join(home, 'swarph_state'),
    tailscale: { manage: false, bin: FAKE_TAILSCALE },
    ...over,
  };
  const svc = new MeshService({
    config,
    home,
    db,
    store,
    log: (l) => log.push(l),
    exec: (bin, args, opts) => meshExec(bin, args, { ...opts, env: { ...opts.env, ...env } }),
    pollMs: 50,
    refreshMs: 50,
    now: () => 'T',
  });
  const lines = (f: string) =>
    existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : [];
  const writeInbox = (records: string[]) => {
    mkdirSync(dirname(svc.inboxLog), { recursive: true });
    writeFileSync(svc.inboxLog, records.map((r) => `${r}\n`).join(''));
  };
  return {
    home,
    db,
    store,
    svc,
    log,
    config,
    swarph: () => lines(swarphLog),
    tailscale: () => lines(tailscaleLog),
    setTailscale: (state: 'Running' | 'Stopped') => writeFileSync(tailscaleState, `${state}\n`),
    states: () =>
      store
        .since(null)
        .filter((e) => e.type === 'mesh.state')
        .map((e) => e.data),
    dms: () => store.since(null).filter((e) => e.type === 'mesh.dm'),
    writeInbox,
    marker: join(config.stateRoot, 'morzu-mac', 'monitor.pid'),
  };
}

test('connect : monitor start une fois, suivi démarré, un seul mesh.state « connecté »', async () => {
  const t = setup();
  const state = await t.svc.connect();
  expect(state).toEqual({
    ecritures: false,
    proxyConfigure: false,
    superviseur: null,
    connected: true,
    tailscale: 'running',
    monitor: 'running',
    pending: 0,
    since: 'T',
    cell: 'morzu-mac',
  });
  expect(t.swarph().filter((l) => l.startsWith('monitor start'))).toEqual([
    'monitor start --as morzu-mac --deliver pull',
  ]);
  expect(existsSync(t.marker)).toBe(true);
  expect(t.states()).toHaveLength(1);
  // un refresh sans changement n'émet rien
  await t.svc.refresh();
  expect(t.states()).toHaveLength(1);
  t.svc.dispose();
});

test('inbox.log : 3 DM ⇒ 3 mesh.dm, 0 au second passage, 2 de plus après réécriture ; lignes illisibles comptées', async () => {
  const t = setup();
  t.writeInbox([record(1, 'fyi'), record(2), 'pas du json', record(3, 'unblock')]);
  await t.svc.connect();
  expect(t.dms().map((e) => e.data.id)).toEqual([1, 2, 3]);
  expect(t.dms()[0]!.data).toMatchObject({
    threadId: 'th_1',
    from: 'mesh-gw',
    to: 'morzu-mac',
    kind: 'fyi',
    content: 'message 1',
    createdAt: '2026-10-20T10:00:01+02:00',
  });
  expect(t.svc.tick()).toBe(0);
  expect(t.log).toContain(`mesh : 1 ligne(s) illisible(s) dans ${t.svc.inboxLog}`);
  // réécrit par un autre outil swarph : les anciens ids disparaissent, deux nouveaux arrivent
  t.writeInbox([record(5), record(4, 'answer')]);
  expect(t.svc.tick()).toBe(2);
  expect(t.dms().map((e) => e.data.id)).toEqual([1, 2, 3, 4, 5]);
  expect(t.db.prepare('SELECT COUNT(*) AS n FROM mesh_inbox').get()).toEqual({ n: 5 });
  // le suiveur lit aussi tout seul (fs.watch ou repli 50 ms)
  t.writeInbox([record(6)]);
  await waitFor(() => t.dms().length === 6, 5000, 'DM 6 suivi');
  t.svc.dispose();
});

test('manage: false et Tailscale arrêté : ni up ni monitor start, connected reste false, la raison est dans l’état', async () => {
  const t = setup();
  t.setTailscale('Stopped');
  const state = await t.svc.connect();
  expect(state).toMatchObject({ connected: false, tailscale: 'stopped', since: 'T' });
  expect(t.tailscale().every((l) => l.startsWith('status'))).toBe(true);
  expect(t.swarph().some((l) => l.startsWith('monitor start'))).toBe(false);
  t.svc.dispose();
});

test('manage: true : up à la connexion, down à la déconnexion — seulement si c’est nous qui avons monté', async () => {
  const a = setup({ tailscale: { manage: true, bin: FAKE_TAILSCALE } });
  a.setTailscale('Stopped');
  expect((await a.svc.connect()).connected).toBe(true);
  expect(a.tailscale()).toContain('up');
  expect(a.swarph()).toContain('monitor start --as morzu-mac --deliver pull');
  const off = await a.svc.disconnect();
  expect(off).toMatchObject({ connected: false, monitor: 'stopped', tailscale: 'stopped' });
  expect(a.swarph()).toContain('monitor stop --as morzu-mac');
  expect(a.tailscale()).toContain('down');
  expect(existsSync(a.marker)).toBe(false);

  const b = setup({ tailscale: { manage: true, bin: FAKE_TAILSCALE } });
  await b.svc.connect();
  await b.svc.disconnect();
  expect(b.tailscale().some((l) => l === 'up' || l === 'down')).toBe(false);
});

test('status « running: false, pidfile stale » ⇒ monitor stale, pas connecté', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aid-mesh-status-'));
  const statusFile = join(home, 'status.json');
  writeFileSync(
    statusFile,
    '{"running": false, "pid": 123, "pidfile_status": "stale", "sinks": [{"pending": 16}]}',
  );
  const t = setup({}, { FAKE_SWARPH_STATUS: statusFile });
  const state = await t.svc.connect();
  expect(state).toMatchObject({ connected: false, monitor: 'stale', pending: 16 });
  t.svc.dispose();
});

test('init : un monitor détaché déjà vivant est suivi sans être relancé, et `since` est repris', async () => {
  const t = setup();
  mkdirSync(dirname(t.marker), { recursive: true });
  writeFileSync(t.marker, '4242\n');
  t.db
    .prepare('INSERT INTO mesh_state (k, v) VALUES (?, ?), (?, ?)')
    .run('connected', 'true', 'since', '"hier"');
  t.writeInbox([record(10)]);
  await t.svc.init();
  expect(t.svc.current()).toMatchObject({ connected: true, monitor: 'running', since: 'hier' });
  expect(t.swarph().some((l) => l.startsWith('monitor start'))).toBe(false);
  expect(t.dms().map((e) => e.data.id)).toEqual([10]);
  t.svc.dispose();

  const u = setup();
  await u.svc.init();
  expect(u.svc.current()).toMatchObject({ connected: false, monitor: 'stopped', since: 'T' });
  expect(u.swarph().some((l) => l.startsWith('monitor start'))).toBe(false);
});

test('refresh : le monitor disparu ⇒ déconnecté, suivi arrêté ; dispose ne touche ni au monitor ni à Tailscale', async () => {
  const t = setup();
  await t.svc.connect();
  writeFileSync(join(t.config.stateRoot, 'morzu-mac', 'monitor.pid'), '');
  const { rmSync } = await import('node:fs');
  rmSync(t.marker);
  const state = await t.svc.refresh();
  expect(state).toMatchObject({ connected: false, monitor: 'stopped' });
  t.writeInbox([record(1)]);
  expect(t.svc.tick()).toBe(0);

  const d = setup();
  await d.svc.connect();
  d.svc.dispose();
  expect(d.swarph().some((l) => l.startsWith('monitor stop'))).toBe(false);
  expect(d.tailscale()).not.toContain('down');
  expect(existsSync(d.marker)).toBe(true);
});

test('environnement de swarph : MESH_GATEWAY_URL et SWARPH_STATE, jamais un token', async () => {
  const seen: NodeJS.ProcessEnv[] = [];
  const home = mkdtempSync(join(tmpdir(), 'aid-mesh-env-'));
  const db = openDb(join(home, 'state.db'));
  const svc = new MeshService({
    config: { ...DEFAULT_CONFIG.mesh, cell: 'c', gateway: 'http://gw:1' },
    home,
    db,
    store: new EventStore(db),
    log: () => undefined,
    exec: async (_bin, _args, opts) => {
      seen.push(opts.env);
      return { ok: true, timedOut: false, stdout: '{"running": true}', stderr: '' };
    },
    tailscale: async () => 'running',
  });
  await svc.connect();
  expect(seen.length).toBeGreaterThan(0);
  for (const env of seen) {
    expect(env.MESH_GATEWAY_URL).toBe('http://gw:1');
    expect(env.SWARPH_STATE).toBe(join(home, 'swarph_state'));
    expect(Object.keys(env).some((k) => /TOKEN/i.test(k) && k.startsWith('MESH'))).toBe(false);
  }
  svc.dispose();
});

test('parseMonitorStatus et parseInboxLine : tolérants aux champs manquants', () => {
  expect(
    parseMonitorStatus('{"running": true, "sinks": [{"pending": 2}, {"pending": 3}]}'),
  ).toEqual({ monitor: 'running', pending: 5, superviseur: null });
  expect(parseMonitorStatus('{"running": false, "pidfile_status": "missing"}')).toEqual({
    monitor: 'stopped',
    pending: 0,
    superviseur: null,
  });
  expect(parseMonitorStatus('rien')).toEqual({ monitor: 'stopped', pending: 0, superviseur: null });
  expect(parseInboxLine('{"id": 7, "kind": "fyi"}')).toEqual({
    id: 7,
    threadId: null,
    from: '',
    to: '',
    kind: 'fyi',
    content: '',
    createdAt: null,
    replyTo: null,
    obligationId: null,
  });
  expect(parseInboxLine('{"id": "7"}')).toBeNull();
  expect(parseInboxLine('[1]')).toBeNull();
});

test('daemon : le service existe seulement avec une cell, relit l’état au démarrage, ne connecte pas', async () => {
  const sans = await startTestDaemon();
  expect(sans.d.mesh).toBeNull();
  await sans.d.stop();

  const home = mkdtempSync(join(tmpdir(), 'aid-mesh-d-'));
  const avec = await startTestDaemon(home, {
    config: {
      mesh: {
        ...DEFAULT_CONFIG.mesh,
        bin: FAKE_SWARPH,
        cell: 'morzu-mac',
        stateRoot: join(home, 'swarph_state'),
        tailscale: { manage: false, bin: FAKE_TAILSCALE },
      },
    },
  });
  expect(avec.d.mesh).not.toBeNull();
  const state = await waitFor(
    () => avec.store.since(null).find((e) => e.type === 'mesh.state')?.data,
    5000,
    'mesh.state au démarrage',
  );
  expect(state).toMatchObject({ connected: false, monitor: 'stopped', cell: 'morzu-mac' });
  await avec.d.stop();
});

test('D99 bis : chaque lecture de monitor status date checkedAt et part en éphémère, sans mesh.state stocké', async () => {
  const t = setup();
  const checked: unknown[] = [];
  t.store.on('ephemeral', (m: { type: string; checkedAt?: string }) => {
    if (m.type === 'mesh.checked') checked.push(m.checkedAt);
  });
  expect(t.svc.checkedAt()).toBeNull();
  await t.svc.connect();
  const etats = t.states().length;
  const lus = checked.length;
  expect(lus).toBeGreaterThan(0);
  await t.svc.refresh();
  expect(t.svc.checkedAt()).toBe('T');
  expect(checked).toHaveLength(lus + 1);
  expect(checked.at(-1)).toBe('T');
  // l'état n'a pas changé : rien de plus dans le journal des événements
  expect(t.states()).toHaveLength(etats);
  t.svc.dispose();
});

test.each([
  ['launchd:dev.swarph.monitor.peer-a', 'launchd:dev.swarph.monitor.peer-a'],
  [' swarph-monitor@peer-a.service ', 'swarph-monitor@peer-a.service'],
  ['a'.repeat(200), 'a'.repeat(200)],
  ['a'.repeat(201), null],
  ['', null],
  ['   ', null],
  ['service\n', null],
  ['ser\u007fvice', null],
  ['ser\u0085vice', null],
  [null, null],
  [undefined, null],
  [42, null],
  [{}, null],
])('parseMonitorStatus : superviseur %j', (supervisor, attendu) => {
  expect(parseMonitorStatus(JSON.stringify({ running: true, supervisor })).superviseur).toBe(
    attendu,
  );
});

test.each([
  [true, 'launchd:dev.swarph.monitor.peer-a', false],
  [true, null, true],
  [false, 'swarph-monitor@peer-a.service', true],
  [false, null, true],
])('D284 : running=%s, superviseur=%s, commandes=%s', async (running, supervisor, commandes) => {
  const fichier = join(mkdtempSync(join(tmpdir(), 'aid-superviseur-')), 'status.json');
  writeFileSync(fichier, JSON.stringify({ running, supervisor, supervision_hold: !running }));
  const t = setup({}, { FAKE_SWARPH_STATUS: fichier });
  try {
    t.writeInbox([record(901)]);
    const etat = await t.svc.connect();
    expect(etat).toMatchObject({ connected: running, superviseur: supervisor });
    expect(t.swarph()[0]).toMatch(/^monitor status /);
    expect(t.swarph().some((ligne) => ligne.startsWith('monitor start'))).toBe(commandes);
    expect(t.dms()).toHaveLength(running ? 1 : 0);
    const deconnecte = await t.svc.disconnect();
    expect(deconnecte).toMatchObject({ connected: false, superviseur: supervisor });
    expect(t.swarph().some((ligne) => ligne.startsWith('monitor stop'))).toBe(commandes);
    t.writeInbox([record(902)]);
    expect(t.svc.tick()).toBe(0);
    const appels = t.swarph().length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(t.swarph()).toHaveLength(appels);
  } finally {
    t.svc.dispose();
    t.db.close();
  }
});

test.each([null, 'swarph-monitor@peer-a.service'])(
  'D284 : disconnect relit le superviseur devenu %s',
  async (supervisor) => {
    const fichier = join(mkdtempSync(join(tmpdir(), 'aid-superviseur-')), 'status.json');
    const ecrire = (valeur: string | null) =>
      writeFileSync(fichier, JSON.stringify({ running: true, supervisor: valeur }));
    ecrire(supervisor === null ? 'swarph-monitor@peer-a.service' : null);
    const t = setup({}, { FAKE_SWARPH_STATUS: fichier });
    try {
      await t.svc.connect();
      ecrire(supervisor);
      await t.svc.disconnect();
      expect(t.swarph().some((ligne) => ligne.startsWith('monitor stop'))).toBe(
        supervisor === null,
      );
    } finally {
      t.svc.dispose();
      t.db.close();
    }
  },
);

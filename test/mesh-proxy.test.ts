import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import { openDb } from '../src/daemon/db.js';
import { EventStore } from '../src/daemon/events/store.js';
import type { MeshExec } from '../src/daemon/mesh/exec.js';
import { MeshService } from '../src/daemon/mesh/service.js';
import { startTestDaemon, waitFor } from './helpers/daemon.js';

const nettoyages: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const nettoyer of nettoyages.splice(0).reverse()) await nettoyer();
});

function dm(id: number) {
  return `${JSON.stringify({ id, from_node: 'pair-test', to_node: 'cell-test', kind: 'fyi', content: `DM ${id}` })}\n`;
}

function preparer() {
  const home = mkdtempSync(join(tmpdir(), 'aid-mesh-proxy-'));
  const inboxLog = join(home, 'proxy', 'inbox.log');
  mkdirSync(join(home, 'proxy'));
  const db = openDb(join(home, 'state.db'));
  const store = new EventStore(db);
  const exec = vi.fn<MeshExec>(async () => ({ ok: true, timedOut: false, stdout: '', stderr: '' }));
  const config = {
    ...DEFAULT_CONFIG.mesh,
    cell: 'cell-test',
    inboxLog,
    tailscale: { manage: true, bin: 'tailscale-test' },
  };
  let tailscale: 'running' | 'stopped' = 'running';
  const creer = () => {
    const service = new MeshService({
      config,
      home,
      db,
      store,
      exec,
      tailscale: async () => tailscale,
      log: () => undefined,
      pollMs: 20,
      refreshMs: 20,
    });
    nettoyages.push(() => service.dispose());
    return service;
  };
  nettoyages.push(() => rmSync(home, { recursive: true, force: true }));
  nettoyages.push(() => {
    db.close();
  });
  return {
    home,
    inboxLog,
    db,
    store,
    exec,
    creer,
    setTailscale: (etat: typeof tailscale) => (tailscale = etat),
  };
}

test('D281 : init, connect, refresh et disconnect sans aucun appel monitor ; suivi du bon fichier et curseur conservé', async () => {
  const t = preparer();
  writeFileSync(t.inboxLog, dm(1));
  // Un autre inbox.log local ne doit jamais être suivi.
  const local = join(t.home, 'swarph_state', 'cell-test', 'mesh-sidecar');
  mkdirSync(local, { recursive: true });
  writeFileSync(join(local, 'inbox.log'), dm(99));
  const service = t.creer();
  await service.init();
  expect(service.inboxLog).toBe(t.inboxLog);
  expect(service.current()).toMatchObject({ connected: true, monitor: 'proxy', pending: 0 });
  expect(service.inbox().map((message) => message.id)).toEqual([1]);
  expect(t.exec).not.toHaveBeenCalled();
  await service.connect();
  writeFileSync(t.inboxLog, dm(1) + dm(2));
  await waitFor(() => service.inbox().length === 2, 5000, 'DM proxy suivi');
  expect(service.tick()).toBe(0);
  await service.refresh();
  expect(t.exec).not.toHaveBeenCalled();
  expect(await service.disconnect()).toMatchObject({
    connected: false,
    monitor: 'proxy',
    pending: 0,
  });
  writeFileSync(t.inboxLog, dm(3));
  expect(service.tick()).toBe(0);
  await service.refresh();
  expect(service.current().connected).toBe(false);
  expect(t.exec).not.toHaveBeenCalled();
  service.dispose();
  const reprise = t.creer();
  await reprise.init();
  expect(reprise.inbox().map((message) => message.id)).toEqual([3, 2, 1]);
  expect(t.store.since(null).filter((evenement) => evenement.type === 'mesh.dm')).toHaveLength(3);
  expect(t.exec).not.toHaveBeenCalled();
});

test.each(['init', 'connect'] as const)(
  'D281 : %s reprend un fichier absent puis créé, et disparu puis recréé',
  async (action) => {
    const t = preparer();
    const service = t.creer();
    await service[action]();
    expect(service.current()).toMatchObject({ connected: false, monitor: 'absent', pending: 0 });
    writeFileSync(t.inboxLog, dm(1));
    await waitFor(
      () => service.current().connected && service.inbox().length === 1,
      5000,
      'fichier créé',
    );
    rmSync(t.inboxLog);
    await service.refresh();
    expect(service.current()).toMatchObject({ connected: false, monitor: 'absent', pending: 0 });
    writeFileSync(t.inboxLog, dm(1) + dm(2));
    await waitFor(
      () => service.current().connected && service.inbox().length === 2,
      5000,
      'fichier recréé',
    );
    await service.disconnect();
    expect(t.exec).not.toHaveBeenCalled();
  },
);

test('D281 : une source illisible est stopped ; Tailscale arrêté empêche connect', async () => {
  const t = preparer();
  mkdirSync(t.inboxLog); // ouvrir ce dossier ne permet pas de le lire comme un fichier, même sous root
  const service = t.creer();
  await service.init();
  expect(service.current()).toMatchObject({ connected: false, monitor: 'stopped', pending: 0 });
  await service.connect();
  expect(service.current().monitor).toBe('stopped');
  await service.disconnect();
  t.setTailscale('stopped');
  await service.connect();
  expect(service.current()).toMatchObject({ connected: false, tailscale: 'stopped' });
  expect(t.exec).toHaveBeenCalledExactlyOnceWith('tailscale-test', ['up'], expect.anything());
});

test('D281 : Boîte et instantané exposent le DM proxy, jamais les chemins de configuration', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aid-mesh-proxy-route-'));
  nettoyages.push(() => rmSync(home, { recursive: true, force: true }));
  const inboxLog = join(home, 'inbox.log');
  const proxySocket = join(home, 'proxy.sock');
  writeFileSync(inboxLog, dm(7));
  const t = await startTestDaemon(home, {
    config: {
      mesh: {
        ...DEFAULT_CONFIG.mesh,
        cell: 'cell-test',
        inboxLog,
        proxySocket,
        tailscale: {
          manage: false,
          bin: join(import.meta.dirname, 'fixtures', 'fake-tailscale.sh'),
        },
      },
    },
  });
  nettoyages.push(() => t.d.stop());
  await waitFor(() => t.d.mesh!.inbox().length === 1, 5000, 'Boîte proxy');
  for (const url of ['/api/mesh', '/api/state', '/api/swarph/cells', '/api/swarph/reglages']) {
    const reponse = await t.d.app.inject({ url, headers: t.headers });
    expect(reponse.statusCode).toBe(200);
    expect(reponse.body).not.toContain(inboxLog);
    expect(reponse.body).not.toContain(proxySocket);
    expect(reponse.body).not.toContain('inboxLog');
    if (url === '/api/mesh') {
      expect(reponse.json()).toMatchObject({
        state: { monitor: 'proxy', pending: 0 },
        inbox: [{ id: 7, content: 'DM 7' }],
      });
    }
    if (url === '/api/state') expect(reponse.json().mesh.inbox).toMatchObject([{ id: 7 }]);
  }
});

test('D281 : Tailscale reste monté puis descendu par A-I-D, sans appel monitor', async () => {
  const t = preparer();
  writeFileSync(t.inboxLog, '');
  t.setTailscale('stopped');
  t.exec.mockImplementation(async (_bin, args) => {
    if (args[0] === 'up') t.setTailscale('running');
    if (args[0] === 'down') t.setTailscale('stopped');
    return { ok: true, timedOut: false, stdout: '', stderr: '' };
  });
  const service = t.creer();
  expect(await service.connect()).toMatchObject({
    connected: true,
    monitor: 'proxy',
    tailscale: 'running',
  });
  expect(await service.disconnect()).toMatchObject({
    connected: false,
    monitor: 'proxy',
    tailscale: 'stopped',
  });
  expect(t.exec.mock.calls.map(([bin, args]) => [bin, args])).toEqual([
    ['tailscale-test', ['up']],
    ['tailscale-test', ['down']],
  ]);
});

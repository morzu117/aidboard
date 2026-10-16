import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { AidAlreadyRunning } from '../src/daemon/lock.js';
import { AidPortInUse, startDaemon } from '../src/daemon/main.js';

const home = () => mkdtempSync(join(tmpdir(), 'aid-srv-'));

test('le daemon écoute sur 127.0.0.1 seulement et publie son port', async () => {
  const h = home();
  const d = await startDaemon({ home: h, config: { port: 0 } });
  const addr = d.app.server.address() as { address: string; port: number };
  expect(addr.address).toBe('127.0.0.1');
  const info = JSON.parse(readFileSync(join(h, 'daemon.json'), 'utf8'));
  expect(info).toMatchObject({ pid: process.pid, port: addr.port });
  await d.stop();
  expect(existsSync(join(h, 'daemon.json'))).toBe(false);
});

test('un second daemon sur le même home est refusé', async () => {
  const h = home();
  const d = await startDaemon({ home: h, config: { port: 0 } });
  await expect(startDaemon({ home: h, config: { port: 0 } })).rejects.toThrow(AidAlreadyRunning);
  await d.stop();
});

test('port occupé : message clair, verrou libéré', async () => {
  const blocker = createServer();
  await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
  const port = (blocker.address() as { port: number }).port;
  const h = home();
  await expect(startDaemon({ home: h, config: { port } })).rejects.toThrow(AidPortInUse);
  const d = await startDaemon({ home: h, config: { port: 0 } });
  await d.stop();
  await new Promise((r) => blocker.close(r));
});

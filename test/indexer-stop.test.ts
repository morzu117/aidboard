import { type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { Indexer } from '../src/daemon/topics/index.js';
import type { EventStore } from '../src/daemon/events/store.js';
import type { AidPaths } from '../src/daemon/paths.js';
import type { StructuralService } from '../src/daemon/structural/service.js';

// Après stop(), un rattrapage encore en cours ne doit lancer aucun nouveau moteur (processus orphelin).
test('Indexer : init et sync après stop ne lancent rien', async () => {
  const logs = mkdtempSync(join(tmpdir(), 'aid-ix-'));
  mkdirSync(logs, { recursive: true });
  const init = vi.fn(() => ({}) as ChildProcess);
  const sync = vi.fn(() => ({}) as ChildProcess);
  const append = vi.fn();
  const indexer = new Indexer({
    store: { append } as unknown as EventStore,
    paths: { logs } as AidPaths,
    engine: { init, sync } as unknown as StructuralService,
  });
  indexer.stop();
  const topic = { id: 't1', workspaceId: 'w1', worktree: '/nowhere' };
  await expect(indexer.init(topic)).resolves.toBe('failed');
  await expect(indexer.sync(topic)).resolves.toBe('failed');
  expect(init).not.toHaveBeenCalled();
  expect(sync).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
});

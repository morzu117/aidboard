import { expect, test } from 'vitest';
import { WorkspaceQueue } from '../src/daemon/actions/queue.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function job(log: string[], name: string, ms: number) {
  return async () => {
    log.push(`debut ${name}`);
    await sleep(ms);
    log.push(`fin ${name}`);
    return name;
  };
}

test('deux jobs du même workspace s’exécutent l’un après l’autre', async () => {
  const q = new WorkspaceQueue();
  const log: string[] = [];
  await Promise.all([q.run('ws', job(log, 'a', 60)), q.run('ws', job(log, 'b', 10))]);
  expect(log).toEqual(['debut a', 'fin a', 'debut b', 'fin b']);
});

test('deux workspaces avancent en parallèle', async () => {
  const q = new WorkspaceQueue();
  const log: string[] = [];
  await Promise.all([q.run('w1', job(log, 'a', 60)), q.run('w2', job(log, 'b', 60))]);
  expect(log.slice(0, 2)).toEqual(['debut a', 'debut b']);
});

test('un job qui lève libère la file et rejette son propre appelant', async () => {
  const q = new WorkspaceQueue();
  const bad = q.run('ws', async () => {
    throw new Error('boum');
  });
  const good = q.run('ws', async () => 'ok');
  await expect(bad).rejects.toThrow('boum');
  await expect(good).resolves.toBe('ok');
});

test('la file ne retient rien une fois vide', async () => {
  const q = new WorkspaceQueue();
  await q.run('ws', async () => 1);
  await sleep(5);
  expect((q as unknown as { tails: Map<string, unknown> }).tails.size).toBe(0);
});

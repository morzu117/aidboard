import { expect, test, vi } from 'vitest';
import { cycleGuard } from '../src/cli/cycleGuard.js';

test('deux déclenchements de suite : un seul cycle', async () => {
  const run = vi.fn(() => new Promise<void>(() => {}));
  const cycle = cycleGuard(run, () => {});
  cycle();
  cycle();
  expect(run).toHaveBeenCalledTimes(1);
});

test('un cycle terminé garde la garde levée (le process va s’arrêter)', async () => {
  const run = vi.fn(async () => {});
  const cycle = cycleGuard(run, () => {});
  cycle();
  await Promise.resolve();
  cycle();
  expect(run).toHaveBeenCalledTimes(1);
});

test('un cycle qui lève est journalisé et la garde retombe', async () => {
  const run = vi.fn().mockRejectedValueOnce(new Error('git cassé')).mockResolvedValue(undefined);
  const log = vi.fn();
  const cycle = cycleGuard(run, log);
  cycle();
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith('cycle échoué : git cassé'));
  cycle();
  expect(run).toHaveBeenCalledTimes(2);
});

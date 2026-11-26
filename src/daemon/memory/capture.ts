import type { AidEvent } from '../../shared/events.js';
import { LESSON_NS } from '../../shared/memory.js';
import type { MemoryConfig } from '../config.js';
import type { MemoryJobs } from './jobs.js';

interface CaptureDeps {
  config: MemoryConfig['capture'];
  jobs: MemoryJobs;
  log: (line: string) => void;
}

export function onMemoryEvent(event: AidEvent, { config, jobs, log }: CaptureDeps): void {
  try {
    if (!config.enabled || event.type !== 'memory.page') return;
    const { op, author, slug } = event.data;
    if (op !== 'put' && op !== 'append') return;
    if (typeof author !== 'string' || !author.startsWith('run:') || typeof slug !== 'string')
      return;

    const parts = slug.split('/');
    const [namespace, phase, task] = parts;
    if (
      parts.length !== 3 ||
      !namespace ||
      namespace === LESSON_NS ||
      !task ||
      (phase !== 'dev-handoff' && phase !== 'review')
    )
      return;

    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    if (
      jobs.countCreatedSince('faits', midnight.toISOString()) >= config.maxPerDay &&
      !jobs.hasPending('faits', slug)
    )
      return;

    const runAfter = new Date(now.getTime() + config.delayMinutes * 60_000);
    jobs.enqueueAfter('faits', slug, runAfter.toISOString());
  } catch (err) {
    log(`mémoire : déclenchement de la capture : ${(err as Error).message}`);
  }
}

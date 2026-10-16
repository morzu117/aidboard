import { type ChildProcess, spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { join } from 'node:path';
import type { EventStore } from '../events/store.js';
import type { AidPaths } from '../paths.js';

export interface IndexerDeps {
  store: EventStore;
  paths: AidPaths;
  codegraphBin: string;
  timeoutMs?: number;
}

// L'indexation tourne à part : le sujet est utilisable tout de suite, son état d'index change ensuite.
export class Indexer {
  private running = new Set<ChildProcess>();

  constructor(private readonly deps: IndexerDeps) {}

  start(topic: { id: string; workspaceId: string; worktree: string }): void {
    const { store, paths, codegraphBin } = this.deps;
    const log = openSync(join(paths.logs, `${topic.id}-index.log`), 'a', 0o600);
    const report = (indexState: 'ready' | 'failed') =>
      store.append({
        source: 'daemon',
        type: 'topic.state',
        workspaceId: topic.workspaceId,
        topicId: topic.id,
        data: { indexState },
      });
    let child: ChildProcess;
    try {
      child = spawn(codegraphBin, ['init', '-y', topic.worktree], {
        cwd: topic.worktree,
        stdio: ['ignore', log, log],
      });
    } catch {
      report('failed');
      return;
    }
    this.running.add(child);
    let done = false;
    const finish = (state: 'ready' | 'failed') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.running.delete(child);
      try {
        report(state);
      } catch {
        // base déjà fermée : le daemon s'arrête
      }
    };
    const timer = setTimeout(
      () => {
        child.kill('SIGTERM');
        finish('failed');
      },
      this.deps.timeoutMs ?? 15 * 60_000,
    );
    child.on('error', () => finish('failed'));
    child.on('close', (code) => finish(code === 0 ? 'ready' : 'failed'));
  }

  stop(): void {
    for (const child of this.running) child.kill('SIGTERM');
    this.running.clear();
  }
}

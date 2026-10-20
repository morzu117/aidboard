import { type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import type { EventStore } from '../events/store.js';
import type { AidPaths } from '../paths.js';
import type { StructuralService } from '../structural/service.js';

export interface IndexerDeps {
  store: EventStore;
  paths: AidPaths;
  engine: StructuralService;
  timeoutMs?: number;
}

export interface IndexedTopic {
  id: string;
  workspaceId: string;
  worktree: string;
}

type Outcome = 'ready' | 'failed';

// L'indexation tourne à part : le sujet est utilisable tout de suite, son état d'index change ensuite.
export class Indexer {
  private running = new Set<ChildProcess>();

  constructor(private readonly deps: IndexerDeps) {}

  start(topic: IndexedTopic): void {
    void this.init(topic);
  }

  /** `init` du moteur, résolu à la fin : `ready` ou `failed` — la même promesse que `start` ignore */
  init(topic: IndexedTopic): Promise<Outcome> {
    return this.launch(topic, (worktree, log) => this.deps.engine.init(worktree, log));
  }

  /**
   * `sync` du moteur (08.8) : rattrape ce qui a changé dans le worktree depuis la dernière
   * indexation. Même journal, même délai, même événement final que `init` — un `sync` qui échoue
   * laisse le sujet en `failed`, comme un `init` qui échoue : l'admin relance par `reindex`.
   */
  sync(topic: IndexedTopic): Promise<Outcome> {
    return this.launch(topic, (worktree, log) => this.deps.engine.sync(worktree, log));
  }

  private launch(
    topic: IndexedTopic,
    spawnChild: (worktree: string, log: number) => ChildProcess,
  ): Promise<Outcome> {
    const { store, paths } = this.deps;
    const log = openSync(join(paths.logs, `${topic.id}-index.log`), 'a', 0o600);
    const report = (indexState: Outcome) =>
      store.append({
        source: 'daemon',
        type: 'topic.state',
        workspaceId: topic.workspaceId,
        topicId: topic.id,
        data: { indexState },
      });
    let child: ChildProcess;
    try {
      child = spawnChild(topic.worktree, log);
    } catch {
      closeSync(log);
      report('failed');
      return Promise.resolve('failed');
    }
    this.running.add(child);
    return new Promise((resolve) => {
      let done = false;
      const finish = (state: Outcome) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.running.delete(child);
        // l'enfant tient son propre descripteur : le nôtre ne sert plus une fois lancé
        closeSync(log);
        try {
          report(state);
        } catch {
          // base déjà fermée : le daemon s'arrête
        }
        resolve(state);
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
    });
  }

  stop(): void {
    for (const child of this.running) child.kill('SIGTERM');
    this.running.clear();
  }
}

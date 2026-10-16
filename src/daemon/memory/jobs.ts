import { monotonicFactory } from 'ulid';
import type { Db } from '../db.js';

const ulid = monotonicFactory();

export type JobKind = 'embed' | 'maintain';
export interface MemoryJob {
  id: string;
  kind: JobKind;
  slug: string | null;
  attempts: number;
}

// File persistante des tâches hors chemin de requête (DM4) : embed, entretien.
export class MemoryJobs {
  constructor(private readonly db: Db) {}

  // Un job en attente par (kind, slug) suffit : la page sera relue au moment de l'exécution.
  enqueue(kind: JobKind, slug: string | null): string | null {
    const pending = this.db
      .prepare(
        "SELECT id FROM memory_jobs WHERE kind = ? AND slug IS ? AND state = 'pending' LIMIT 1",
      )
      .get(kind, slug);
    if (pending) return null;
    const id = `job_${ulid()}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO memory_jobs (id, kind, slug, state, attempts, created_at, updated_at) VALUES (?, ?, ?, 'pending', 0, ?, ?)",
      )
      .run(id, kind, slug, now, now);
    return id;
  }

  claim(now = new Date().toISOString()): MemoryJob | undefined {
    return this.db.transaction((): MemoryJob | undefined => {
      const job = this.db
        .prepare(
          "SELECT id, kind, slug, attempts FROM memory_jobs WHERE state = 'pending' AND (run_after IS NULL OR run_after <= ?) ORDER BY created_at LIMIT 1",
        )
        .get(now) as MemoryJob | undefined;
      if (!job) return undefined;
      this.db
        .prepare(
          "UPDATE memory_jobs SET state = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?",
        )
        .run(now, job.id);
      return { ...job, attempts: job.attempts + 1 };
    })();
  }

  done(id: string): void {
    this.db
      .prepare("UPDATE memory_jobs SET state = 'done', error = NULL, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  // retryAfterMs null : échec définitif.
  fail(id: string, error: string, retryAfterMs: number | null): void {
    const now = Date.now();
    this.db
      .prepare(
        'UPDATE memory_jobs SET state = ?, error = ?, run_after = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        retryAfterMs === null ? 'failed' : 'pending',
        error.slice(0, 1000),
        retryAfterMs === null ? null : new Date(now + retryAfterMs).toISOString(),
        new Date(now).toISOString(),
        id,
      );
  }

  // Au démarrage : ce qui tournait quand le daemon s'est arrêté repart.
  resetRunning(): number {
    return this.db
      .prepare("UPDATE memory_jobs SET state = 'pending', updated_at = ? WHERE state = 'running'")
      .run(new Date().toISOString()).changes;
  }

  retryFailed(): number {
    return this.db
      .prepare(
        "UPDATE memory_jobs SET state = 'pending', attempts = 0, run_after = NULL, updated_at = ? WHERE state = 'failed'",
      )
      .run(new Date().toISOString()).changes;
  }

  get(id: string): { state: string; attempts: number; error: string | null } | undefined {
    return this.db
      .prepare('SELECT state, attempts, error FROM memory_jobs WHERE id = ?')
      .get(id) as { state: string; attempts: number; error: string | null } | undefined;
  }
}

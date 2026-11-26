import { monotonicFactory } from 'ulid';
import type { Db } from '../db.js';

const ulid = monotonicFactory();

// Pour un job `retro`, le champ slug porte l'id du sujet.
export type JobKind = 'embed' | 'maintain' | 'retro' | 'faits';
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
  enqueue(kind: JobKind, slug: string | null, reprendreÉchec = false): string | null {
    const pending = this.db
      .prepare(
        "SELECT id FROM memory_jobs WHERE kind = ? AND slug IS ? AND state = 'pending' LIMIT 1",
      )
      .get(kind, slug);
    if (pending) return null;
    if (kind === 'embed') {
      const failed = this.db
        .prepare(
          "SELECT id FROM memory_jobs WHERE kind = 'embed' AND slug IS ? AND state = 'failed' LIMIT 1",
        )
        .get(slug) as { id: string } | undefined;
      if (failed) {
        // Une réécriture ou une reprise après indisponibilité réarme un embedding en échec.
        if (!reprendreÉchec) return null;
        this.db
          .prepare(
            "UPDATE memory_jobs SET state = 'pending', attempts = 0, error = NULL, run_after = NULL, updated_at = ? WHERE id = ?",
          )
          .run(new Date().toISOString(), failed.id);
        return failed.id;
      }
    }
    const id = `job_${ulid()}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO memory_jobs (id, kind, slug, state, attempts, created_at, updated_at) VALUES (?, ?, ?, 'pending', 0, ?, ?)",
      )
      .run(id, kind, slug, now, now);
    return id;
  }

  hasPending(kind: JobKind, slug: string | null): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM memory_jobs WHERE kind = ? AND slug IS ? AND state = 'pending' LIMIT 1",
      )
      .get(kind, slug);
  }

  enqueueAfter(kind: JobKind, slug: string | null, runAfter: string): string | null {
    return this.db
      .transaction(() => {
        const now = new Date().toISOString();
        const postponed = this.db
          .prepare(
            "UPDATE memory_jobs SET run_after = ?, updated_at = ? WHERE kind = ? AND slug IS ? AND state = 'pending'",
          )
          .run(runAfter, now, kind, slug);
        if (postponed.changes) return null;

        const id = `job_${ulid()}`;
        this.db
          .prepare(
            "INSERT INTO memory_jobs (id, kind, slug, state, attempts, created_at, updated_at, run_after) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)",
          )
          .run(id, kind, slug, now, now, runAfter);
        return id;
      })
      .immediate();
  }

  enqueueMissingEmbeddings(reprendreÉchecs: boolean): number {
    // La table vec0 n'existe qu'après le premier embedding valide.
    const tableVecteurs = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_vectors'")
      .get();
    const sansVecteur = tableVecteurs
      ? 'AND NOT EXISTS (SELECT 1 FROM memory_vectors v WHERE v.slug = p.slug)'
      : '';
    const pages = this.db
      .prepare(
        `SELECT p.slug FROM memory_pages p
         WHERE p.slug NOT IN (
           SELECT slug FROM memory_jobs WHERE kind = 'embed' AND slug IS NOT NULL
             AND (state IN ('pending', 'running') OR (state = 'failed' AND NOT ?))
         ) ${sansVecteur}`,
      )
      .all(Number(reprendreÉchecs)) as { slug: string }[];
    let enfilés = 0;
    for (const { slug } of pages) {
      if (this.enqueue('embed', slug, reprendreÉchecs)) enfilés++;
    }
    return enfilés;
  }

  countCreatedSince(kind: JobKind | readonly JobKind[], since: string): number {
    const kinds = typeof kind === 'string' ? [kind] : kind;
    const placeholders = kinds.map(() => '?').join(', ');
    const row = this.db
      .prepare(
        `SELECT count(*) AS n FROM memory_jobs WHERE kind IN (${placeholders}) AND created_at >= ?`,
      )
      .get(...kinds, since) as { n: number };
    return row.n;
  }

  claim(now = new Date().toISOString(), embedReady = true): MemoryJob | undefined {
    return this.db.transaction((): MemoryJob | undefined => {
      const job = this.db
        .prepare(
          "SELECT id, kind, slug, attempts FROM memory_jobs WHERE state = 'pending' AND (run_after IS NULL OR run_after <= ?) AND (kind != 'embed' OR ?) ORDER BY created_at LIMIT 1",
        )
        .get(now, Number(embedReady)) as MemoryJob | undefined;
      if (!job) return undefined;
      this.db
        .prepare(
          "UPDATE memory_jobs SET state = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?",
        )
        .run(now, job.id);
      return { ...job, attempts: job.attempts + 1 };
    })();
  }

  // Une panne de disponibilité ne consomme pas la tentative prise par claim.
  deferEmbedding(id: string): void {
    this.db
      .prepare(
        "UPDATE memory_jobs SET state = 'pending', attempts = attempts - 1, updated_at = ? WHERE id = ? AND kind = 'embed' AND state = 'running'",
      )
      .run(new Date().toISOString(), id);
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

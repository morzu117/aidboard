import type { Embedder, VectorIndex } from './embed.js';
import type { MemoryJob, MemoryJobs } from './jobs.js';
import type { MemoryStore } from './store.js';

export interface WorkerDeps {
  jobs: MemoryJobs;
  store: MemoryStore;
  vectors: VectorIndex;
  embedder: Embedder;
  log: (line: string) => void;
  backoffMs?: number[]; // une entrée par nouvelle tentative ; au-delà : échec
  pollMs?: number;
  // 06.10 : traitement des jobs `maintain` ; absent, ils échouent proprement
  maintain?: (job: MemoryJob) => Promise<void>;
}

const DEFAULT_BACKOFF = [10_000, 60_000, 300_000];
const EMBED_MAX_CHARS = 8000;

// Un job à la fois, hors transaction, jamais sur le chemin d'une requête (DM4).
export class MemoryWorker {
  private running = false;
  private wake: (() => void) | null = null;
  private loopDone: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: WorkerDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopDone = this.loop();
  }

  notify(): void {
    this.wake?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.notify();
    await this.loopDone;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wake = () => {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.wake = null;
        resolve();
      };
      this.timer = setTimeout(() => this.wake?.(), ms);
      this.timer.unref();
    });
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const job = this.deps.jobs.claim();
      if (!job) {
        await this.sleep(this.deps.pollMs ?? 5000);
        continue;
      }
      try {
        await this.run(job);
        this.deps.jobs.done(job.id);
      } catch (err) {
        const backoff = this.deps.backoffMs ?? DEFAULT_BACKOFF;
        const retry = job.attempts <= backoff.length ? (backoff[job.attempts - 1] ?? null) : null;
        const message = (err as Error).message;
        this.deps.jobs.fail(job.id, message, retry);
        this.deps.log(
          `mémoire : job ${job.kind} ${job.slug ?? ''} tentative ${job.attempts} : ${message}` +
            (retry === null ? ' (abandon)' : ''),
        );
      }
    }
  }

  private async run(job: MemoryJob): Promise<void> {
    if (job.kind === 'maintain') {
      if (!this.deps.maintain) throw new Error('entretien non disponible');
      return this.deps.maintain(job);
    }
    const page = job.slug ? this.deps.store.get(job.slug) : undefined;
    if (!page) {
      if (job.slug) this.deps.vectors.remove(job.slug);
      return;
    }
    const text = `${page.title}\n\n${page.body}`.slice(0, EMBED_MAX_CHARS);
    const [vector] = await this.deps.embedder.embed([text]);
    if (!vector) throw new Error('embedding vide');
    this.deps.vectors.ensureTable(this.deps.embedder.model, vector.length);
    this.deps.vectors.upsert(page.slug, vector);
  }
}

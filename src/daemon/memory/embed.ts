import * as sqliteVec from 'sqlite-vec';
import type { Db } from '../db.js';

export interface Embedder {
  readonly model: string;
  embed(texts: string[]): Promise<Float32Array[]>;
  ready(): Promise<boolean>;
}

// Client Ollama (/api/embed). L'indisponibilité est mémorisée 60 s : pas un timeout à chaque recherche.
export function ollamaEmbedder(
  url: string,
  model: string,
  log: (line: string) => void = () => undefined,
  unavailableForMs = 60_000,
): Embedder {
  const base = url.replace(/\/$/, '');
  let downUntil = 0;
  const markDown = () => {
    downUntil = Date.now() + unavailableForMs;
  };
  return {
    model,
    async ready() {
      if (Date.now() < downUntil) return false;
      try {
        const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) throw new Error(`réponse ${res.status}`);
        const tags = (await res.json()) as { models?: Array<{ name?: string }> };
        const names = (tags.models ?? []).map((m) => m.name ?? '');
        const has = names.some(
          (n) => n === model || n === `${model}:latest` || n.startsWith(`${model}:`),
        );
        if (!has) {
          log(
            `ollama : modèle d'embeddings ${model} absent (ollama pull ${model}) : recherche FTS5 seule`,
          );
          markDown();
        }
        return has;
      } catch {
        markDown();
        return false;
      }
    },
    async embed(texts) {
      const res = await fetch(`${base}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: texts }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`ollama /api/embed : réponse ${res.status}`);
      const body = (await res.json()) as { embeddings?: number[][] };
      if (!body.embeddings || body.embeddings.length !== texts.length) {
        throw new Error('ollama /api/embed : réponse sans embeddings');
      }
      return body.embeddings.map((e) => Float32Array.from(e));
    },
  };
}

export interface VectorMeta {
  model: string;
  dimension: number;
}

const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

// Index vectoriel sqlite-vec (vec0, cosinus). Le modèle et la dimension sont dans memory_meta :
// en changer recrée la table, pour ne jamais mélanger deux espaces.
export class VectorIndex {
  private constructor(private readonly db: Db) {}

  static load(db: Db, log: (line: string) => void): VectorIndex | null {
    try {
      sqliteVec.load(db);
    } catch (err) {
      log(`sqlite-vec indisponible : recherche FTS5 seule (${(err as Error).message})`);
      return null;
    }
    const index = new VectorIndex(db);
    const meta = index.meta();
    if (meta) index.createTable(meta.dimension);
    return index;
  }

  meta(): VectorMeta | null {
    const rows = this.db
      .prepare(
        "SELECT key, value FROM memory_meta WHERE key IN ('vectors.model', 'vectors.dimension')",
      )
      .all() as Array<{ key: string; value: string }>;
    const model = rows.find((r) => r.key === 'vectors.model')?.value;
    const dimension = Number(rows.find((r) => r.key === 'vectors.dimension')?.value);
    return model && dimension > 0 ? { model, dimension } : null;
  }

  private createTable(dimension: number): void {
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(slug TEXT PRIMARY KEY, embedding float[${dimension}] distance_metric=cosine)`,
    );
  }

  private hasTable(): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_vectors'")
      .get();
  }

  // Appelé au premier embedding : fixe (ou refixe) l'espace vectoriel.
  ensureTable(model: string, dimension: number): void {
    const meta = this.meta();
    if (meta && meta.model === model && meta.dimension === dimension && this.hasTable()) return;
    this.db.transaction(() => {
      this.db.exec('DROP TABLE IF EXISTS memory_vectors');
      this.createTable(dimension);
      const set = this.db.prepare('INSERT OR REPLACE INTO memory_meta (key, value) VALUES (?, ?)');
      set.run('vectors.model', model);
      set.run('vectors.dimension', String(dimension));
    })();
  }

  upsert(slug: string, vector: Float32Array): void {
    const meta = this.meta();
    if (!meta || !this.hasTable()) throw new Error('index vectoriel non initialisé');
    if (vector.length !== meta.dimension) {
      throw new Error(
        `dimension ${vector.length} ≠ ${meta.dimension} (${meta.model}) : aid mem reindex`,
      );
    }
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM memory_vectors WHERE slug = ?').run(slug);
      this.db
        .prepare('INSERT INTO memory_vectors (slug, embedding) VALUES (?, ?)')
        .run(slug, toBlob(vector));
    })();
  }

  remove(slug: string): void {
    if (this.hasTable()) this.db.prepare('DELETE FROM memory_vectors WHERE slug = ?').run(slug);
  }

  nearest(vector: Float32Array, k: number): Array<{ slug: string; distance: number }> {
    const meta = this.meta();
    if (!meta || !this.hasTable() || vector.length !== meta.dimension) return [];
    return this.db
      .prepare(
        'SELECT slug, distance FROM memory_vectors WHERE embedding MATCH ? AND k = ? ORDER BY distance',
      )
      .all(toBlob(vector), k) as Array<{ slug: string; distance: number }>;
  }

  count(): number {
    if (!this.hasTable()) return 0;
    return (this.db.prepare('SELECT count(*) AS c FROM memory_vectors').get() as { c: number }).c;
  }

  clear(): void {
    if (this.hasTable()) this.db.exec('DELETE FROM memory_vectors');
  }
}

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  LESSON_NS,
  type MemoryPage,
  type PutMode,
  type SearchHit,
  type SearchMode,
} from '../../shared/memory.js';

export interface MemoryHealth {
  pages: Record<string, number>;
  fts: true;
  vectors: 'ollama' | 'off';
  pendingJobs: number;
  failedJobs: number;
  mirrorDirty: boolean;
}
import type { WorkspaceQueue } from '../actions/queue.js';
import type { EventStore } from '../events/store.js';
import type { Embedder, VectorIndex } from './embed.js';
import { type MemoryMirror, walkMarkdown } from './mirror.js';
import { isValidMemSlug } from './slug.js';
import { MemoryStore, renderMarkdown } from './store.js';

const QUEUE_KEY = 'memory';

export interface WriteContext {
  author: string; // 'admin' | 'run:<runId>' | 'import' | 'reindex' | 'maintenance'
  workspaceId?: string;
  topicId?: string;
  runId?: string;
  agentId?: string;
}

export interface MemoryServiceDeps {
  store: MemoryStore;
  mirror: MemoryMirror;
  events: EventStore;
  queue: WorkspaceQueue;
  log?: (line: string) => void;
  onWrite?: (slug: string) => void; // enfile un job d'embedding
  onRemove?: (slug: string) => void;
  // Recherche hybride (06.7) : présent quand sqlite-vec est chargé ; `enabled` dit si Ollama répond.
  hybrid?: { index: VectorIndex; embedder: Embedder; enabled: () => boolean };
}

const RRF_K = 60;

// L'unique point d'entrée des routes, du CLI et du worker : base, puis fichier, puis commit différé.
export class MemoryService {
  constructor(private readonly deps: MemoryServiceDeps) {}

  get store(): MemoryStore {
    return this.deps.store;
  }

  get(slug: string): MemoryPage | undefined {
    return this.deps.store.get(slug);
  }

  list(prefix: string): string[] {
    return this.deps.store.list(prefix);
  }

  // FTS d'abord ; si les vecteurs répondent, fusion RRF des deux classements (DM5).
  async search(
    q: string,
    scope: string | 'all',
    limit: number,
  ): Promise<{ mode: SearchMode; hits: SearchHit[] }> {
    const { store, hybrid } = this.deps;
    const fts = store.searchFts(q, scope, hybrid?.enabled() ? limit * 2 : limit);
    if (!hybrid?.enabled()) return { mode: 'fts', hits: fts };
    let near: Array<{ slug: string; distance: number }>;
    try {
      const [qv] = await hybrid.embedder.embed([q]);
      near = qv ? hybrid.index.nearest(qv, limit * 2) : [];
    } catch (err) {
      this.deps.log?.(`recherche : embedding de la requête impossible : ${(err as Error).message}`);
      return { mode: 'fts', hits: fts.slice(0, limit) };
    }
    const scores = new Map<string, number>();
    const add = (slug: string, rank: number) =>
      scores.set(slug, (scores.get(slug) ?? 0) + 1 / (RRF_K + rank));
    fts.forEach((h, i) => add(h.slug, i + 1));
    near
      .filter(
        (n) => scope === 'all' || [scope, LESSON_NS].includes(n.slug.slice(0, n.slug.indexOf('/'))),
      )
      .forEach((n, i) => add(n.slug, i + 1));
    const byFts = new Map(fts.map((h) => [h.slug, h]));
    const hits: SearchHit[] = [];
    for (const [slug, score] of [...scores.entries()].sort((a, b) => b[1] - a[1])) {
      const known = byFts.get(slug);
      const page = known ? undefined : store.get(slug);
      if (!known && !page) continue;
      hits.push({
        slug,
        title: known?.title ?? page!.title,
        snippet: known?.snippet ?? page!.body.replace(/\s+/g, ' ').slice(0, 160),
        score: Math.round(score * 1e6) / 1e6,
      });
      if (hits.length >= limit) break;
    }
    return { mode: 'hybrid', hits };
  }

  async health(): Promise<MemoryHealth> {
    const jobs = this.deps.store.jobCounts();
    return {
      pages: this.deps.store.countByNamespace(),
      fts: true,
      vectors: this.deps.hybrid?.enabled() ? 'ollama' : 'off',
      pendingJobs: jobs.pending,
      failedJobs: jobs.failed,
      mirrorDirty: await this.deps.mirror.dirty(),
    };
  }

  put(slug: string, text: string, mode: PutMode, ctx: WriteContext, title?: string) {
    return this.deps.queue.run(QUEUE_KEY, async (): Promise<MemoryPage> => {
      const { store, mirror, events } = this.deps;
      const before = store.get(slug);
      const page = store.put(slug, text, mode, ctx.author, title);
      await mirror.write(slug, renderMarkdown(page));
      mirror.scheduleCommit(`mem: ${slug} r${page.revision}`);
      events.append({
        source: 'daemon',
        type: 'memory.page',
        ...(ctx.workspaceId && { workspaceId: ctx.workspaceId }),
        ...(ctx.topicId && { topicId: ctx.topicId }),
        ...(ctx.runId && { runId: ctx.runId }),
        ...(ctx.agentId && { agentId: ctx.agentId }),
        data: {
          slug,
          revision: page.revision,
          author: ctx.author,
          op: before && mode.kind === 'append' ? 'append' : 'put',
        },
      });
      this.deps.onWrite?.(slug);
      return page;
    });
  }

  remove(slug: string, ctx: WriteContext): Promise<boolean> {
    return this.deps.queue.run(QUEUE_KEY, async () => {
      const { store, mirror, events } = this.deps;
      const page = store.get(slug);
      if (!page) return false;
      store.remove(slug);
      this.deps.onRemove?.(slug);
      await mirror.remove(slug);
      mirror.scheduleCommit(`mem: ${slug} supprimée`);
      events.append({
        source: 'daemon',
        type: 'memory.page',
        ...(ctx.workspaceId && { workspaceId: ctx.workspaceId }),
        ...(ctx.topicId && { topicId: ctx.topicId }),
        ...(ctx.runId && { runId: ctx.runId }),
        data: { slug, revision: page.revision, author: ctx.author, op: 'rm' },
      });
      return true;
    });
  }

  // Le miroir fait foi : on vide l'index et on relit chaque fichier.
  reindex(): Promise<{ pages: number }> {
    return this.deps.queue.run(QUEUE_KEY, async () => {
      const { store, mirror } = this.deps;
      store.clear();
      this.deps.hybrid?.index.clear();
      let pages = 0;
      for await (const f of mirror.readAll()) {
        try {
          store.put(f.slug, f.text, { kind: 'create' }, 'reindex');
          pages++;
          this.deps.onWrite?.(f.slug);
        } catch (err) {
          this.deps.log?.(`reindex : ${f.slug} ignorée : ${(err as Error).message}`);
        }
      }
      return { pages };
    });
  }

  // Un `.md` par page, chemin = slug.
  async export(scope: string | 'all', dir: string): Promise<number> {
    let n = 0;
    for (const page of this.deps.store.all()) {
      if (scope !== 'all' && page.namespace !== scope && page.namespace !== LESSON_NS) continue;
      const path = join(dir, `${page.slug}.md`);
      // même contrat que le miroir : une mémoire peut contenir des éléments sensibles
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, renderMarkdown(page), { mode: 0o600 });
      n++;
    }
    return n;
  }

  // Slug = chemin relatif sans `.md`, préfixé du namespace s'il est donné ; l'existant n'est jamais écrasé.
  async import(
    dir: string,
    ns?: string,
  ): Promise<{ imported: number; skipped: string[]; failed: string[] }> {
    const out = { imported: 0, skipped: [] as string[], failed: [] as string[] };
    for (const f of walkMarkdown(dir)) {
      const slug = ns ? `${ns}/${f.slug}` : f.slug;
      if (!isValidMemSlug(slug)) {
        out.failed.push(slug);
        continue;
      }
      if (this.deps.store.get(slug)) {
        out.skipped.push(slug);
        continue;
      }
      try {
        await this.put(
          slug,
          readFileSync(f.path, 'utf8'),
          { kind: 'create' },
          { author: 'import' },
        );
        out.imported++;
      } catch (err) {
        this.deps.log?.(`import : ${slug} refusée : ${(err as Error).message}`);
        out.failed.push(slug);
      }
    }
    return out;
  }
}

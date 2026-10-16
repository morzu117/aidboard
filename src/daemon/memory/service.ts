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
  onWrite?: (slug: string) => void; // 06.7 : enfile un job d'embedding
}

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

  async search(
    q: string,
    scope: string | 'all',
    limit: number,
  ): Promise<{ mode: SearchMode; hits: SearchHit[] }> {
    return { mode: 'fts', hits: this.deps.store.searchFts(q, scope, limit) };
  }

  async health(): Promise<MemoryHealth> {
    const jobs = this.deps.store.jobCounts();
    return {
      pages: this.deps.store.countByNamespace(),
      fts: true,
      vectors: 'off',
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
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, renderMarkdown(page));
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

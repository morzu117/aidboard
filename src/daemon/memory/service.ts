import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  LESSON_NS,
  type MemoryDecision,
  type MemoryLinks,
  type MemoryPage,
  type PutMode,
  RevisionConflict,
  type SearchHit,
  type SearchResult,
} from '../../shared/memory.js';

export interface MemoryHealth {
  pages: Record<string, number>;
  closed: number;
  links: { total: number; pendants: number };
  fts: true;
  vectors: 'ollama' | 'off';
  pendingJobs: number;
  failedJobs: number;
  mirrorDirty: boolean;
  mirrorSync: MirrorSyncHealth;
}
import type { WorkspaceQueue } from '../actions/queue.js';
import { AidHttpError } from '../errors.js';
import type { EventStore } from '../events/store.js';
import type { Embedder, VectorIndex } from './embed.js';
import { type MemoryMirror, type MirrorSyncHealth, walkMarkdown } from './mirror.js';
import {
  InvalidMemSlug,
  isValidMemSlug,
  isValidNamespace,
  NAMESPACE_RE,
  namespaceOf,
} from './slug.js';
import { MemoryStore, renderMarkdown } from './store.js';

const QUEUE_KEY = 'memory';

export interface WriteContext {
  author: string; // 'admin' | 'run:<runId>' | 'import' | 'reindex' | 'maintenance'
  workspaceId?: string;
  topicId?: string;
  runId?: string;
  agentId?: string;
}

export interface MemoryWriteContext extends WriteContext {
  scope?: { namespace: string; role: string | null };
}

export function assertMemoryWriteNamespace(ctx: MemoryWriteContext, namespace: string): void {
  const scope = ctx.scope;
  if (
    !scope ||
    namespace === scope.namespace ||
    (namespace === LESSON_NS && scope.role === 'retro')
  ) {
    return;
  }
  throw new AidHttpError(403, 'forbidden', { namespace, allowed: scope.namespace });
}

interface DecisionInput {
  namespace: string;
  slug: string;
  title: string;
  raison: string;
  texte?: string;
  remplace: string[];
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
const NEIGHBOR_TYPES = ['contredit', 'precise', 'issu_de', 'cite'] as const;

function pageHit(page: MemoryPage): SearchHit {
  return {
    slug: page.slug,
    title: page.title,
    snippet: page.body.replace(/\s+/g, ' ').slice(0, 160),
    score: 0,
  };
}

function inScope(slug: string, scope: string): boolean {
  return scope === 'all' || [scope, LESSON_NS].includes(slug.slice(0, slug.indexOf('/')));
}

interface RankedHit {
  rank: number;
  via?: SearchHit['via'];
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

  links(slug: string): MemoryLinks | undefined {
    const page = this.get(slug);
    const { sortants, entrants } = this.deps.store.links(slug);
    if (!page && sortants.length === 0 && entrants.length === 0) return undefined;
    return { slug, closed: page?.closed ?? false, sortants, entrants };
  }

  list(prefix: string): string[] {
    return this.deps.store.list(prefix);
  }

  purge(options: { dryRun?: boolean; orphelines?: boolean }) {
    return this.deps.queue.run(QUEUE_KEY, () => this.purgeQueued(options));
  }

  private async purgeQueued(options: { dryRun?: boolean; orphelines?: boolean }) {
    // Matérialiser les pages ferme le curseur SQLite avant toute suppression.
    const pages = [...this.deps.store.all()];
    const tasks = new Map<string, { namespace: string; task: string; slugs: string[] }>();
    for (const page of pages) {
      const match = /^([^/]+)\/(?:plan|dev-handoff|review)\/([^/]+)$/.exec(page.slug);
      if (!match) continue;
      const [, namespace, task] = match;
      if (!namespace || !task || namespace === LESSON_NS) continue;
      const key = `${namespace}/${task}`;
      const entry = tasks.get(key) ?? { namespace, task, slugs: [] as string[] };
      entry.slugs.push(page.slug);
      tasks.set(key, entry);
    }
    const selected: string[] = [];
    const selectedSlugs = new Map<string, string>();
    for (const [key, entry] of tasks) {
      const escaped = entry.task.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const citation = new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`);
      // Une citation peut figurer dans le corps ou le frontmatter de la rétro.
      const closed = pages.some(
        (page) =>
          page.slug.startsWith(`${entry.namespace}/retro/`) &&
          page.slug.split('/').length === 3 &&
          citation.test(renderMarkdown(page)),
      );
      if (closed === !options.orphelines) {
        selected.push(key);
        for (const slug of entry.slugs) selectedSlugs.set(slug, key);
      }
    }
    const dryRun = !!(options.dryRun || options.orphelines);
    const removed: string[] = [];
    const removedTasks = new Set<string>();
    if (!dryRun) {
      // Toute erreur de suppression interrompt la purge et remonte à l'appelant.
      for (const [slug, taskKey] of selectedSlugs) {
        if (await this.removeQueued(slug, { author: 'admin' })) {
          removed.push(slug);
          removedTasks.add(taskKey);
        }
      }
    }
    // Les tâches sont qualifiées par namespace pour distinguer les homonymes.
    return {
      dryRun,
      orphelines: !!options.orphelines,
      tasks: (dryRun ? selected : [...removedTasks]).sort(),
      slugs: (dryRun ? [...selectedSlugs.keys()] : removed).sort(),
    };
  }

  // FTS d'abord ; si les vecteurs répondent, fusion RRF des deux classements (DM5).
  async search(
    q: string,
    scope: string | 'all',
    limit: number,
    { closes = false } = {},
  ): Promise<SearchResult> {
    const { store, hybrid } = this.deps;
    let vectorRanks: Map<string, RankedHit> | undefined;
    const hybridEnabled = hybrid?.enabled();
    if (hybridEnabled && hybrid) {
      try {
        const [qv] = await hybrid.embedder.embed([q]);
        const nearest = (count: number) =>
          (qv ? hybrid.index.nearest(qv, count) : []).filter(({ slug }) => inScope(slug, scope));
        let near = nearest(limit * 2);
        let closed = closes ? new Set<string>() : store.closedSlugs(near.map(({ slug }) => slug));
        if (closed.size > 0) {
          near = nearest(limit * 4);
          closed = store.closedSlugs(near.map(({ slug }) => slug));
        }
        vectorRanks = this.rankHits(near, closed, scope);
      } catch (err) {
        this.deps.log?.(
          `recherche : embedding de la requête impossible : ${(err as Error).message}`,
        );
      }
    }

    const ftsLimit = hybridEnabled ? limit * 2 : limit;
    // Les correspondances closes conservent leur rang avant résolution : on lit plus large, borné.
    const fts = store.searchFts(q, scope, closes ? ftsLimit : ftsLimit * 4, { closes: true });
    const closedFts = closes ? new Set<string>() : store.closedSlugs(fts.map(({ slug }) => slug));
    const ftsRanks = this.rankHits(fts, closedFts, scope, ftsLimit);
    const finish = (mode: SearchResult['mode'], hits: SearchHit[]): SearchResult => ({
      mode,
      hits,
      voisins: this.searchNeighbors(hits, closes),
    });
    if (!vectorRanks) {
      const hits: SearchHit[] = [];
      for (const [slug, { rank, via }] of ftsRanks) {
        const hit = fts[rank - 1]!;
        hits.push(via ? { ...pageHit(store.get(slug)!), score: hit.score, via } : hit);
        if (hits.length >= limit) break;
      }
      return finish('fts', hits);
    }

    const scores = new Map<string, number>();
    for (const ranks of [ftsRanks, vectorRanks]) {
      for (const [slug, { rank }] of ranks) {
        scores.set(slug, (scores.get(slug) ?? 0) + 1 / (RRF_K + rank));
      }
    }
    const hits: SearchHit[] = [];
    for (const [slug, score] of [...scores.entries()].sort((a, b) => b[1] - a[1])) {
      const ftsRank = ftsRanks.get(slug);
      const vectorRank = vectorRanks.get(slug);
      let best = ftsRank;
      if (
        vectorRank &&
        (!best || vectorRank.rank < best.rank || (vectorRank.rank === best.rank && !vectorRank.via))
      ) {
        best = vectorRank;
      }
      const known = ftsRank && !ftsRank.via ? fts[ftsRank.rank - 1] : undefined;
      const page = known ? undefined : store.get(slug);
      if (!known && !page) continue;
      hits.push({
        ...(known ?? pageHit(page!)),
        score: Math.round(score * 1e6) / 1e6,
        ...(best?.via && { via: best.via }),
      });
      if (hits.length >= limit) break;
    }
    return finish('hybrid', hits);
  }

  private rankHits(
    candidates: { slug: string }[],
    closed: Set<string>,
    scope: string,
    limit = Infinity,
  ): Map<string, RankedHit> {
    const ranks = new Map<string, RankedHit>();
    for (const [i, { slug }] of candidates.entries()) {
      if (ranks.size >= limit) break;
      if (!closed.has(slug)) {
        if (!ranks.has(slug)) ranks.set(slug, { rank: i + 1 });
        continue;
      }
      for (const replacement of this.replacements(slug)) {
        if (inScope(replacement, scope) && !ranks.has(replacement)) {
          ranks.set(replacement, { rank: i + 1, via: { slug, type: 'remplace' } });
        }
      }
    }
    return ranks;
  }

  private replacements(slug: string): string[] {
    const { store } = this.deps;
    const seen = new Set([slug]);
    const open: string[] = [];
    let frontier = [slug];
    for (let hop = 0; hop < 5 && frontier.length > 0; hop++) {
      const next: string[] = [];
      for (const current of frontier) {
        for (const link of store.links(current).entrants) {
          if (link.type !== 'remplace' || !link.existe || seen.has(link.slug)) continue;
          seen.add(link.slug);
          const page = store.get(link.slug)!;
          if (page.closed) next.push(link.slug);
          else open.push(link.slug);
        }
      }
      frontier = next;
    }
    return open.sort();
  }

  private searchNeighbors(hits: SearchHit[], closes: boolean): SearchHit[] {
    const { store } = this.deps;
    const seen = new Set(hits.map(({ slug }) => slug));
    const voisins: SearchHit[] = [];
    for (const { slug } of hits) {
      const { sortants, entrants } = store.links(slug);
      const links = [
        ...sortants.map((link) => ({ ...link, sens: 'sortant' as const })),
        ...entrants.map((link) => ({ ...link, sens: 'entrant' as const })),
      ];
      for (const type of NEIGHBOR_TYPES) {
        const matching = links
          .filter((link) => link.type === type && link.existe)
          .sort((a, b) => (a.slug < b.slug ? -1 : Number(a.slug > b.slug)));
        for (const link of matching) {
          if (seen.has(link.slug)) continue;
          seen.add(link.slug);
          const page = store.get(link.slug)!;
          if (!closes && page.closed) continue;
          voisins.push({ ...pageHit(page), via: { slug, type, sens: link.sens } });
          if (voisins.length === 5) return voisins;
        }
      }
    }
    return voisins;
  }

  async health(): Promise<MemoryHealth> {
    const jobs = this.deps.store.jobCounts();
    return {
      pages: this.deps.store.countByNamespace(),
      ...this.deps.store.derivedCounts(),
      fts: true,
      vectors: this.deps.hybrid?.enabled() ? 'ollama' : 'off',
      pendingJobs: jobs.pending,
      failedJobs: jobs.failed,
      mirrorDirty: await this.deps.mirror.dirty(),
      mirrorSync: await this.deps.mirror.syncHealth(),
    };
  }

  put(slug: string, text: string, mode: PutMode, ctx: WriteContext, title?: string) {
    return this.deps.queue.run(QUEUE_KEY, () => this.putQueued(slug, text, mode, ctx, title));
  }

  private async putQueued(
    slug: string,
    text: string,
    mode: PutMode,
    ctx: WriteContext,
    title?: string,
    options?: { onStored?: (page: MemoryPage) => void; preserveContent?: boolean },
  ): Promise<MemoryPage> {
    const { store, mirror, events } = this.deps;
    const before = store.get(slug);
    const page = store.put(
      slug,
      text,
      mode,
      ctx.author,
      title,
      ctx.author === 'import' ? this.deps.log : undefined,
      options?.preserveContent,
    );
    // Le miroir peut échouer après la transaction SQLite.
    options?.onStored?.(page);
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
  }

  decide(input: DecisionInput, ctx: MemoryWriteContext): Promise<MemoryDecision> {
    return this.deps.queue.run(QUEUE_KEY, () => this.decideQueued(input, ctx));
  }

  private async decideQueued(
    input: DecisionInput,
    ctx: MemoryWriteContext,
  ): Promise<MemoryDecision> {
    const { store, events } = this.deps;
    const { namespace, title, raison, texte, remplace } = input;
    const slug = `${namespace}/decision/${input.slug}`;
    if (!isValidNamespace(namespace) || namespace === LESSON_NS) {
      throw new AidHttpError(400, 'namespace de projet attendu', { namespace });
    }
    if (!NAMESPACE_RE.test(input.slug) || !isValidMemSlug(slug)) {
      throw new AidHttpError(400, 'slug de décision invalide : un seul segment attendu', { slug });
    }
    assertMemoryWriteNamespace(ctx, namespace);
    if (new Set(remplace).size !== remplace.length) {
      throw new AidHttpError(400, 'doublon dans remplace');
    }
    if (remplace.includes(slug)) {
      throw new AidHttpError(400, 'une décision ne peut pas se remplacer elle-même', { slug });
    }
    const existing = store.get(slug);
    if (existing) throw new RevisionConflict(slug, existing.revision);

    const originals = remplace.map((target) => {
      if (!isValidMemSlug(target)) throw new AidHttpError(400, new InvalidMemSlug(target).message);
      const page = store.get(target);
      if (!page) throw new AidHttpError(404, 'page absente', { slug: target });
      if (page.closed) throw new AidHttpError(409, 'deja_close', { slug: target });
      assertMemoryWriteNamespace(ctx, namespaceOf(target));
      return page;
    });

    const day = new Date().toISOString().slice(0, 10);
    const decision = renderMarkdown({
      frontmatter: {
        type: 'decision',
        valide_depuis: day,
        raison,
        title,
        ...(remplace.length > 0 && { liens: { remplace } }),
      },
      body: texte
        ? `# ${title}

${texte}`
        : `# ${title}`,
    });
    let created: MemoryPage | undefined;
    const closed: Array<{ original: MemoryPage; revision: number }> = [];
    try {
      const page = await this.putQueued(slug, decision, { kind: 'create' }, ctx, title, {
        onStored: (saved) => {
          created = saved;
        },
      });
      for (const original of originals) {
        const current = store.get(original.slug);
        if (!current || current.revision !== original.revision) {
          throw new RevisionConflict(original.slug, current?.revision ?? 0);
        }
        const old = current.frontmatter.remplacee_par;
        const previous = Array.isArray(old) ? old : typeof old === 'string' ? [old] : [];
        const text = renderMarkdown({
          frontmatter: {
            ...current.frontmatter,
            close_le: day,
            remplacee_par: previous.includes(slug) ? previous : [...previous, slug],
          },
          body: current.body,
        });
        await this.putQueued(
          original.slug,
          text,
          { kind: 'replace', expectedRevision: original.revision },
          ctx,
          undefined,
          {
            preserveContent: true,
            onStored: (saved) => closed.push({ original, revision: saved.revision }),
          },
        );
      }
      const fermees = closed.map(({ original }) => original.slug);
      events.append({
        source: 'daemon',
        type: 'memory.decision',
        ...(ctx.workspaceId && { workspaceId: ctx.workspaceId }),
        ...(ctx.topicId && { topicId: ctx.topicId }),
        ...(ctx.runId && { runId: ctx.runId }),
        ...(ctx.agentId && { agentId: ctx.agentId }),
        data: { slug, fermees, author: ctx.author },
      });
      return { slug, revision: page.revision, fermees };
    } catch (error) {
      const log = this.deps.log ?? console.error;
      for (const { original, revision } of closed.reverse()) {
        try {
          const current = store.get(original.slug);
          if (!current || current.revision !== revision) {
            throw new RevisionConflict(original.slug, current?.revision ?? 0);
          }
          await this.putQueued(
            original.slug,
            renderMarkdown(original),
            { kind: 'replace', expectedRevision: current.revision },
            ctx,
            undefined,
            { preserveContent: true },
          );
        } catch (restoreError) {
          log(`décision : échec de la restauration de ${original.slug} : ${String(restoreError)}`);
        }
      }
      if (created) {
        try {
          const current = store.get(slug);
          if (current && current.revision !== created.revision) {
            throw new RevisionConflict(slug, current.revision);
          }
          await this.removeQueued(slug, ctx);
        } catch (removeError) {
          log(`décision : échec du retrait de ${slug} : ${String(removeError)}`);
        }
      }
      throw error;
    }
  }

  remove(slug: string, ctx: WriteContext): Promise<boolean> {
    return this.deps.queue.run(QUEUE_KEY, () => this.removeQueued(slug, ctx));
  }

  // La purge détient déjà la file des écritures : ne pas l'enfiler à nouveau.
  private async removeQueued(slug: string, ctx: WriteContext): Promise<boolean> {
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
  }

  // DM12 : seuls les fichiers touchés par le tirage sont relus, sans réécrire le miroir.
  synchronizeMirror(action: () => Promise<void>): Promise<void> {
    return this.deps.queue.run(QUEUE_KEY, async () => {
      const { store, mirror } = this.deps;
      await action();
      for (const slug of mirror.pulledSlugs) {
        let text: string;
        try {
          text = readFileSync(mirror.pathOf(slug), 'utf8');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          store.remove(slug);
          this.deps.onRemove?.(slug);
          mirror.pulledSlugs.delete(slug);
          continue;
        }
        store.put(slug, text, { kind: 'force' }, 'mirror', undefined, this.deps.log);
        this.deps.onWrite?.(slug);
        mirror.pulledSlugs.delete(slug);
      }
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
          store.put(f.slug, f.text, { kind: 'create' }, 'reindex', undefined, this.deps.log);
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

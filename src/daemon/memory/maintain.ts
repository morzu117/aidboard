import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { monotonicFactory } from 'ulid';
import type { MemoryProposal, ProposalKind, ProposalState } from '../../shared/memory.js';
import { LESSON_NS } from '../../shared/memory.js';
import type { Db } from '../db.js';
import type { MemoryJob, MemoryJobs } from './jobs.js';
import type { MemoryService, WriteContext } from './service.js';
import { renderMarkdown } from './store.js';
import type { MemoryStore } from './store.js';

const ulid = monotonicFactory();

interface Row {
  id: string;
  kind: ProposalKind;
  slug: string;
  payload: string;
  rationale: string;
  state: ProposalState;
  created_at: string;
  decided_at: string | null;
}

function fromRow(r: Row): MemoryProposal {
  return {
    id: r.id,
    kind: r.kind,
    slug: r.slug,
    payload: JSON.parse(r.payload) as unknown,
    rationale: r.rationale,
    state: r.state,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}

// Propositions d'entretien par modèle local : jamais appliquées sans décision explicite.
export class MemoryProposals {
  constructor(private readonly db: Db) {}

  create(kind: ProposalKind, slug: string, payload: unknown, rationale: string): MemoryProposal {
    const id = `prop_${ulid()}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO memory_proposals (id, kind, slug, payload, rationale, state, created_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(id, kind, slug, JSON.stringify(payload), rationale, now);
    return fromRow({
      id,
      kind,
      slug,
      payload: JSON.stringify(payload),
      rationale,
      state: 'open',
      created_at: now,
      decided_at: null,
    });
  }

  get(id: string): MemoryProposal | undefined {
    const r = this.db.prepare('SELECT * FROM memory_proposals WHERE id = ?').get(id) as
      Row | undefined;
    return r ? fromRow(r) : undefined;
  }

  list(state?: ProposalState): MemoryProposal[] {
    const rows = (
      state
        ? this.db
            .prepare('SELECT * FROM memory_proposals WHERE state = ? ORDER BY created_at')
            .all(state)
        : this.db.prepare('SELECT * FROM memory_proposals ORDER BY created_at').all()
    ) as Row[];
    return rows.map(fromRow);
  }

  // Une proposition déjà ouverte ou déjà décidée pour (slug, kind) : ne pas en recréer une.
  pending(slug: string, kind: ProposalKind): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM memory_proposals WHERE slug = ? AND kind = ? AND state IN ('open', 'applied') LIMIT 1",
      )
      .get(slug, kind);
  }

  decide(id: string, state: 'applied' | 'rejected'): void {
    this.db
      .prepare('UPDATE memory_proposals SET state = ?, decided_at = ? WHERE id = ?')
      .run(state, new Date().toISOString(), id);
  }
}

export interface ChatModel {
  chat(systemPrompt: string, userPrompt: string): Promise<string>;
}

// Client Ollama (/api/chat, format JSON) : utilisé seulement hors chemin de requête (file `maintain`).
export function ollamaChatModel(url: string, model: string): ChatModel {
  const base = url.replace(/\/$/, '');
  return {
    async chat(systemPrompt, userPrompt) {
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          format: 'json',
          stream: false,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`ollama /api/chat : réponse ${res.status}`);
      const body = (await res.json()) as { message?: { content?: string } };
      if (!body.message?.content) throw new Error('ollama /api/chat : réponse sans contenu');
      return body.message.content;
    },
  };
}

const TagsPayload = Type.Object(
  { tags: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 5 }) },
  { additionalProperties: false },
);
const DuplicatePayload = Type.Object(
  { duplicateOf: Type.String({ minLength: 1 }), rationale: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
const SplitPage = Type.Object(
  {
    slug: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    frontmatter: Type.Record(Type.String(), Type.Unknown()),
    body: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
const SplitPayload = Type.Object(
  { pages: Type.Array(SplitPage, { minItems: 2, maxItems: 4 }) },
  { additionalProperties: false },
);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('réponse du modèle : JSON invalide');
  }
}

function rejectedKinds(fm: Record<string, unknown>): ProposalKind[] {
  const v = fm.entretien_rejete;
  return Array.isArray(v) ? v.filter((x): x is ProposalKind => typeof x === 'string') : [];
}

// Ordre de priorité : un job ne traite qu'une seule tâche par page, la plus prioritaire éligible ;
// les suivantes seront reprises une prochaine nuit si la décision libère le slot.
const PRIORITY: ProposalKind[] = ['tags', 'duplicate', 'split'];

function existingTags(store: MemoryStore, namespace: string): string[] {
  const seen = new Set<string>();
  for (const p of store.all()) {
    if (p.namespace !== namespace) continue;
    const tags = p.frontmatter.tags;
    if (Array.isArray(tags)) for (const t of tags) if (typeof t === 'string') seen.add(t);
  }
  return [...seen].sort();
}

function lineCount(body: string): number {
  return body.split('\n').filter((l) => l.trim() !== '').length;
}

function eligibleKind(
  page: { slug: string; namespace: string; frontmatter: Record<string, unknown>; body: string },
  proposals: MemoryProposals,
): ProposalKind | null {
  const rejected = new Set(rejectedKinds(page.frontmatter));
  for (const kind of PRIORITY) {
    if (rejected.has(kind) || proposals.pending(page.slug, kind)) continue;
    if (kind === 'tags') {
      const tags = page.frontmatter.tags;
      if (!Array.isArray(tags) || tags.length === 0) return 'tags';
    } else if (kind === 'duplicate') {
      if (page.namespace === LESSON_NS) return 'duplicate';
    } else if (kind === 'split') {
      if (
        page.namespace === LESSON_NS &&
        (page.frontmatter.a_decouper === true || lineCount(page.body) > 15)
      ) {
        return 'split';
      }
    }
  }
  return null;
}

function inWindow(now: Date, window: string): boolean {
  const [start, end] = window.split('-') as [string, string];
  const toMin = (s: string) => {
    const [h, m] = s.split(':').map(Number);
    return h! * 60 + m!;
  };
  const cur = now.getHours() * 60 + now.getMinutes();
  const s = toMin(start);
  const e = toMin(end);
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e;
}

export interface SchedulerDeps {
  store: MemoryStore;
  jobs: MemoryJobs;
  proposals: MemoryProposals;
  enabled: boolean;
  window: string;
  maxPerNight?: number;
}

// Un job `maintain` par page éligible, au plus `maxPerNight`, seulement dans la fenêtre et si activé.
export function scheduleMaintenance(now: Date, deps: SchedulerDeps): number {
  if (!deps.enabled || !inWindow(now, deps.window)) return 0;
  const max = deps.maxPerNight ?? 20;
  // Matérialiser la liste avant d'enfiler : `jobs.enqueue` exécute d'autres requêtes sur la même
  // connexion, ce que better-sqlite3 refuse tant qu'un `.iterate()` est encore ouvert.
  const pages = [...deps.store.all()];
  let n = 0;
  for (const page of pages) {
    if (n >= max) break;
    if (!eligibleKind(page, deps.proposals)) continue;
    if (deps.jobs.enqueue('maintain', page.slug)) n++;
  }
  return n;
}

export interface MaintainDeps {
  store: MemoryStore;
  proposals: MemoryProposals;
  model: ChatModel;
  log: (line: string) => void;
}

const TAGS_PROMPT = `Tu proposes des tags pour une page de mémoire. Réponds uniquement en JSON de la forme {"tags": ["tag1", "tag2"]}, 1 à 5 tags courts, en minuscules, de préférence parmi les tags existants donnés.`;
const DUPLICATE_PROMPT = `Tu compares une nouvelle leçon aux leçons les plus proches. Réponds uniquement en JSON de la forme {"duplicateOf": "<slug>", "rationale": "<justification>"}.`;
const SPLIT_PROMPT = `Tu découpes une leçon trop longue en pages atomiques. Réponds uniquement en JSON de la forme {"pages": [{"slug": "...", "title": "...", "frontmatter": {}, "body": "..."}]}, 2 à 4 pages.`;

async function runTags(
  page: { slug: string; namespace: string; title: string; body: string },
  deps: MaintainDeps,
): Promise<void> {
  const tags = existingTags(deps.store, page.namespace);
  const content = await deps.model.chat(
    TAGS_PROMPT,
    `Tags existants du namespace « ${page.namespace} » : ${tags.join(', ') || '(aucun)'}\n\nTitre : ${page.title}\n\n${page.body}`,
  );
  const payload = parseJson(content);
  if (!Value.Check(TagsPayload, payload)) throw new Error('proposition tags : forme JSON invalide');
  deps.proposals.create('tags', page.slug, payload, `${payload.tags.length} tag(s) proposé(s)`);
}

async function runDuplicate(
  page: { slug: string; namespace: string; title: string; body: string },
  deps: MaintainDeps,
): Promise<void> {
  const content = await deps.model.chat(DUPLICATE_PROMPT, `Titre : ${page.title}\n\n${page.body}`);
  const payload = parseJson(content);
  if (!Value.Check(DuplicatePayload, payload)) {
    throw new Error('proposition duplicate : forme JSON invalide');
  }
  deps.proposals.create('duplicate', page.slug, payload, payload.rationale);
}

async function runSplit(
  page: { slug: string; namespace: string; title: string; body: string },
  deps: MaintainDeps,
): Promise<void> {
  const content = await deps.model.chat(SPLIT_PROMPT, `Titre : ${page.title}\n\n${page.body}`);
  const payload = parseJson(content);
  if (!Value.Check(SplitPayload, payload))
    throw new Error('proposition split : forme JSON invalide');
  deps.proposals.create('split', page.slug, payload, `découpage en ${payload.pages.length} pages`);
}

// Point d'entrée appelé par le worker pour un job `kind: 'maintain'`.
export async function runMaintainJob(job: MemoryJob, deps: MaintainDeps): Promise<void> {
  const page = job.slug ? deps.store.get(job.slug) : undefined;
  if (!page) return;
  const kind = eligibleKind(page, deps.proposals);
  if (!kind) return;
  if (kind === 'tags') await runTags(page, deps);
  else if (kind === 'duplicate') await runDuplicate(page, deps);
  else await runSplit(page, deps);
}

const MAINTENANCE_CTX: WriteContext = { author: 'maintenance' };

// `apply` : MemoryService.put, author 'maintenance'. `reject` : frontmatter `entretien_rejete` +=  kind.
export async function applyProposal(
  proposal: MemoryProposal,
  memory: MemoryService,
): Promise<void> {
  const page = memory.get(proposal.slug);
  if (!page) throw new Error('page absente');
  if (proposal.kind === 'tags') {
    const { tags } = proposal.payload as { tags: string[] };
    const fm = { ...page.frontmatter, tags };
    const text = renderMarkdown({ frontmatter: fm, body: page.body });
    await memory.put(proposal.slug, text, { kind: 'force' }, MAINTENANCE_CTX);
  } else if (proposal.kind === 'duplicate') {
    const { duplicateOf } = proposal.payload as { duplicateOf: string };
    const fm = { ...page.frontmatter, doublon_de: duplicateOf };
    const text = renderMarkdown({ frontmatter: fm, body: page.body });
    await memory.put(proposal.slug, text, { kind: 'force' }, MAINTENANCE_CTX);
  } else {
    const { pages } = proposal.payload as {
      pages: Array<{
        slug: string;
        title: string;
        frontmatter: Record<string, unknown>;
        body: string;
      }>;
    };
    const created: string[] = [];
    for (const p of pages) {
      const text = renderMarkdown({ frontmatter: p.frontmatter, body: p.body });
      await memory.put(p.slug, text, { kind: 'force' }, MAINTENANCE_CTX, p.title);
      created.push(p.slug);
    }
    const fm = { ...page.frontmatter, remplacee_par: created };
    const text = renderMarkdown({ frontmatter: fm, body: page.body });
    await memory.put(proposal.slug, text, { kind: 'force' }, MAINTENANCE_CTX);
  }
}

export async function rejectProposal(
  proposal: MemoryProposal,
  memory: MemoryService,
): Promise<void> {
  const page = memory.get(proposal.slug);
  if (page) {
    const already = rejectedKinds(page.frontmatter);
    if (!already.includes(proposal.kind)) {
      const fm = { ...page.frontmatter, entretien_rejete: [...already, proposal.kind] };
      const text = renderMarkdown({ frontmatter: fm, body: page.body });
      await memory.put(proposal.slug, text, { kind: 'force' }, MAINTENANCE_CTX);
    }
  }
}

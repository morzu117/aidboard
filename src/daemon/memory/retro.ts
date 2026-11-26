import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { DEFAULT_DUPLICATE_DISTANCE, LESSON_NS } from '../../shared/memory.js';
import type { Db } from '../db.js';
import type { EventStore } from '../events/store.js';
import type { Embedder, VectorIndex } from './embed.js';
import type { MemoryJob } from './jobs.js';
import { type ChatModel, existingTags, type MemoryProposals, parseJson } from './maintain.js';
import { assembleCycleRecit, loadCycleInput } from './recit.js';
import { isValidMemSlug } from './slug.js';
import { type MemoryStore, renderMarkdown } from './store.js';

const RETRO_PROMPT = `Écris une rétro de 15 lignes au plus : ce qui a marché, ce qui a coincé et ce qui reste. Propose zéro à trois leçons durables, chacune une seule affirmation en 15 lignes au plus. Aucune leçon est une réponse normale. Ne recopie jamais un secret ni un chemin. Réponds uniquement en JSON : {"retro":{"title":"…","body":"…"},"lecons":[{"slug":"…","title":"…","domaine":"…","tags":[],"entites":[],"body":"…"}]}. Slug et domaine sont chacun un seul segment en minuscules.`;

const Segment = Type.String({ pattern: '^[a-z0-9][a-z0-9._-]*$' });
const Body = Type.String({ minLength: 1 });
const Title = Type.String({ minLength: 1 });
const RetroReply = Type.Object(
  {
    retro: Type.Object({ title: Title, body: Body }, { additionalProperties: false }),
    lecons: Type.Array(
      Type.Object(
        {
          slug: Segment,
          title: Title,
          domaine: Segment,
          tags: Type.Array(Type.String()),
          entites: Type.Array(Type.String()),
          body: Body,
        },
        { additionalProperties: false },
      ),
      { maxItems: 3 },
    ),
  },
  { additionalProperties: false },
);

interface ProposedPage {
  slug: string;
  text: string;
}

export interface RetroPayload {
  topicId: string;
  retro: ProposedPage;
  lecons: ProposedPage[];
  sources: { pages: string[]; actions: number; reprises: number };
}

interface RetroDeps {
  db: Db;
  memory: MemoryStore;
  events: Pick<EventStore, 'since'>;
  proposals: MemoryProposals;
  model: ChatModel;
  hotesPrives?: string[];
  duplicateDistance?: number;
  vectors?: Partial<Pick<VectorIndex, 'meta' | 'nearestOpenLesson'>>;
  embedder?: Embedder;
  log?: (line: string) => void;
}

function validBody(body: string): boolean {
  return body.trim().length > 0 && body.split(/\r\n|\r|\n/).length <= 15;
}

async function duplicatesOpenLesson(
  title: string,
  body: string,
  deps: RetroDeps,
): Promise<boolean> {
  const { vectors, embedder } = deps;
  if (!vectors?.nearestOpenLesson || !embedder || vectors.meta?.()?.model !== embedder.model) {
    return false;
  }
  const [vector] = await embedder.embed([`${title}\n\n${body}`]);
  const hit = vector && vectors.nearestOpenLesson(vector);
  return (
    !!hit &&
    Number.isFinite(hit.distance) &&
    hit.distance < (deps.duplicateDistance ?? DEFAULT_DUPLICATE_DISTANCE)
  );
}

export async function runRetroJob(job: MemoryJob, deps: RetroDeps): Promise<void> {
  if (!job.slug) return;
  const input = loadCycleInput({ db: deps.db, memory: deps.memory, store: deps.events }, job.slug);
  if (!input) return;
  const { topic, namespace } = input;
  const slug = `${namespace}/retro/${topic.slug}`;
  const { memory, proposals } = deps;
  if (memory.get(slug) || proposals.hasRetro(slug) || proposals.retroSeen(slug)) return;

  const result = assembleCycleRecit(input, { hotesPrives: deps.hotesPrives });
  if (!result.ok) {
    const raison = result.raison === 'vide' ? 'vide' : `refus:${result.classe}`;
    // La page cible n'existe pas encore et n'a donc aucune révision.
    proposals.recordSeen({ slug, revision: 0 }, 'retro', raison);
    // La classe seule : le récit refusé n'est jamais journalisé.
    deps.log?.(`rétro de ${slug} non proposée : ${raison}`);
    return;
  }

  const reply = parseJson(await deps.model.chat(RETRO_PROMPT, result.recit));
  if (
    !Value.Check(RetroReply, reply) ||
    ![reply.retro, ...reply.lecons].every((p) => validBody(p.body))
  ) {
    throw new Error('proposition retro : forme JSON invalide');
  }

  const cycle = `${namespace}/${topic.slug}`;
  const tags = new Set(existingTags(memory, LESSON_NS));
  const lecons = new Map<string, ProposedPage>();
  for (const lecon of reply.lecons) {
    const lessonSlug = `${LESSON_NS}/${lecon.domaine}/${lecon.slug}`;
    if (!isValidMemSlug(lessonSlug)) throw new Error('proposition retro : slug de leçon invalide');
    if (lecons.has(lessonSlug) || memory.get(lessonSlug)) continue;
    if (await duplicatesOpenLesson(lecon.title, lecon.body, deps)) continue;
    const frontmatter = {
      title: lecon.title,
      domaine: lecon.domaine,
      cycle,
      liens: { issu_de: [slug] },
      tags: lecon.tags.filter((tag) => tags.has(tag)),
      entites: lecon.entites,
    };
    lecons.set(lessonSlug, {
      slug: lessonSlug,
      text: renderMarkdown({ frontmatter, body: lecon.body }),
    });
  }

  if (memory.get(slug) || proposals.hasRetro(slug) || proposals.retroSeen(slug)) return;
  const payload: RetroPayload = {
    topicId: topic.id,
    retro: {
      slug,
      text: renderMarkdown({
        frontmatter: { type: 'retro', title: reply.retro.title, cycle },
        body: reply.retro.body,
      }),
    },
    lecons: [...lecons.values()].filter((lecon) => !memory.get(lecon.slug)),
    sources: result.sources,
  };
  proposals.create('retro', slug, payload, `rétro de ${slug} et ${payload.lecons.length} leçon(s)`);
}

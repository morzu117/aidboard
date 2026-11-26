import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { LESSON_NS, RevisionConflict } from '../../shared/memory.js';
import { nettoyer } from '../../shared/nettoyage.js';
import type { EventStore } from '../events/store.js';
import type { MemoryJob } from './jobs.js';
import { type ChatModel, parseJson } from './maintain.js';
import type { MemoryService } from './service.js';
import { isValidMemSlug } from './slug.js';
import { renderMarkdown } from './store.js';

const FAITS_PROMPT = `Extrais de cette page au plus trois faits nouveaux, chacun une seule affirmation de 8 lignes au plus. Aucun fait est une réponse normale. Ne recopie jamais un secret ni un chemin. Réponds uniquement en JSON : {"faits":[{"slug":"…","title":"…","body":"…"}]}. Chaque slug est un seul segment en minuscules, sans point.`;
const MAX_FAITS = 10;
// Un handoff écrit en plusieurs --append grandit : on garde la fin, la plus récente,
// sous la limite de `nettoyer`.
const MAX_SOURCE_CHARS = 12_000;

export function finDeSource(body: string, max = MAX_SOURCE_CHARS): string {
  if (body.length <= max) return body;
  const debut = body.indexOf('\n', body.length - max);
  return '[…]\n' + (debut === -1 ? body.slice(-max) : body.slice(debut + 1));
}

const FaitsReply = Type.Object(
  {
    faits: Type.Array(
      Type.Object(
        {
          slug: Type.String({ pattern: '^[a-z0-9][a-z0-9-]*$' }),
          title: Type.String({ minLength: 1 }),
          body: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 3 },
    ),
  },
  { additionalProperties: false },
);

interface FaitsDeps {
  memory: MemoryService;
  events: Pick<EventStore, 'latestMemoryPageContext'>;
  model: ChatModel;
  hotesPrives?: string[];
  log?: (line: string) => void;
}

export async function runFaitsJob(job: MemoryJob, deps: FaitsDeps): Promise<number> {
  const { memory, events, model, log } = deps;
  const sourceSlug = job.slug;
  if (!sourceSlug) return 0;
  const [, namespace, task] = /^([^/]+)\/(?:dev-handoff|review)\/([^/]+)$/.exec(sourceSlug) ?? [];
  if (!namespace || !task || namespace === LESSON_NS) return 0;
  const source = memory.get(sourceSlug);
  if (!source) return 0;

  const prefix = `${namespace}/fait/${task}.`;
  const existing = memory.list(prefix);
  if (existing.length >= MAX_FAITS) return 0;

  const corps = finDeSource(source.body);
  const filtre = nettoyer(corps, { hotesPrives: deps.hotesPrives });
  if (!filtre.ok) {
    log?.(`faits de ${sourceSlug} non extraits : refus:${filtre.classe}`);
    return 0;
  }

  const context = events.latestMemoryPageContext(sourceSlug);
  const titles = existing.map((slug) => memory.get(slug)?.title).filter(Boolean);
  const message = `${corps}\n\nTitres des faits déjà écrits :\n${JSON.stringify(titles)}`;
  const reply = parseJson(await model.chat(FAITS_PROMPT, message));
  if (
    !Value.Check(FaitsReply, reply) ||
    reply.faits.some(
      ({ title, body }) => !title.trim() || !body.trim() || body.split(/\r\n|\r|\n/).length > 8,
    )
  ) {
    throw new Error('extraction de faits : forme JSON invalide');
  }

  const seen = new Set<string>();
  let written = 0;
  for (const { slug, title, body } of reply.faits) {
    if (memory.list(prefix).length >= MAX_FAITS) break;
    const target = prefix + slug;
    if (!isValidMemSlug(target) || seen.has(target) || memory.get(target)) continue;
    seen.add(target);
    const text = renderMarkdown({
      frontmatter: {
        statut: 'candidat',
        title,
        cycle: `${namespace}/${task}`,
        liens: { issu_de: [sourceSlug] },
      },
      body,
    });
    try {
      await memory.put(target, text, { kind: 'create' }, { ...context, author: 'maintenance' });
      written++;
    } catch (err) {
      if (!(err instanceof RevisionConflict)) throw err;
    }
  }
  if (written > 0) log?.(`faits de ${sourceSlug} : ${written} écrit(s)`);
  return written;
}

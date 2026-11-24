import type { AidEvent } from '../../shared/events.js';
import type { MemoryPage } from '../../shared/memory.js';
import type { TopicState } from '../../shared/model.js';
import { nettoyer } from '../../shared/nettoyage.js';
import type { Db } from '../db.js';
import type { EventStore } from '../events/store.js';
import type { MemoryService } from './service.js';

export interface CycleInput {
  topic: { id: string; slug: string; title?: string; createdAt: string; state: TopicState };
  namespace: string;
  pages: MemoryPage[];
  events: AidEvent[];
}

export type CycleRecit =
  | { ok: true; recit: string; sources: { pages: string[]; actions: number; reprises: number } }
  | { ok: false; raison: 'vide' }
  | { ok: false; raison: 'refus'; classe: string };

const MAX_CHARS = 12_000;
const COUPE = '[…]';

function phaseSlugs(namespace: string, slug: string): string[] {
  return ['plan', 'dev-handoff', 'review'].map((phase) => `${namespace}/${phase}/${slug}`);
}

function couper(texte: string, budget: number): string {
  if (texte.length <= budget) return texte;
  if (budget < COUPE.length) return '';
  const limite = budget - COUPE.length;
  const fin = texte.lastIndexOf('\n', limite - 1);
  return limite > 0 && fin > 0 ? texte.slice(0, fin).trimEnd() + '\n' + COUPE : COUPE;
}

export function assembleCycleRecit(
  { topic, namespace, pages, events }: CycleInput,
  { maxChars = MAX_CHARS, hotesPrives = [] }: { maxChars?: number; hotesPrives?: string[] } = {},
): CycleRecit {
  if (pages.length === 0) return { ok: false, raison: 'vide' };
  const budget = Number.isNaN(maxChars)
    ? MAX_CHARS
    : Math.max(0, Math.min(MAX_CHARS, Math.floor(maxChars)));
  const phases = phaseSlugs(namespace, topic.slug);
  const rang = (slug: string) => (phases.includes(slug) ? phases.indexOf(slug) : phases.length);
  const ordonnees = [...pages].sort(
    (a, b) => rang(a.slug) - rang(b.slug) || a.slug.localeCompare(b.slug),
  );

  const actions: string[] = [];
  let reprises = 0;
  const debut = Date.parse(topic.createdAt);
  let dernier = debut;
  let merge = -Infinity;
  for (const event of events) {
    // Seule la date de l'enveloppe sert au calcul de la durée de repli.
    const date = Date.parse(event.ts);
    if (date > dernier) dernier = date;
    switch (event.type) {
      case 'topic.state':
        if (event.data.state === 'merged' && date > merge) merge = date;
        break;
      case 'agent.resumed':
        reprises++;
        break;
      case 'action.finished': {
        const { action, outcome, exitCode } = event.data;
        if (typeof action === 'string' && typeof outcome === 'string') {
          const code = typeof exitCode === 'number' ? exitCode : 'indisponible';
          actions.push(`- ${action} — ${outcome} (code de sortie ${code})`);
        }
        break;
      }
    }
  }

  const secondes = Math.max(
    0,
    Math.floor(((merge === -Infinity ? dernier : merge) - debut) / 1000),
  );
  const titre = topic.title ? `${topic.slug} — ${topic.title}` : topic.slug;
  const duree = Number.isFinite(secondes) ? `${secondes} s` : 'indisponible';
  const entete = couper(
    `# ${titre}\n\nDurée du cycle : ${duree}\n\n${reprises} reprise${reprises !== 1 ? 's' : ''}`,
    budget,
  );

  let restant = budget - entete.length;
  const sections: { page: MemoryPage; titre: string }[] = [];
  for (const page of ordonnees) {
    const titre = `\n\n## ${page.slug}${page.closed ? ' (close)' : ''}\n\n`;
    if (titre.length + COUPE.length > restant) break;
    sections.push({ page, titre });
    restant -= titre.length + COUPE.length;
  }

  let blocActions = '';
  let nombreActions = 0;
  for (const action of actions) {
    const ligne = nombreActions === 0 ? `\n\n## Actions\n\n${action}` : `\n${action}`;
    if (ligne.length > restant) break;
    blocActions += ligne;
    restant -= ligne.length;
    nombreActions++;
  }

  const part = COUPE.length + Math.floor(restant / Math.max(1, sections.length));
  const blocPages = sections.map(({ page, titre }) => titre + couper(page.body, part)).join('');
  const recit = entete + blocPages + blocActions;
  const filtre = nettoyer(recit, { hotesPrives });
  if (!filtre.ok) return { ok: false, raison: 'refus', classe: filtre.classe };
  return {
    ok: true,
    recit,
    sources: { pages: sections.map(({ page }) => page.slug), actions: nombreActions, reprises },
  };
}

export function loadCycleInput(
  {
    db,
    memory,
    store,
  }: { db: Db; memory: Pick<MemoryService, 'get'>; store: Pick<EventStore, 'since'> },
  topicId: string,
): CycleInput | null {
  const row = db
    .prepare(
      `SELECT t.id, t.slug, t.title, t.created_at AS createdAt, t.state, w.namespace, w.name
       FROM topics t JOIN workspaces w ON w.id = t.workspace_id WHERE t.id = ?`,
    )
    .get(topicId) as
    | (Omit<CycleInput['topic'], 'title'> & {
        title: string | null;
        namespace: string | null;
        name: string;
      })
    | undefined;
  if (!row) return null;
  const { namespace, name, title, ...topic } = row;
  const ns = namespace ?? name;
  const slugs = new Set(phaseSlugs(ns, topic.slug));
  const events = store.since(null, { topicId });
  for (const event of events) {
    if (event.type !== 'memory.page' && event.type !== 'memory.decision') continue;
    const { slug, op } = event.data;
    if (typeof slug === 'string' && op !== 'delete' && op !== 'rm') slugs.add(slug);
  }
  const pages: MemoryPage[] = [];
  for (const slug of slugs) {
    const page = memory.get(slug);
    if (page) pages.push(page);
  }
  return { topic: { ...topic, ...(title !== null && { title }) }, namespace: ns, pages, events };
}

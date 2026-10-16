import type { MemoryPage, MemoryProposal } from '../../../src/shared/memory.js';

export const MEMORY_KINDS = ['plan', 'dev-handoff', 'review', 'retro'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  plan: 'Plan',
  'dev-handoff': 'Passation dev',
  review: 'Revue',
  retro: 'Rétro',
};

export type Call = <T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
) => Promise<T>;

export function memorySlug(namespace: string, kind: MemoryKind, topicSlug: string): string {
  return `${namespace}/${kind}/${topicSlug}`;
}

// Une liste (juste des slugs, léger) pour savoir quelles phases existent, puis une lecture par
// page existante : pas un 404 pour chaque phase pas encore écrite.
export async function fetchSubjectMemory(
  call: Call,
  namespace: string,
  topicSlug: string,
): Promise<Partial<Record<MemoryKind, MemoryPage>>> {
  const { slugs } = await call<{ slugs: string[] }>(
    'GET',
    `/api/memory/pages?prefix=${encodeURIComponent(`${namespace}/`)}`,
  );
  const present = new Set(slugs);
  const out: Partial<Record<MemoryKind, MemoryPage>> = {};
  await Promise.all(
    MEMORY_KINDS.filter((kind) => present.has(memorySlug(namespace, kind, topicSlug))).map(
      async (kind) => {
        out[kind] = await call<MemoryPage>(
          'GET',
          `/api/memory/pages/${memorySlug(namespace, kind, topicSlug)}`,
        );
      },
    ),
  );
  return out;
}

// Propositions d'entretien par modèle local, pour les pages du namespace du sujet : jamais
// appliquées sans clic (06.10).
export async function fetchOpenProposals(
  call: Call,
  namespace: string,
  topicSlug: string,
): Promise<MemoryProposal[]> {
  const { proposals } = await call<{ proposals: MemoryProposal[] }>(
    'GET',
    '/api/memory/proposals?state=open',
  );
  return proposals.filter((p) =>
    MEMORY_KINDS.some((kind) => p.slug === memorySlug(namespace, kind, topicSlug)),
  );
}

export function applyProposal(call: Call, id: string): Promise<{ id: string; state: string }> {
  return call('POST', `/api/memory/proposals/${id}/apply`);
}

export function rejectProposal(call: Call, id: string): Promise<{ id: string; state: string }> {
  return call('POST', `/api/memory/proposals/${id}/reject`);
}

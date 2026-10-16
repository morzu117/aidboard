import { MEM_SLUG_MAX, MEM_SLUG_RE, MEM_SLUG_RULE } from '../../shared/memory.js';

export function isValidMemSlug(slug: string): boolean {
  return slug.length <= MEM_SLUG_MAX && MEM_SLUG_RE.test(slug);
}

export class InvalidMemSlug extends Error {
  constructor(readonly slug: string) {
    super(`${MEM_SLUG_RULE} (reçu : ${JSON.stringify(slug)})`);
  }
}

export function assertMemSlug(slug: string): void {
  if (!isValidMemSlug(slug)) throw new InvalidMemSlug(slug);
}

// Un namespace est un segment seul : le premier d'un slug de page.
export const NAMESPACE_RE = /^[a-z0-9][a-z0-9._-]*$/;
export function isValidNamespace(ns: string): boolean {
  return ns.length <= 100 && NAMESPACE_RE.test(ns);
}

// Premier segment : c'est lui qui borne les écritures d'un token de run.
export function namespaceOf(slug: string): string {
  return slug.slice(0, slug.indexOf('/'));
}

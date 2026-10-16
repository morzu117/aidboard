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

// Premier segment : c'est lui qui borne les écritures d'un token de run.
export function namespaceOf(slug: string): string {
  return slug.slice(0, slug.indexOf('/'));
}

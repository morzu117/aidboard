export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

export function slugify(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  if (!isValidSlug(slug)) throw new Error('titre sans lettre ni chiffre : slug impossible');
  return slug;
}

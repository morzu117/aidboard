import { Marked } from 'marked';
import { LINK_TYPES, MEM_SLUG_RE, type LinkType } from '../../shared/memory.js';
import { isValidMemSlug } from './slug.js';

// Le lexer Markdown écarte les blocs et les segments de code, même dans les listes et citations.
const markdown = new Marked({
  extensions: [
    {
      name: 'citationMemoire',
      level: 'inline',
      start(src) {
        const index = src.indexOf('[[');
        return index < 0 ? undefined : index;
      },
      tokenizer(src) {
        const raw = /^\[\[[^\][\r\n]+\]\]/.exec(src)?.[0];
        if (raw) return { type: 'citationMemoire', raw };
      },
    },
  ],
});

const DATE_RE =
  /^(\d{4}-\d{2}-\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?)?$/;

// Les dates seules commencent à minuit UTC. Un horaire sans décalage est aussi lu en UTC.
function readDate(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const day = DATE_RE.exec(value)?.[1];
  if (!day) return undefined;
  const midnight = Date.parse(day);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== day) {
    return undefined;
  }
  if (value === day) return midnight;
  const at = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`);
  return Number.isFinite(at) ? at : undefined;
}

export function deriveMemoryLinks(
  { slug, frontmatter, body }: { slug: string; frontmatter: Record<string, unknown>; body: string },
  now: Date,
): {
  closed: boolean;
  liens: Array<{ from: string; to: string; type: LinkType }>;
  erreurs: string[];
} {
  const liens: Array<{ from: string; to: string; type: LinkType }> = [];
  const erreurs: string[] = [];
  const date = (key: string) => {
    if (!Object.hasOwn(frontmatter, key)) return undefined;
    const at = readDate(frontmatter[key]);
    if (at === undefined) erreurs.push(`${key} : date attendue (AAAA-MM-JJ ou instant ISO 8601)`);
    return at;
  };
  const since = date('valide_depuis');
  const close = date('close_le');
  let closed = close !== undefined;
  if (close !== undefined && close > now.getTime()) {
    erreurs.push('close_le : date dans le futur');
    closed = false;
  }
  if (close !== undefined && since !== undefined && close < since) {
    erreurs.push('close_le : date antérieure à valide_depuis');
    closed = false;
  }

  const add = (target: string, type: LinkType, key: string, reverse = false) => {
    if (target === slug) {
      erreurs.push(`${key} : lien vers soi-même (${slug})`);
      return false;
    }
    liens.push(reverse ? { from: target, to: slug, type } : { from: slug, to: target, type });
    return true;
  };
  const addList = (value: unknown, type: LinkType, key: string, reverse = false) => {
    if (!Array.isArray(value)) {
      erreurs.push(`${key} : liste de slugs valides attendue`);
      return false;
    }
    let added = false;
    for (const target of value) {
      if (typeof target !== 'string' || !isValidMemSlug(target)) {
        erreurs.push(
          `${key} : slug invalide (${typeof target === 'string' ? JSON.stringify(target) : 'valeur non textuelle'}) dans la liste`,
        );
      } else if (add(target, type, key, reverse)) {
        added = true;
      }
    }
    return added;
  };

  if (Object.hasOwn(frontmatter, 'liens')) {
    const declared = frontmatter.liens;
    if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) {
      erreurs.push('liens : objet de types vers des listes de slugs attendu');
    } else {
      for (const [type, targets] of Object.entries(declared)) {
        const key = `liens.${type}`;
        const known = LINK_TYPES.find((item) => item === type && item !== 'cite');
        if (known === undefined) erreurs.push(`${key} : type de lien inconnu`);
        else addList(targets, known, key);
      }
    }
  }

  for (const key of ['issu_de', 'remplacee_par', 'doublon_de'] as const) {
    if (!Object.hasOwn(frontmatter, key)) continue;
    const target = frontmatter[key];
    if (key === 'remplacee_par') {
      if (addList(typeof target === 'string' ? [target] : target, 'remplace', key, true)) {
        closed = true;
      }
    } else if (typeof target !== 'string' || !isValidMemSlug(target)) {
      erreurs.push(`${key} : slug valide attendu`);
    } else if (key === 'issu_de') {
      add(target, 'issu_de', key);
    } else if (add(target, 'remplace', key, true)) {
      closed = true;
    }
  }

  markdown.walkTokens(markdown.lexer(body), (token) => {
    if (token.type !== 'citationMemoire') return;
    const target = token.raw.slice(2, -2);
    // Une page qui se cite elle-même n'est pas une erreur d'écriture : la citation est ignorée.
    if (MEM_SLUG_RE.test(target) && target !== slug) add(target, 'cite', 'cite');
  });
  return { closed, liens, erreurs };
}

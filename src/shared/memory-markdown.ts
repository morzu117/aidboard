import { parse } from 'yaml';

type Frontmatter = Record<string, unknown>;

function isRecord(v: unknown): v is Frontmatter {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

// Une page = frontmatter YAML facultatif puis corps. Le titre vient du frontmatter, sinon du premier « # ».
export function parseMarkdown(text: string): {
  frontmatter: Frontmatter;
  body: string;
  title: string | undefined;
} {
  let frontmatter: Frontmatter = {};
  let body = text;
  const m = FRONTMATTER_RE.exec(text);
  if (m) {
    const doc: unknown = m[1]!.trim() === '' ? {} : parse(m[1]!);
    if (doc !== null && doc !== undefined && !isRecord(doc)) {
      throw new Error('frontmatter : un objet YAML est attendu');
    }
    frontmatter = (doc as Frontmatter | null | undefined) ?? {};
    body = text.slice(m[0].length);
  }
  body = body.replace(/^\s*\n/, '').replace(/\s+$/, '');
  const fmTitle = frontmatter.title;
  const heading = /^#\s+(.+?)\s*$/m.exec(body)?.[1];
  const title = typeof fmTitle === 'string' && fmTitle.trim() ? fmTitle.trim() : heading;
  return { frontmatter, body, title };
}

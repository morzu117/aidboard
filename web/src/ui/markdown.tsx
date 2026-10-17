import type { ReactNode } from 'react';
import { marked, type Token, type Tokens } from 'marked';

// 11.8 (D30) : `marked` en tokenizer seulement — jamais de `dangerouslySetInnerHTML`. On
// mappe chaque token vers les `data-type` du README de l'export et on le rend nous-mêmes en
// JSX. Le sommaire est dérivé des mêmes tokens (titres de niveau 2), pas d'un second parseur.

export interface MarkdownHeading {
  id: string;
  text: string;
}

function slugify(text: string, seen: Map<string, number>): string {
  const base =
    text
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section';
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}

function renderInline(tokens: Token[], keyPrefix: string): ReactNode[] {
  return tokens.map((t, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (t.type) {
      case 'text': {
        const tt = t as Tokens.Text;
        return tt.tokens ? (
          <span key={key}>{renderInline(tt.tokens, key)}</span>
        ) : (
          <span key={key}>{tt.text}</span>
        );
      }
      case 'escape':
        return <span key={key}>{(t as Tokens.Escape).text}</span>;
      case 'strong':
        return (
          <strong key={key} className="md-gras">
            {renderInline((t as Tokens.Strong).tokens, key)}
          </strong>
        );
      case 'em':
        return <em key={key}>{renderInline((t as Tokens.Em).tokens, key)}</em>;
      case 'del':
        return <del key={key}>{renderInline((t as Tokens.Del).tokens, key)}</del>;
      case 'codespan':
        return (
          <code key={key} className="md-code-ligne">
            {(t as Tokens.Codespan).text}
          </code>
        );
      case 'br':
        return <br key={key} />;
      case 'link': {
        const lk = t as Tokens.Link;
        // Un lien relatif (vers un autre fichier du worktree) n'est pas un contenu de
        // confiance à faire naviguer tel quel ; seuls les liens http(s) restent cliquables.
        if (!/^https?:\/\//.test(lk.href)) {
          return (
            <span key={key} className="md-lien">
              {renderInline(lk.tokens, key)}
            </span>
          );
        }
        return (
          <a key={key} className="md-lien" href={lk.href} target="_blank" rel="noreferrer noopener">
            {renderInline(lk.tokens, key)}
          </a>
        );
      }
      case 'html':
        return <span key={key}>{(t as Tokens.Tag).raw}</span>;
      default:
        return <span key={key}>{'text' in t ? (t as { text: string }).text : ''}</span>;
    }
  });
}

// Le contenu d'un item de liste est aplati en ligne (span.md-texte) plutôt que ré-enveloppé
// dans un <p> : un paragraphe à l'intérieur d'un <span> serait invalide.
function renderListItemBody(
  tokens: Token[],
  keyPrefix: string,
  headings: MarkdownHeading[],
  seen: Map<string, number>,
): ReactNode[] {
  const out: ReactNode[] = [];
  tokens.forEach((t, i) => {
    const key = `${keyPrefix}-${i}`;
    if (t.type === 'text') {
      const tt = t as Tokens.Text;
      out.push(...(tt.tokens ? renderInline(tt.tokens, key) : [<span key={key}>{tt.text}</span>]));
    } else if (t.type === 'paragraph') {
      out.push(...renderInline((t as Tokens.Paragraph).tokens, key));
    } else {
      out.push(...renderBlocks([t], key, headings, seen));
    }
  });
  return out;
}

function renderBlocks(
  tokens: Token[],
  keyPrefix: string,
  headings: MarkdownHeading[],
  seen: Map<string, number>,
): ReactNode[] {
  return tokens.map((t, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (t.type) {
      case 'heading': {
        const h = t as Tokens.Heading;
        const id = slugify(h.text, seen);
        if (h.depth === 2) headings.push({ id, text: h.text });
        if (h.depth === 1) {
          return (
            <h1 key={key} id={id} className="md-h1" data-type="h1">
              {renderInline(h.tokens, key)}
            </h1>
          );
        }
        if (h.depth === 2) {
          return (
            <h2 key={key} id={id} className="md-h2" data-type="h2">
              {renderInline(h.tokens, key)}
            </h2>
          );
        }
        return (
          <h3 key={key} id={id} className="md-h3" data-type="h3">
            {renderInline(h.tokens, key)}
          </h3>
        );
      }
      case 'paragraph': {
        const p = t as Tokens.Paragraph;
        return (
          <p key={key} className="md-p" data-type="paragraphe">
            {renderInline(p.tokens, key)}
          </p>
        );
      }
      case 'list': {
        const l = t as Tokens.List;
        return (
          <ul key={key} className="md-liste" data-type="liste">
            {l.items.map((item, j) => (
              <li key={`${key}-${j}`} className={`md-item${item.checked ? ' md-item--faite' : ''}`}>
                {item.task ? (
                  <span
                    className={`md-case${item.checked ? ' md-case--faite' : ''}`}
                    role="img"
                    aria-label={item.checked ? 'fait' : 'à faire'}
                  >
                    {item.checked ? '✓' : ''}
                  </span>
                ) : (
                  <span className="md-puce" aria-hidden="true">
                    •
                  </span>
                )}
                <span className="md-texte">
                  {renderListItemBody(item.tokens, `${key}-${j}`, headings, seen)}
                </span>
              </li>
            ))}
          </ul>
        );
      }
      case 'table': {
        const tb = t as Tokens.Table;
        return (
          <div key={key} className="md-tableau" role="table" data-type="tableau">
            <div className="md-ligne-tableau" role="row">
              {tb.header.map((c, j) => (
                <span key={j} className="md-cellule" role="columnheader">
                  {renderInline(c.tokens, `${key}-h-${j}`)}
                </span>
              ))}
            </div>
            {tb.rows.map((row, r) => (
              <div key={r} className="md-ligne-tableau" role="row">
                {row.map((c, j) => (
                  <span key={j} className="md-cellule" role="cell">
                    {renderInline(c.tokens, `${key}-${r}-${j}`)}
                  </span>
                ))}
              </div>
            ))}
          </div>
        );
      }
      case 'code': {
        const c = t as Tokens.Code;
        return (
          <div key={key} className="md-bloc-code" data-type="code">
            <div className="md-bloc-entete">
              <span>{c.lang ?? ''}</span>
              <button
                className="bouton"
                type="button"
                data-action="md.copier-code"
                onClick={() => void navigator.clipboard.writeText(c.text)}
              >
                Copier
              </button>
            </div>
            <pre className="md-pre">{c.text}</pre>
          </div>
        );
      }
      case 'blockquote': {
        const bq = t as Tokens.Blockquote;
        return (
          <blockquote key={key} className="md-citation" data-type="citation">
            {renderBlocks(bq.tokens, key, headings, seen)}
          </blockquote>
        );
      }
      case 'space':
      case 'hr':
        return null;
      case 'text': {
        const tt = t as Tokens.Text;
        return <span key={key}>{tt.tokens ? renderInline(tt.tokens, key) : tt.text}</span>;
      }
      default:
        return null;
    }
  });
}

export function renderMarkdown(content: string): {
  body: ReactNode[];
  headings: MarkdownHeading[];
} {
  const tokens = marked.lexer(content);
  const headings: MarkdownHeading[] = [];
  const seen = new Map<string, number>();
  const body = renderBlocks(tokens, 'b', headings, seen);
  return { body, headings };
}

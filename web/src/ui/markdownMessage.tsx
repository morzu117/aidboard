import type { ReactNode } from 'react';
import { marked, type Token, type Tokens } from 'marked';
import { poseUneQuestion } from '../../../src/shared/question.js';
import { renderMarkdown } from './markdown.js';

// Le texte d'un message d'agent, mis en page pour la lecture : le rendu markdown de l'onglet Fichiers,
// plus des cartes (une par titre, dès qu'il y en a deux) et les questions posées à l'opérateur mises
// en évidence. Seule la sortie de `marked.lexer` et de `renderMarkdown` est utilisée : jamais de HTML injecté.

interface Unite {
  raw: string;
  question: boolean;
  html?: boolean;
}

interface Section {
  titre: string | null;
  unites: Unite[];
}

export { poseUneQuestion };

// Un titre : un `#` quelconque, ou une ligne qui n'est qu'un passage en gras (la convention des agents).
function titreDe(t: Token): string | null {
  if (t.type === 'heading') return (t as Tokens.Heading).text;
  if (t.type !== 'paragraph') return null;
  const { tokens } = t as Tokens.Paragraph;
  const seul = tokens[0];
  return tokens.length === 1 && seul?.type === 'strong' ? (seul as Tokens.Strong).text : null;
}

// Une liste se découpe en items : chacun est une unité, donc une question y est isolée.
function unitesDe(t: Token): Unite[] {
  switch (t.type) {
    case 'space':
    case 'hr':
      return [];
    case 'html':
      return [{ raw: t.raw, question: false, html: true }];
    case 'list':
      return (t as Tokens.List).items.map((i) => ({
        raw: i.raw,
        question: poseUneQuestion(i.raw),
      }));
    case 'paragraph':
      return [{ raw: t.raw, question: poseUneQuestion(t.raw) }];
    default:
      return [{ raw: t.raw, question: false }];
  }
}

const uniteNode = (u: Unite, key: string): ReactNode => (
  <div key={key} className={u.question ? 'md-question' : undefined}>
    {u.html ? <p className="md-p">{u.raw.trim()}</p> : renderMarkdown(u.raw).body}
  </div>
);

const titreNode = (titre: string, key: string): ReactNode => (
  <div key={key} className="carte-md-titre">
    {renderMarkdown(titre).body}
  </div>
);

export function rendreMessage(text: string): { corps: ReactNode[]; questions: number } {
  const sections: Section[] = [{ titre: null, unites: [] }];
  for (const t of marked.lexer(text)) {
    const titre = titreDe(t);
    if (titre !== null) sections.push({ titre, unites: [] });
    else sections[sections.length - 1]!.unites.push(...unitesDe(t));
  }
  const cartes = sections.filter((s) => s.titre !== null).length >= 2;
  let questions = 0;
  const corps = sections.map((s, i) => {
    const key = `s${i}`;
    const n =
      s.unites.filter((u) => u.question).length + (s.titre && poseUneQuestion(s.titre) ? 1 : 0);
    questions += n;
    const contenu = [
      ...(s.titre !== null ? [titreNode(s.titre, `${key}-t`)] : []),
      ...s.unites.map((u, j) => uniteNode(u, `${key}-${j}`)),
    ];
    if (!cartes || s.titre === null) return contenu;
    return (
      <section key={key} className={`carte-md${n > 0 ? ' carte-md--question' : ''}`}>
        {contenu}
      </section>
    );
  });
  return { corps, questions };
}

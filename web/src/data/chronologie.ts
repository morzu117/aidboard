import type { CommitSwairm } from '../../../src/shared/swairm-trailers.js';
import type { BoardCardSheet, BoardEvent } from '../../../src/shared/board.js';

export interface EntreeChronologie {
  cle: string;
  date: string | null;
  source: 'etape' | 'obligation' | 'fil' | 'commit';
  sha?: string;
  auteur: string;
  texte: string;
}

export type LimiteChronologie =
  'fil-limite' | { lignesAnterieures: number } | { 'non-lu': 'etapes' | 'obligations' | 'fil' };

function texteObligation(etape: string | null, evenement: BoardEvent): string {
  const debut = `Obligation ${etape ?? 'inconnu'}`;
  switch (evenement.kind) {
    case 'mint':
      return `${debut} ouverte${evenement.holder ? ` pour ${evenement.holder}` : ''}`;
    case 'take':
      return `${debut} prise`;
    case 'amend':
      return `${debut} modifiée`;
    case 'close':
      return `${debut} fermée${evenement.outcome ? ` : ${evenement.outcome}` : ''}`;
    case 'decline':
      return `${debut} déclinée`;
    case 'reassign':
      return `${debut} réattribuée${evenement.holder ? ` à ${evenement.holder}` : ''}`;
    case 'fallback':
      return `${debut} : échéance passée`;
    case 'withdraw':
      return `${debut} retirée`;
    case 'release':
      return `${debut} rendue`;
    default:
      return `${debut} : événement ${evenement.kind}`;
  }
}

/** D237 : fusion locale des trois lectures, sans modifier leurs données. */
export function chronologie({
  card,
  graph,
  thread,
  commits = [],
}: { commits?: CommitSwairm[] } & Pick<BoardCardSheet, 'card' | 'graph' | 'thread'>): {
  entrees: EntreeChronologie[];
  limites: LimiteChronologie[];
} {
  const entrees: EntreeChronologie[] = [];
  const limites: LimiteChronologie[] = [];
  if (card.ok) {
    card.data.stageHistory.forEach((etape, indice) => {
      const ligne = /^gateway \(ligne (\d+)\)$/.exec(etape.by);
      entrees.push({
        cle: `etape-${indice}`,
        date: etape.at,
        source: 'etape',
        auteur: etape.by,
        texte: `Étape → ${etape.stage ?? 'inconnu'}${ligne ? ` (déduite par le gateway, ligne ${ligne[1]})` : ''}`,
      });
    });
  } else limites.push({ 'non-lu': 'etapes' });
  if (graph.ok) {
    let lignesAnterieures = 0;
    graph.data.steps.forEach((etape, indiceEtape) => {
      lignesAnterieures += etape.priorRows;
      etape.events.forEach((evenement, indice) => {
        entrees.push({
          cle: `obligation-${indiceEtape}-${indice}`,
          date: evenement.at,
          source: 'obligation',
          auteur: evenement.by || 'inconnu',
          texte: texteObligation(etape.step, evenement),
        });
      });
    });
    if (lignesAnterieures > 0) limites.push({ lignesAnterieures });
  } else limites.push({ 'non-lu': 'obligations' });
  if (thread.ok) {
    thread.data.messages.forEach((message, indice) => {
      const contenu = message.content ?? '';
      entrees.push({
        cle: `fil-${message.id}-${indice}`,
        date: message.createdAt,
        source: 'fil',
        auteur: message.author,
        texte: contenu.slice(0, 140) + (contenu.length > 140 ? '…' : ''),
      });
    });
    if (thread.data.capped) limites.push('fil-limite');
  } else limites.push({ 'non-lu': 'fil' });

  commits.forEach((commit, indice) =>
    entrees.push({
      cle: `commit-${commit.sha}-${indice}`,
      source: 'commit',
      date: commit.date,
      auteur: commit.drone ?? 'inconnu',
      texte: `Pas ${commit.step} prouvé (${commit.proof}), essai ${commit.attempt}`,
      sha: commit.sha,
    }),
  );

  const horodatage = (date: string | null): number => {
    const valeur = date === null ? NaN : Date.parse(date);
    return Number.isNaN(valeur) ? -Infinity : valeur;
  };
  const reception = new Map(entrees.map((entree, indice) => [entree, indice]));
  const fraction = (date: string | null): string =>
    (date?.match(/\.(\d+)(?:Z|[+-]\d{2}:?\d{2})?$/i)?.[1] ?? '').slice(3).replace(/0+$/, '');
  // À milliseconde égale, comparer la précision restante puis inverser la réception.
  entrees.sort((a, b) => {
    const premier = horodatage(a.date);
    const second = horodatage(b.date);
    if (premier !== second) return premier > second ? -1 : 1;
    const fractionA = premier === -Infinity ? '' : fraction(a.date);
    const fractionB = second === -Infinity ? '' : fraction(b.date);
    if (fractionA !== fractionB) return fractionA > fractionB ? -1 : 1;
    return reception.get(b)! - reception.get(a)!;
  });
  return { entrees, limites };
}

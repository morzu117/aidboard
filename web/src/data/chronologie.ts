import type { BoardCardSheet, BoardEvent } from '../../../src/shared/board.js';

export interface EntreeChronologie {
  cle: string;
  date: string | null;
  source: 'etape' | 'obligation' | 'fil';
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
}: Pick<BoardCardSheet, 'card' | 'graph' | 'thread'>): {
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

  const horodatage = (date: string | null): number => {
    const valeur = date === null ? NaN : Date.parse(date);
    return Number.isNaN(valeur) ? -Infinity : valeur;
  };
  // Le tri stable conserve l'ordre reçu : étapes, événements du graphe, puis fil.
  entrees.sort((a, b) => {
    const premier = horodatage(a.date);
    const second = horodatage(b.date);
    return premier === second ? 0 : premier > second ? -1 : 1;
  });
  return { entrees, limites };
}

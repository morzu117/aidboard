import { parseCard, type BoardCard, type Parsed } from './board.js';

/** D285 : seul le contenu exact d'une ligne établit le lien. */
export function liensSwairm(body: string): { projet: string; id: string }[] {
  const liens: { projet: string; id: string }[] = [];
  for (const ligne of body.split('\n')) {
    const correspondance =
      /^Swairm: ([A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100})#([A-Za-z0-9._/-]{1,200})$/.exec(
        ligne.endsWith('\r') ? ligne.slice(0, -1) : ligne,
      );
    if (correspondance) liens.push({ projet: correspondance[1]!, id: correspondance[2]! });
  }
  return liens;
}

export interface RechercheCartes {
  cards: BoardCard[];
  searched: number;
}

export function parseRechercheCartes(json: unknown): Parsed<RechercheCartes> | null {
  if (typeof json !== 'object' || json === null) return null;
  const corps = json as Record<string, unknown>;
  if (
    !Array.isArray(corps.cards) ||
    typeof corps.searched !== 'number' ||
    !Number.isInteger(corps.searched) ||
    corps.searched < 0
  )
    return null;
  const cards = corps.cards.flatMap((carte) => {
    const resultat = parseCard(carte);
    return resultat ? [resultat.value] : [];
  });
  return { value: { cards, searched: corps.searched }, schemaVersion: null };
}

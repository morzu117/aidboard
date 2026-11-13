/** Palette partagée des avatars et des carrés du rail, dans leur ordre historique. */
export const PALETTE_AVATARS = [
  { id: 'menthe', nom: 'Menthe', valeur: '#5de0a1', ink: '#06251a' },
  { id: 'violet', nom: 'Violet', valeur: '#a78bfa', ink: '#1b1238' },
  { id: 'orange', nom: 'Orange', valeur: '#f59e6b', ink: '#3a1a06' },
  { id: 'bleu', nom: 'Bleu', valeur: '#6ea8ff', ink: '#0b2347' },
  { id: 'rose', nom: 'Rose', valeur: '#f07ab0', ink: '#3d0f26' },
  { id: 'ambre', nom: 'Ambre', valeur: '#f2b84b', ink: '#2a1d00' },
  { id: 'turquoise', nom: 'Turquoise', valeur: '#4fd1d9', ink: '#062f33' },
  { id: 'gris', nom: 'Gris', valeur: '#8d94a0', ink: '#14161a' },
] as const;

export type CouleurAvatar = (typeof PALETTE_AVATARS)[number]['id'];
export interface SurchargeAvatar {
  initiales?: string;
  couleur?: CouleurAvatar;
}
export type SurchargesAvatars = Record<string, SurchargeAvatar>;

export function initialesCell(nom: string): string {
  const morceaux = nom.split(/[-_.\s]+/u).filter(Boolean);
  const initiales =
    morceaux.length >= 2
      ? morceaux
          .slice(0, 2)
          .map((morceau) => morceau.match(/[\p{L}\p{N}]/u)?.[0] ?? '')
          .join('')
      : Array.from(morceaux[0] ?? '')
          .slice(0, 2)
          .join('');
  return initiales.toUpperCase() || '?';
}

/** FNV-1a 32 bits sur les octets UTF-8 du nom, sans normaliser sa casse. */
export function couleurCell(nom: string): CouleurAvatar {
  if (!nom) return 'gris';
  let hachage = 0x811c9dc5;
  for (const octet of new TextEncoder().encode(nom)) {
    hachage = Math.imul(hachage ^ octet, 0x01000193) >>> 0;
  }
  return PALETTE_AVATARS[hachage % 7]!.id;
}

export function avatarCell(
  nom: string,
  surcharges: SurchargesAvatars = {},
): Required<SurchargeAvatar> {
  const surcharge = Object.hasOwn(surcharges, nom) ? surcharges[nom] : undefined;
  return {
    initiales: surcharge?.initiales ?? initialesCell(nom),
    couleur: surcharge?.couleur ?? couleurCell(nom),
  };
}

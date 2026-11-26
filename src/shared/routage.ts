export type Fournisseur = 'claude' | 'codex' | 'vibe';

export type DatesVerification = Partial<Record<Fournisseur, string>>;

export function marqueVerification(dates: DatesVerification | undefined, fournisseur: string) {
  return dates && !Object.hasOwn(dates, fournisseur) ? ' — non vérifié' : '';
}

interface Cible {
  fournisseur: Fournisseur;
  modele: string;
}

export const routage = {
  niveaux: {
    leger: { fournisseur: 'claude', modele: 'haiku' },
    standard: { fournisseur: 'claude', modele: 'sonnet' },
    fort: { fournisseur: 'claude', modele: 'opus' },
  },
  challenge: ['claude', 'codex', 'vibe'],
} as const satisfies { niveaux: Record<string, Cible>; challenge: readonly Fournisseur[] };

export type NiveauAvis = keyof typeof routage.niveaux;

export function modelesAvis(niveau: NiveauAvis, challenge: boolean): string[] {
  if (challenge) {
    return routage.challenge.map((fournisseur) => {
      const modele = fournisseur === 'claude' ? routage.niveaux.fort.modele : 'defaut';
      return `${fournisseur}:${modele}`;
    });
  }
  const { fournisseur, modele } = routage.niveaux[niveau];
  return [`${fournisseur}:${modele}`];
}

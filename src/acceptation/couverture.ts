import { readFile } from 'node:fs/promises';
import { lireCommits } from './verifier.js';

export interface RapportCouverture {
  points: { point: string; etat: 'couvert' | 'non_testable' | 'manquant'; raison?: string }[];
  total: number;
  couverts: number;
  nonTestables: number;
  manquants: number;
  part: number;
}

export async function mesurerCouverture({
  depot,
  base,
  plan,
}: {
  depot: string;
  base: string;
  plan: string;
}): Promise<RapportCouverture> {
  const contenu = await readFile(plan, 'utf8');
  const commits = await lireCommits(depot, base);
  const marques = new Set(commits.flatMap(({ points }) => points));
  const points: RapportCouverture['points'] = [];
  let courant: RapportCouverture['points'][number] | undefined;

  for (const ligne of contenu.split(/\r?\n/)) {
    const titre = /^ {0,3}(#{1,3})(?:[ \t]+(.*)|$)/.exec(ligne);
    if (titre) {
      courant = undefined;
      const point =
        titre[1] === '###' ? /^(\d+\.\d+)(?:[ \t]|$)/.exec(titre[2] ?? '')?.[1] : undefined;
      if (point && !point.endsWith('.1')) {
        courant = { point, etat: marques.has(point) ? 'couvert' : 'manquant' };
        points.push(courant);
      }
      continue;
    }

    if (courant?.etat !== 'manquant') continue;
    const raison = /^\s*(?:-\s+)?_Acceptation\._ Non testable à l'avance :[ \t]?(.*)$/.exec(
      ligne,
    )?.[1];
    if (raison && raison.trim() && raison.trim() !== '.') {
      courant.etat = 'non_testable';
      courant.raison = raison;
    }
  }

  const total = points.length;
  const couverts = points.filter(({ etat }) => etat === 'couvert').length;
  const nonTestables = points.filter(({ etat }) => etat === 'non_testable').length;
  const manquants = total - couverts - nonTestables;
  const testables = total - nonTestables;
  return {
    points,
    total,
    couverts,
    nonTestables,
    manquants,
    part: testables ? couverts / testables : 1,
  };
}

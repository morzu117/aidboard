import type { AccordAsk, Ask, VerdictAsk } from '../../shared/swairm-ask.js';
import type { SousQuestion } from './prompt.js';

const verdicts: ReadonlySet<unknown> = new Set(['oui', 'non', 'nuance', 'ne_sait_pas']);
const estVerdict = (v: unknown): v is VerdictAsk => verdicts.has(v);
export const objet = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Borne l'objet à partir de son accolade ouvrante, même si du texte le suit. */
export function lireObjet(texte: string, debut: number): Record<string, unknown> | null {
  if (debut < 0) return null;
  let niveau = 0;
  let chaine = false;
  for (let i = debut; i < texte.length; i++) {
    const c = texte[i];
    if (chaine && c === '\\') i++;
    else if (c === '"') chaine = !chaine;
    else if (!chaine && c === '{') niveau++;
    else if (!chaine && c === '}' && --niveau === 0) {
      try {
        return JSON.parse(texte.slice(debut, i + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  return null;
}

type Reponse = Ask['avis'][number]['reponses'][number];

export function lireReponse(
  texte: string,
  sousQuestions: SousQuestion[],
): { etat: 'ok' | 'invalide'; reponses: Reponse[] } {
  const invalide = (): ReturnType<typeof lireReponse> => ({
    etat: 'invalide',
    reponses: sousQuestions.map(({ n }) => ({ n, verdict: 'invalide', justification: '' })),
  });
  const valeur = lireObjet(texte, texte.indexOf('{'));
  if (!Array.isArray(valeur?.reponses)) return invalide();
  const attendus = new Set(sousQuestions.map(({ n }) => n));
  const cases = new Map<number, Reponse>();
  for (const caseLue of valeur.reponses as unknown[]) {
    if (!objet(caseLue)) return invalide();
    const { n, verdict, justification } = caseLue;
    if (typeof n !== 'number' || !attendus.has(n) || cases.has(n)) return invalide();
    cases.set(
      n,
      estVerdict(verdict) && typeof justification === 'string'
        ? { n, verdict, justification: justification.slice(0, 600) }
        : { n, verdict: 'invalide', justification: '' },
    );
  }
  const reponses = sousQuestions.map(
    ({ n }): Reponse => cases.get(n) ?? { n, verdict: 'manquant', justification: '' },
  );
  return { etat: reponses.some((r) => r.verdict === 'invalide') ? 'invalide' : 'ok', reponses };
}

export function accord(n: number, votes: Iterable<string>): AccordAsk {
  const compte: AccordAsk['compte'] = {};
  let total = 0;
  let gagnant: VerdictAsk | null = null;
  for (const vote of votes) {
    if (!estVerdict(vote)) continue;
    compte[vote] = (compte[vote] ?? 0) + 1;
    total++;
    if (gagnant === null || compte[vote] > (compte[gagnant] ?? 0)) gagnant = vote;
  }
  if (total < 2 || gagnant === null) return { n, accord: 'insuffisant', verdict: null, compte };
  const voix = compte[gagnant] ?? 0;
  if (voix === total) return { n, accord: 'unanime', verdict: gagnant, compte };
  if (voix > total / 2) return { n, accord: 'majorite', verdict: gagnant, compte };
  return { n, accord: 'partage', verdict: null, compte };
}

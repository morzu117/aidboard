import type { AccordAsk, Ask, VerdictAsk } from './swairm-ask.js';

type SousQuestion = Ask['sous_questions'][number];
type Reponse = Ask['avis'][number]['reponses'][number];
export interface BulletinAvis {
  cell: string;
  tour: 'positions' | 'rebuttal' | 'vote';
  outcome: 'pass' | 'cannot_evaluate' | null;
  corps: string | null;
  annule: boolean;
}
export type PhaseAvis = BulletinAvis['tour'] | 'clos';
export interface AvisMesh {
  format: 'aid-avis-mesh/1';
  sous_questions: SousQuestion[];
  avis: {
    i: number;
    cell: string;
    etat: 'ok' | 'invalide' | 'abstention' | 'secret_suspecte' | 'scelle' | 'attendu' | 'absent';
    reponses: Reponse[];
    brut: string | null;
    vote: 'avis' | 'objection' | 'abstention' | 'scelle' | 'invalide' | null;
  }[];
  accord: AccordAsk[];
  rebuttals: { cell: string; texte: string | null }[];
}

/** Port de morzu117/swairm, oracle/ask_sous_questions.py (blob
 * ee8782e28513154f7bee8f2f58d35c2b0c4162d1), decouper et accord.
 * https://github.com/morzu117/swairm/blob/main/oracle/ask_sous_questions.py
 */
export function decouperSousQuestions(texte: string): SousQuestion[] {
  const debuts = [...texte.matchAll(/^([0-9]+)[.)][ \t]*/gm)];
  if (!debuts.length) return [{ n: 1, texte: texte.trim() }];
  if (debuts.length > 12) throw new Error('Douze sous-questions au maximum sont admises.');
  const numeros = new Set<number>();
  return debuts.map((debut, i) => {
    const n = Number(debut[1]);
    if (!Number.isSafeInteger(n) || n < 1 || numeros.has(n))
      throw new Error('Les numéros doivent être positifs et uniques.');
    numeros.add(n);
    const question = texte.slice(debut.index + debut[0].length, debuts[i + 1]?.index).trim();
    const prefixe = i === 0 ? texte.slice(0, debut.index).trim() : '';
    return { n, texte: prefixe ? `${prefixe}\n${question}` : question };
  });
}

const verdicts: readonly VerdictAsk[] = ['oui', 'non', 'nuance', 'ne_sait_pas'];
const couper = (texte: string, limite: number) => Array.from(texte).slice(0, limite).join('');

/** Borne le premier objet, en respectant les chaînes JSON et leurs échappements. */
function premierObjet(texte: string): unknown {
  const debut = texte.indexOf('{');
  let profondeur = 0;
  let chaine = false;
  let echappe = false;
  for (let i = debut; debut >= 0 && i < texte.length; i++) {
    const c = texte[i];
    if (chaine) {
      if (echappe) echappe = false;
      else if (c === '\\') echappe = true;
      else if (c === '"') chaine = false;
    } else if (c === '"') chaine = true;
    else if (c === '{') profondeur++;
    else if (c === '}' && --profondeur === 0) return JSON.parse(texte.slice(debut, i + 1));
  }
  throw new Error('JSON illisible');
}

function lireBulletin(corps: string, questions: SousQuestion[]): Reponse[] {
  const objet = premierObjet(corps) as { reponses?: unknown } | null;
  if (!objet || !Array.isArray(objet.reponses)) throw new Error('Bulletin invalide');
  const cases = new Map<number, Reponse>();
  for (const valeur of objet.reponses) {
    if (!valeur || typeof valeur !== 'object') throw new Error('Case invalide');
    const { n, verdict, justification } = valeur;
    if (
      !Number.isSafeInteger(n) ||
      !questions.some((q) => q.n === n) ||
      cases.has(n) ||
      !verdicts.includes(verdict) ||
      typeof justification !== 'string'
    )
      throw new Error('Case invalide');
    cases.set(n, { n, verdict, justification: couper(justification, 600) });
  }
  return questions.map(({ n }) => cases.get(n) ?? { n, verdict: 'manquant', justification: '' });
}

export function lireAvis({
  sousQuestions,
  sieges,
  bulletins,
  phase,
}: {
  sousQuestions: SousQuestion[];
  sieges: string[];
  bulletins: BulletinAvis[];
  phase: PhaseAvis;
}): AvisMesh {
  const actifs = bulletins.filter((b) => !b.annule);
  const avis: AvisMesh['avis'] = sieges.map((cell, i) => {
    const positions = actifs.filter((b) => b.cell === cell && b.tour === 'positions');
    const vote =
      phase === 'vote' || phase === 'clos'
        ? actifs.filter((b) => b.cell === cell && b.tour === 'vote').at(-1)
        : undefined;
    const bulletin = positions.at(-1);
    const base: Pick<AvisMesh['avis'][number], 'i' | 'cell' | 'reponses' | 'brut' | 'vote'> = {
      i: i + 1,
      cell,
      reponses: [],
      brut: null,
      vote: !vote
        ? null
        : vote.corps === null
          ? 'scelle'
          : vote.outcome === 'cannot_evaluate'
            ? 'abstention'
            : vote.corps === 'avis' || vote.corps === 'objection'
              ? vote.corps
              : 'invalide',
    };
    if (!bulletin) {
      return { ...base, etat: phase === 'positions' ? 'attendu' : 'absent' };
    }
    if (bulletin.corps === null) return { ...base, etat: 'scelle' };
    if (bulletin.outcome === 'cannot_evaluate')
      return {
        ...base,
        etat: bulletin.corps.trim() === 'secret suspecté' ? 'secret_suspecte' : 'abstention',
      };
    try {
      return { ...base, etat: 'ok', reponses: lireBulletin(bulletin.corps, sousQuestions) };
    } catch {
      return { ...base, etat: 'invalide', brut: couper(bulletin.corps, 4000) };
    }
  });
  const accord = sousQuestions.map(({ n }): AccordAsk => {
    const compte: AccordAsk['compte'] = {};
    for (const avisSiege of avis.filter((a) => a.etat === 'ok')) {
      const verdict = avisSiege.reponses.find((r) => r.n === n)?.verdict;
      if (verdict && verdicts.includes(verdict as VerdictAsk)) {
        const v = verdict as VerdictAsk;
        compte[v] = (compte[v] ?? 0) + 1;
      }
    }
    const total = Object.values(compte).reduce((s, v) => s + v, 0);
    const gagnant = verdicts.find((v) => (compte[v] ?? 0) > total / 2);
    if (total < 2) return { n, accord: 'insuffisant', verdict: null, compte };
    return {
      n,
      accord: gagnant ? (compte[gagnant] === total ? 'unanime' : 'majorite') : 'partage',
      verdict: gagnant ?? null,
      compte,
    };
  });
  return {
    format: 'aid-avis-mesh/1',
    sous_questions: sousQuestions,
    avis,
    accord,
    rebuttals: actifs
      .filter((b) => b.tour === 'rebuttal' && sieges.includes(b.cell))
      .map((b) => ({ cell: b.cell, texte: b.corps })),
  };
}

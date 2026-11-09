/** Contrat CLI swairm ask ; aucun champ de l'enveloppe fournisseur. */
export const ID_ASK = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4}$/;
export const MODELES_ASK = ['sonnet', 'opus', 'haiku'] as const;
export type ModeleAsk = (typeof MODELES_ASK)[number];
export type VerdictAsk = 'oui' | 'non' | 'nuance' | 'ne_sait_pas';
export interface AccordAsk {
  n: number;
  accord: 'insuffisant' | 'unanime' | 'majorite' | 'partage';
  verdict: VerdictAsk | null;
  compte: Partial<Record<VerdictAsk, number>>;
}
export interface Ask {
  format: 'swairm-ask/1';
  id: string;
  genere_a: string;
  prompt_version: string;
  question: string;
  sous_questions: { n: number; texte: string }[];
  avis: {
    i: number;
    modele_demande: string;
    modele_servi: string | null;
    etat: 'ok' | 'invalide' | 'echec' | 'budget' | 'delai';
    cout_usd: number | null;
    duree_s: number | null;
    reponses: { n: number; verdict: VerdictAsk | 'manquant' | 'invalide'; justification: string }[];
    brut: string | null;
  }[];
  accord: AccordAsk[];
  cout_total_usd: number;
}
export interface Asks {
  format: 'swairm-asks/1';
  demandes: { id: string; genere_a: string; question: string; n: number; accord: AccordAsk[] }[];
  erreurs: { fichier: string; erreur: string }[];
}
export type AskResult<T> =
  | { ok: true; data: T; readAt: string }
  | { ok: false; kind: 'aucun-avis'; data: T; readAt: string }
  | { ok: false; kind: 'refusee'; message: string; readAt: string }
  | {
      ok: false;
      kind: 'absent' | 'too-old' | 'timeout' | 'annule' | 'format' | 'unknown';
      readAt: string;
    };

const objet = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('format');
  return v as Record<string, unknown>;
};
const texte = (v: unknown, max = Infinity): string => {
  if (typeof v !== 'string') throw new Error('format');
  return v.slice(0, max);
};
const nombre = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error('format');
  return v;
};
const entier = (v: unknown): number => {
  const n = nombre(v);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('format');
  return n;
};
const choix = <T extends string>(v: unknown, valeurs: readonly T[]): T => {
  if (!valeurs.includes(v as T)) throw new Error('format');
  return v as T;
};
const liste = <T>(v: unknown, lire: (v: unknown) => T): T[] => {
  if (!Array.isArray(v)) throw new Error('format');
  return v.map(lire);
};
const nullable = <T>(v: unknown, lire: (v: unknown) => T): T | null =>
  v === null ? null : lire(v);
const verdicts = ['oui', 'non', 'nuance', 'ne_sait_pas'] as const;
const identifiant = (v: unknown): string => {
  const id = texte(v);
  if (!ID_ASK.test(id)) throw new Error('format');
  return id;
};
function accord(v: unknown): AccordAsk {
  const a = objet(v);
  const compte: AccordAsk['compte'] = {};
  const brut = objet(a.compte);
  for (const cle of verdicts) {
    if (brut[cle] !== undefined) {
      const n = nombre(brut[cle]);
      if (!Number.isSafeInteger(n)) throw new Error('format');
      compte[cle] = n;
    }
  }
  return {
    n: entier(a.n),
    accord: choix(a.accord, ['insuffisant', 'unanime', 'majorite', 'partage']),
    verdict: nullable(a.verdict, (v) => choix(v, verdicts)),
    compte,
  };
}
export function parseAsk(v: unknown): Ask | null {
  try {
    const a = objet(v);
    return {
      format: choix(a.format, ['swairm-ask/1']),
      id: identifiant(a.id),
      genere_a: texte(a.genere_a),
      prompt_version: texte(a.prompt_version),
      question: texte(a.question, 20000),
      sous_questions: liste(a.sous_questions, (v) => {
        const s = objet(v);
        return { n: entier(s.n), texte: texte(s.texte) };
      }),
      avis: liste(a.avis, (v) => {
        const b = objet(v);
        return {
          i: entier(b.i),
          modele_demande: texte(b.modele_demande),
          modele_servi: nullable(b.modele_servi, texte),
          etat: choix(b.etat, ['ok', 'invalide', 'echec', 'budget', 'delai']),
          cout_usd: nullable(b.cout_usd, nombre),
          duree_s: nullable(b.duree_s, nombre),
          reponses: liste(b.reponses, (v) => {
            const r = objet(v);
            return {
              n: entier(r.n),
              verdict: choix(r.verdict, [...verdicts, 'manquant', 'invalide']),
              justification: texte(r.justification, 600),
            };
          }),
          brut: nullable(b.brut, (v) => texte(v, 4000)),
        };
      }),
      accord: liste(a.accord, accord),
      cout_total_usd: nombre(a.cout_total_usd),
    };
  } catch {
    return null;
  }
}
export function parseAsks(v: unknown): Asks | null {
  try {
    const a = objet(v);
    return {
      format: choix(a.format, ['swairm-asks/1']),
      demandes: liste(a.demandes, (v) => {
        const d = objet(v);
        return {
          id: identifiant(d.id),
          genere_a: texte(d.genere_a),
          question: texte(d.question, 200),
          n: entier(d.n),
          accord: liste(d.accord, accord),
        };
      }),
      erreurs: liste(a.erreurs, (v) => {
        const e = objet(v);
        return { fichier: texte(e.fichier), erreur: texte(e.erreur) };
      }),
    };
  } catch {
    return null;
  }
}

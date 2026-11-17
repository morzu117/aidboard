import { createHash } from 'node:crypto';

import { texteCommandantValide } from './commandant-texte.js';
import { unicodeValide } from './commandant-texte.js';
export { texteCommandantValide, longueurCommandant } from './commandant-texte.js';

export type JsonCommandant =
  null | boolean | number | string | JsonCommandant[] | { [cle: string]: JsonCommandant };

/** JCS sur le sous-ensemble entier du contrat ; tri par unités UTF-16, sans normalisation. */
export function serialiserJcs(valeur: unknown): string {
  const ancetres = new Set<object>();
  const chaine = (texte: string): string => {
    if (!unicodeValide(texte)) throw new Error('Unicode invalide');
    return JSON.stringify(texte);
  };
  function encoder(v: unknown): string {
    if (v === null) return 'null';
    if (typeof v === 'string') return chaine(v);
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'number' && Number.isSafeInteger(v)) return JSON.stringify(v);
    if (typeof v !== 'object' || ancetres.has(v)) throw new Error('Valeur JSON invalide');
    if (
      !Array.isArray(v) &&
      Object.getPrototypeOf(v) !== Object.prototype &&
      Object.getPrototypeOf(v) !== null
    )
      throw new Error('Objet JSON invalide');
    ancetres.add(v);
    try {
      if (Array.isArray(v)) {
        return '[' + Array.from({ length: v.length }, (_, i) => encoder(v[i])).join(',') + ']';
      }
      if (Object.getOwnPropertySymbols(v).length) throw new Error('Clé JSON invalide');
      return (
        '{' +
        Object.keys(v)
          .sort()
          .map((cle) => chaine(cle) + ':' + encoder((v as Record<string, unknown>)[cle]))
          .join(',') +
        '}'
      );
    } finally {
      ancetres.delete(v);
    }
  }
  return encoder(valeur);
}

export function digestCommandant(ligne: { id: number; type: string; params: unknown }): string {
  return createHash('sha256')
    .update(serialiserJcs({ id: ligne.id, type: ligne.type, params: ligne.params }), 'utf8')
    .digest('hex');
}

export const STATUTS_COMMANDANT = [
  'pending',
  'approved',
  'rejected',
  'answered',
  'executed',
  'failed',
  'stale',
  'withdrawn',
] as const;
export type StatutCommandant = (typeof STATUTS_COMMANDANT)[number];
/** Retourne un instant, jamais une chaîne comparable lexicalement. */
export function dateCommandant(valeur: unknown): number | null {
  if (typeof valeur !== 'string') return null;
  const morceaux =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(
      valeur,
    );
  if (!morceaux) return null;
  const [, an, mois, jour, heure, minute, seconde, , decalageHeure, decalageMinute] = morceaux;
  const a = Number(an),
    m = Number(mois),
    j = Number(jour);
  const bissextile = a % 4 === 0 && (a % 100 !== 0 || a % 400 === 0);
  const jours = [31, bissextile ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    m < 1 ||
    m > 12 ||
    j < 1 ||
    j > jours[m - 1]! ||
    Number(heure) > 23 ||
    Number(minute) > 59 ||
    Number(seconde) > 59 ||
    Number(decalageHeure ?? 0) > 23 ||
    Number(decalageMinute ?? 0) > 59
  )
    return null;
  const instant = Date.parse(valeur);
  return Number.isFinite(instant) ? instant : null;
}

export interface LigneCommandant {
  id: number;
  proposer: string;
  type: string;
  params: Record<string, JsonCommandant>;
  card_id: number | null;
  head_sha: JsonCommandant;
  question: JsonCommandant;
  options: JsonCommandant;
  status: StatutCommandant;
  created_at: string;
  decided_at: string | null;
  executed_at: string | null;
  answer: string | null;
  result: string | null;
  summary: string[];
  why: string | null;
  digest: string;
  needs_sso: boolean;
  decided_by: string | null;
  decided_via: 'sso' | 'cockpit' | null;
  executed_by: string | null;
  result_detail: Record<string, JsonCommandant> | null;
}
export type RefusLigneCommandant =
  | 'forme'
  | 'digest'
  | 'summary'
  | 'why'
  | 'question'
  | 'options'
  | 'head_sha'
  | 'needs_sso'
  | 'statut'
  | 'date';
export type ControleCommandant =
  | {
      valide: true;
      ligne: LigneCommandant;
      repondable: boolean;
      dates: { creation: number; decision: number | null; execution: number | null };
    }
  | { valide: false; id: number | null; raison: RefusLigneCommandant };

export function questionRepondable(params: Record<string, unknown>): boolean {
  return (
    texteCommandantValide(params.question, 360) &&
    Array.isArray(params.options) &&
    params.options.length <= 6 &&
    params.options.every((o) => texteCommandantValide(o, 40))
  );
}

/** Ne rend aucun contenu d'une ligne refusée. Les trois copies sont reconstruites depuis params. */
export function controlerLigneCommandant(entree: unknown): ControleCommandant {
  const v = entree as Partial<LigneCommandant> | null;
  const id = Number.isSafeInteger(v?.id) && typeof v?.id === 'number' ? v.id : null;
  const refus = (raison: RefusLigneCommandant): ControleCommandant => ({
    valide: false,
    id,
    raison,
  });
  if (
    !v ||
    typeof v !== 'object' ||
    id === null ||
    typeof v.type !== 'string' ||
    !v.type ||
    !texteCommandantValide(v.type, 100) ||
    !v.params ||
    typeof v.params !== 'object' ||
    Array.isArray(v.params)
  )
    return refus('forme');
  try {
    if (
      !/^[a-f0-9]{64}$/.test(v.digest ?? '') ||
      digestCommandant({ id, type: v.type, params: v.params }) !== v.digest
    )
      return refus('digest');
  } catch {
    return refus('digest');
  }
  if (
    !Array.isArray(v.summary) ||
    v.summary.length < 1 ||
    v.summary.length > 12 ||
    !v.summary.every((s) => texteCommandantValide(s, 120))
  )
    return refus('summary');
  if (v.why !== null && !texteCommandantValide(v.why, 1000)) return refus('why');
  for (const cle of ['question', 'options', 'head_sha'] as const) {
    try {
      if (serialiserJcs(v[cle]) !== serialiserJcs(v.params[cle] ?? null)) return refus(cle);
    } catch {
      return refus(cle);
    }
  }
  const sso = v.type === 'decision' ? (v.params.needs_sso ?? false) : true;
  if (typeof sso !== 'boolean' || v.needs_sso !== sso) return refus('needs_sso');
  if (!STATUTS_COMMANDANT.includes(v.status as StatutCommandant)) return refus('statut');
  const creation = dateCommandant(v.created_at);
  const decision = v.decided_at === null ? null : dateCommandant(v.decided_at);
  const execution = v.executed_at === null ? null : dateCommandant(v.executed_at);
  if (
    creation === null ||
    (v.decided_at !== null && decision === null) ||
    (v.executed_at !== null && execution === null)
  )
    return refus('date');
  if (
    !texteCommandantValide(v.proposer, 100) ||
    v.proposer.length === 0 ||
    (v.card_id !== null && !Number.isSafeInteger(v.card_id)) ||
    !['sso', 'cockpit', null].includes(v.decided_via as string | null) ||
    (v.answer !== null && !texteCommandantValide(v.answer, 1000)) ||
    (v.result !== null && !texteCommandantValide(v.result, 4000)) ||
    (v.decided_by !== null && !texteCommandantValide(v.decided_by, 200)) ||
    (v.executed_by !== null && !texteCommandantValide(v.executed_by, 200)) ||
    (v.result_detail !== null &&
      (typeof v.result_detail !== 'object' || Array.isArray(v.result_detail)))
  )
    return refus('forme');
  const ligne = {
    ...v,
    question: v.params.question ?? null,
    options: v.params.options ?? null,
    head_sha: v.params.head_sha ?? null,
  } as LigneCommandant;
  return {
    valide: true,
    ligne,
    repondable:
      v.type === 'decision' &&
      v.status === 'pending' &&
      sso === false &&
      questionRepondable(v.params),
    dates: { creation, decision, execution },
  };
}

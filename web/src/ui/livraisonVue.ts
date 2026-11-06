import type { ActionRun } from '../../../src/shared/model.js';

// Chantier 27 : les règles de l'écran Livraison, sans rendu (D126, D127, D129 à D131).

/** Un commit dit court, comme partout dans l'écran. */
export const court = (sha: string): string => sha.slice(0, 7);

/** D124 : ce que `pr.rafraichir` relit de la PR, une fois validé. */
export interface PrLue {
  number: number | null;
  url: string | null;
  state: 'OPEN' | 'MERGED' | 'CLOSED' | null;
  headRefOid: string | null;
  baseRefName: string | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
  checks: unknown[];
  reviews: unknown[];
}

const texte = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const objet = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export function lirePr(result: Record<string, unknown> | null): PrLue | null {
  if (!result) return null;
  const state = texte(result.state);
  const mergeable = texte(result.mergeable);
  return {
    number: typeof result.number === 'number' ? result.number : null,
    url: texte(result.url),
    state: state === 'OPEN' || state === 'MERGED' || state === 'CLOSED' ? state : null,
    headRefOid: texte(result.headRefOid),
    baseRefName: texte(result.baseRefName),
    mergeable:
      mergeable === 'MERGEABLE' || mergeable === 'CONFLICTING' || mergeable === 'UNKNOWN'
        ? mergeable
        : null,
    checks: Array.isArray(result.statusCheckRollup) ? result.statusCheckRollup : [],
    reviews: Array.isArray(result.reviews) ? result.reviews : [],
  };
}

export type EtatControle = 'succes' | 'panne' | 'en-cours';

export interface Controle {
  nom: string;
  etat: EtatControle;
  /** La tête sur laquelle il a tourné ; null si inconnue. */
  tete: string | null;
  dureeS: number | null;
  url: string | null;
  local: boolean;
}

const duree = (debut: unknown, fin: unknown): number | null => {
  const a = Date.parse(String(debut ?? ''));
  const b = Date.parse(String(fin ?? ''));
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.round((b - a) / 1000) : null;
};

// CheckRun : status + conclusion ; StatusContext : state. NEUTRAL et SKIPPED ne sont pas des pannes.
function etatGitHub(c: Record<string, unknown>): EtatControle {
  const status = texte(c.status);
  if (status && status !== 'COMPLETED') return 'en-cours';
  const r = texte(c.conclusion) ?? texte(c.state);
  if (r === 'PENDING' || r === 'EXPECTED' || r === null) return 'en-cours';
  return r === 'SUCCESS' || r === 'NEUTRAL' || r === 'SKIPPED' ? 'succes' : 'panne';
}

/** D130 : les contrôles GitHub (tous sur la tête de la PR), puis le dernier test local. */
export function lireControles(pr: PrLue | null, test: ActionRun | null): Controle[] {
  const out: Controle[] = [];
  for (const brut of pr?.checks ?? []) {
    const c = objet(brut);
    if (!c) continue;
    const nom = texte(c.name) ?? texte(c.context);
    if (!nom) continue;
    out.push({
      nom,
      etat: etatGitHub(c),
      tete: pr?.headRefOid ?? null,
      dureeS: duree(c.startedAt, c.completedAt),
      url: texte(c.detailsUrl) ?? texte(c.targetUrl),
      local: false,
    });
  }
  if (test) {
    out.push({
      nom: 'npm test (local)',
      etat: test.state === 'running' ? 'en-cours' : test.state === 'succeeded' ? 'succes' : 'panne',
      tete: texte(test.result?.head),
      dureeS: duree(test.startedAt, test.finishedAt),
      url: null,
      local: true,
    });
  }
  return out;
}

/** Ne comptent que les contrôles portés par la tête de l'écran (D130). */
export function compterControles(controles: Controle[], tete: string | null) {
  const sur = controles.filter((c) => tete !== null && c.tete === tete);
  return {
    total: sur.length,
    passes: sur.filter((c) => c.etat === 'succes').length,
    pannes: sur.filter((c) => c.etat === 'panne').length,
    enCours: sur.filter((c) => c.etat === 'en-cours').length,
  };
}

/** D126 : d'où vient la revue, et sur quel commit elle dit porter. */
export interface SourceRevue {
  origine: 'page' | 'github';
  commit: string | null;
  auteur: string | null;
}

const COMMIT_CORPS = /^\s*commit\s*:\s*([0-9a-f]{7,40})\s*$/im;

/** La page `review` d'abord (`commit:` du frontmatter, ou en tête de corps), sinon la dernière revue GitHub. */
export function sourceRevue(
  page: { frontmatter: Record<string, unknown>; body: string; author?: string } | null,
  reviews: unknown[],
): SourceRevue | null {
  if (page) {
    const fm = page.frontmatter.commit;
    const commit =
      typeof fm === 'string' && fm.trim() !== ''
        ? fm.trim()
        : (COMMIT_CORPS.exec(page.body)?.[1] ?? null);
    return { origine: 'page', commit, auteur: page.author ?? null };
  }
  const derniere = reviews
    .map(objet)
    .filter((r): r is Record<string, unknown> => r !== null)
    .at(-1);
  if (!derniere) return null;
  return {
    origine: 'github',
    commit: texte(objet(derniere.commit)?.oid),
    auteur: texte(objet(derniere.author)?.login),
  };
}

/** D125 : la réponse de `git/livraison?revue=` pour le commit de la revue. */
export interface VerifRevue {
  connu: boolean;
  ancetre: boolean;
  retard: number;
}

export type Fraicheur =
  | { etat: 'aucune' }
  | { etat: 'sans-tete' }
  | { etat: 'a-jour'; commit: string }
  | { etat: 'obsolete'; commit: string; retard: number | null };

/** D126. `retard: null` : le commit n'est pas (ou plus) dans la branche. */
export function fraicheurRevue(source: SourceRevue | null, verif: VerifRevue | null): Fraicheur {
  if (!source) return { etat: 'aucune' };
  if (!source.commit) return { etat: 'sans-tete' };
  if (!verif || !verif.connu || !verif.ancetre)
    return { etat: 'obsolete', commit: source.commit, retard: null };
  return verif.retard === 0
    ? { etat: 'a-jour', commit: source.commit }
    : { etat: 'obsolete', commit: source.commit, retard: verif.retard };
}

export function libelleFraicheur(f: Fraicheur): { titre: string; note: string } {
  switch (f.etat) {
    case 'aucune':
      return { titre: 'Aucune revue', note: 'Rien ne bloque, mais ce sera cité' };
    case 'sans-tete':
      return {
        titre: 'Revue sans tête connue',
        note: 'La page ne dit pas quel commit elle a relu',
      };
    case 'a-jour':
      return { titre: 'À jour', note: `Porte sur ${court(f.commit)}` };
    case 'obsolete':
      return {
        titre: 'Obsolète',
        note:
          f.retard === null
            ? `Porte sur ${court(f.commit)}, absent de la branche`
            : `Porte sur ${court(f.commit)} · ${f.retard} commit${f.retard > 1 ? 's' : ''} de retard`,
      };
  }
}

/** D127 : la raison qui bloque le merge (une seule, la première), ou null. */
export function blocageMerge(p: {
  fusionne: boolean;
  aPr: boolean;
  pr: PrLue | null;
  teteLocale: string | null;
  fraicheur: Fraicheur;
}): string | null {
  if (p.fusionne || p.pr?.state === 'MERGED') return 'le sujet est déjà fusionné.';
  if (p.pr?.state === 'CLOSED') return 'la PR est fermée.';
  if (!p.aPr) return 'aucune PR ouverte.';
  if (!p.pr?.headRefOid) return 'la PR n’est pas encore relue.';
  if (p.teteLocale !== p.pr.headRefOid)
    return p.teteLocale
      ? `la tête locale ${court(p.teteLocale)} n’est pas sur la PR.`
      : 'la tête locale est inconnue.';
  if (p.fraicheur.etat === 'obsolete') return 'la revue ne porte pas sur cette tête.';
  if (p.pr.mergeable === 'CONFLICTING') return 'GitHub signale un conflit avec la base.';
  return null;
}

/** D127 : ce qui ne bloque pas mais est cité dans la confirmation. */
export function citations(f: Fraicheur, compte: ReturnType<typeof compterControles>): string[] {
  const out: string[] = [];
  if (f.etat === 'aucune') out.push('Aucune revue');
  if (f.etat === 'sans-tete') out.push('Revue sans tête connue');
  const pluriel = (n: number) => (n > 1 ? 's' : '');
  if (compte.pannes > 0) out.push(`${compte.pannes} contrôle${pluriel(compte.pannes)} en panne`);
  if (compte.enCours > 0) out.push(`${compte.enCours} contrôle${pluriel(compte.enCours)} en cours`);
  return out;
}

export interface Avis {
  texte: string | null;
  examine: string | null;
  nonExamine: string | null;
}

const AVIS_MAX = 300;

/** D131 : le premier paragraphe de la page, puis « Examiné : » et « Non examiné : » s'ils existent. */
export function lireAvis(body: string): Avis {
  const ligne = (re: RegExp) => re.exec(body)?.[1]?.trim() || null;
  const paragraphe = body
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .split('\n')
        .filter((l) => !/^\s*#/.test(l) && !COMMIT_CORPS.test(l))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .find((p) => p !== '' && !/^[-*]?\s*(Non examiné|Examiné)\s*:/i.test(p));
  return {
    texte:
      paragraphe === undefined
        ? null
        : paragraphe.length > AVIS_MAX
          ? `${paragraphe.slice(0, AVIS_MAX - 1).trimEnd()}…`
          : paragraphe,
    examine: ligne(/^\s*[-*]?\s*Examiné\s*:\s*(.+)$/im),
    nonExamine: ligne(/^\s*[-*]?\s*Non examiné\s*:\s*(.+)$/im),
  };
}

/** D129 : le message fixe envoyé à l'agent qui relit. */
export function messageRevue(p: { page: string; mergeBase: string; tete: string }): string {
  return [
    `Relis le diff ${court(p.mergeBase)}...${court(p.tete)} de ce sujet (git diff ${p.mergeBase}...${p.tete}).`,
    'Ne modifie aucun fichier et ne fais aucun commit.',
    `Écris ton avis dans la page mémoire ${p.page}, avec dans son frontmatter « commit: ${p.tete} ».`,
    'Commence par un paragraphe qui dit si on peut livrer, puis une ligne « Examiné : … » et une ligne « Non examiné : … ».',
  ].join('\n');
}

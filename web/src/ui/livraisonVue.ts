import { court, type Fraicheur } from '../../../src/shared/livraison.js';
export * from '../../../src/shared/livraison.js';

// Chantier 27 : les règles de l'écran Livraison, sans rendu (D126, D127, D129 à D131).

const COMMIT_CORPS = /^\s*commit\s*:\s*([0-9a-f]{7,40})\s*$/im;

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

export interface Avis {
  texte: string | null;
  examine: string | null;
  nonExamine: string | null;
}

const AVIS_MAX = 300;

/** D131 : le premier paragraphe de la page, puis « Examiné : » et « Non examiné : » s'ils existent. */
export function lireAvis(body: string): Avis {
  // la page se complète en append (D129) : seule la dernière section « ## Revue de … » compte
  const section = body.split(/^(?=##\s+Revue\b)/m).at(-1) ?? body;
  const ligne = (re: RegExp) => re.exec(section)?.[1]?.trim() || null;
  const paragraphe = section
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
    `Si la page existe déjà, complète-la (memory_put en mode append) : ton texte commence par ce frontmatter, puis par le titre « ## Revue de ${court(p.tete)} ».`,
    'Commence par un paragraphe qui dit si on peut livrer, puis une ligne « Examiné : … » et une ligne « Non examiné : … ».',
  ].join('\n');
}

const TAILLE_MAX_PAGE = 256 * 1024;
const CLES_INTERDITES = new Set(['__proto__', 'constructor', 'prototype']);

export interface AttenduRevue {
  fichiers: readonly string[];
  points: readonly string[];
  tete: string;
}

type Verdict = 'pass' | 'fail';

interface Finding {
  severite: string;
  categorie: string;
  emplacement: string;
  probleme: string;
  action: string;
  point?: string;
}

type ResultatRevue =
  | {
      ok: true;
      verdicts: { fichiers: Record<string, Verdict>; points: Record<string, Verdict> };
      findings: Finding[];
      categories: string[];
    }
  | { ok: false; raison: string };

function extraireBlocJson(texte: string): string | undefined {
  let cloture: string | undefined;
  let debutJson: number | undefined;
  let bloc: string | undefined;
  for (const ligne of texte.matchAll(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/gm)) {
    const [bordure, marque = '', suffixe = ''] = ligne;
    if (cloture) {
      if (!marque.startsWith(cloture) || suffixe.trim()) continue;
      if (debutJson !== undefined) {
        bloc = texte.slice(debutJson, ligne.index);
        debutJson = undefined;
      }
      cloture = undefined;
      continue;
    }
    if (marque.startsWith('`') && suffixe.includes('`')) continue;
    cloture = marque;
    if (marque.startsWith('`') && suffixe.trim() === 'json') {
      if (bloc !== undefined) return undefined;
      debutJson = ligne.index + bordure.length;
    }
  }
  return cloture === undefined ? bloc : undefined;
}

function estObjet(valeur: unknown): valeur is Record<string, unknown> {
  return typeof valeur === 'object' && valeur !== null && !Array.isArray(valeur);
}

function estTexte(valeur: unknown): valeur is string {
  return typeof valeur === 'string' && valeur.trim().length > 0;
}

function lireVerdicts(
  valeur: unknown,
  attendus: readonly string[],
): Record<string, Verdict> | undefined {
  const cles = new Set(attendus);
  if (!estObjet(valeur) || Object.keys(valeur).length !== cles.size) return undefined;
  const verdicts: Record<string, Verdict> = Object.create(null);
  for (const [cle, verdict] of Object.entries(valeur)) {
    if (!cles.has(cle) || (verdict !== 'pass' && verdict !== 'fail')) return undefined;
    verdicts[cle] = verdict;
  }
  return verdicts;
}

function lireFinding(valeur: unknown): Finding | undefined {
  if (!estObjet(valeur)) return undefined;
  const { severite, categorie, emplacement, probleme, action, point } = valeur;
  if (
    !estTexte(severite) ||
    !estTexte(categorie) ||
    !estTexte(emplacement) ||
    !/^[^\r\n]+:[1-9]\d*$/.test(emplacement) ||
    !estTexte(probleme) ||
    !estTexte(action) ||
    (point !== undefined && !estTexte(point))
  ) {
    return undefined;
  }
  const finding = { severite, categorie, emplacement, probleme, action };
  return point === undefined ? finding : { ...finding, point };
}

export function lireRevue(texte: string, attendu: AttenduRevue): ResultatRevue {
  if (texte.length > TAILLE_MAX_PAGE || Buffer.byteLength(texte) > TAILLE_MAX_PAGE) {
    return { ok: false, raison: 'Page de revue trop volumineuse' };
  }
  const bloc = extraireBlocJson(texte);
  if (bloc === undefined) return { ok: false, raison: 'Un seul bloc JSON de revue est attendu' };

  let donnees: unknown;
  try {
    donnees = JSON.parse(bloc, (cle, valeur: unknown) => {
      if (CLES_INTERDITES.has(cle)) throw new Error('Clé interdite');
      return valeur;
    });
  } catch {
    return { ok: false, raison: 'JSON de revue invalide' };
  }
  if (!estObjet(donnees) || donnees.tete !== attendu.tete || !/^[a-f0-9]{40}$/.test(attendu.tete)) {
    return { ok: false, raison: 'Tête de revue invalide ou différente de la tête attendue' };
  }
  if (!estObjet(donnees.verdicts) || !Array.isArray(donnees.findings)) {
    return { ok: false, raison: 'Verdicts ou findings manquants' };
  }
  const fichiers = lireVerdicts(donnees.verdicts.fichiers, attendu.fichiers);
  const points = lireVerdicts(donnees.verdicts.points, attendu.points);
  if (!fichiers || !points) {
    return {
      ok: false,
      raison: 'Les verdicts doivent couvrir exactement les fichiers et points attendus',
    };
  }

  const findings: Finding[] = [];
  const fichiersJustifies = new Set<string>();
  const pointsJustifies = new Set<string>();
  for (const valeur of donnees.findings) {
    const finding = lireFinding(valeur);
    if (!finding) return { ok: false, raison: 'Finding incomplet ou invalide' };
    findings.push(finding);
    fichiersJustifies.add(finding.emplacement.slice(0, finding.emplacement.lastIndexOf(':')));
    if (finding.point !== undefined) pointsJustifies.add(finding.point);
  }
  if (
    Object.entries(fichiers).some(
      ([fichier, verdict]) => verdict === 'fail' && !fichiersJustifies.has(fichier),
    ) ||
    Object.entries(points).some(
      ([point, verdict]) => verdict === 'fail' && !pointsJustifies.has(point),
    )
  ) {
    return { ok: false, raison: 'Chaque verdict fail doit être justifié par un finding' };
  }
  return {
    ok: true,
    verdicts: { fichiers, points },
    findings,
    categories: findings.map(({ categorie }) => categorie),
  };
}

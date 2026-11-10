/** Lignes de fin de spawning_pool.step_commit, Swairm-Drone facultatif. */
export interface TrailersSwairm {
  subject: string;
  step: string;
  planVersion: number;
  rung: string;
  attempt: number;
  proof: string;
  lines: number;
  files: number;
  drone: string | null;
}

const obligatoires = [
  'Swairm-Subject',
  'Swairm-Step',
  'Swairm-Plan-Version',
  'Swairm-Rung',
  'Swairm-Attempt',
  'Swairm-Proof',
  'Swairm-Lines',
  'Swairm-Files',
];

export function parseTrailers(message: string): TrailersSwairm | null {
  const sections = message
    .replaceAll('\r\n', '\n')
    .replace(/^\n+|\n+$/g, '')
    .split(/\n[ \t]*\n/);
  if (sections.length < 2) return null;
  const valeurs = new Map<string, string>();
  for (const ligne of sections.at(-1)!.split('\n')) {
    const match = /^([A-Za-z0-9][A-Za-z0-9-]*): ?(.*)$/.exec(ligne.trimEnd());
    if (!match) return null;
    const cle = match[1]!;
    const valeur = match[2]!;
    if (cle.startsWith('Swairm-')) {
      if (valeurs.has(cle)) return null;
      valeurs.set(cle, valeur);
    }
  }
  if (!obligatoires.every((cle) => valeurs.has(cle))) return null;
  const texte = (cle: string) => valeurs.get(`Swairm-${cle}`)!;
  const mot = (valeur: string) =>
    /^\S+$/.test(valeur) &&
    [...valeur].every((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127);
  if (!['Subject', 'Step', 'Rung'].every((cle) => mot(texte(cle)))) return null;
  const drone = valeurs.get('Swairm-Drone') ?? null;
  if (drone !== null && !mot(drone)) return null;
  const nombres = ['Plan-Version', 'Attempt', 'Lines', 'Files'].map((cle) => {
    const valeur = texte(cle).trim();
    return /^[+-]?\d(?:_?\d)*$/.test(valeur) ? Number(valeur.replaceAll('_', '')) : NaN;
  });
  if (!nombres.every(Number.isSafeInteger)) return null;
  const [planVersion, attempt, lines, files] = nombres as [number, number, number, number];
  if (planVersion < 1 || attempt < 1 || lines < 0 || files < 0) return null;
  const proof = texte('Proof');
  if (!['passed', 'failed', 'cannot_evaluate', 'not_applicable'].includes(proof)) return null;
  return {
    subject: texte('Subject'),
    step: texte('Step'),
    planVersion,
    rung: texte('Rung'),
    attempt,
    proof,
    lines,
    files,
    drone,
  };
}

export interface CommitSwairm {
  sha: string;
  date: string;
  step: string;
  proof: string;
  attempt: number;
  drone: string | null;
}
export interface LecturePrSwairm {
  pr: { number: number; state: string; url?: string } | null;
  commits: CommitSwairm[];
  etat: 'ok' | 'non-lu';
  raison?: string;
}

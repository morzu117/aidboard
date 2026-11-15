/** Chantier 24 : la vue board lit `swarph board … --json`, disponible depuis cette version. */
export const SWARPH_BOARD_MIN = '0.72.40';

/** Comparaison numérique sur trois nombres ; une version illisible ne déclenche rien de plus. */
export function swarphAtLeast(output: string, min = SWARPH_BOARD_MIN): boolean {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  const n = /(\d+)\.(\d+)\.(\d+)/.exec(min);
  if (!m || !n) return true;
  for (let i = 1; i <= 3; i++) {
    const a = Number(m[i]);
    const b = Number(n[i]);
    if (a !== b) return a > b;
  }
  return true;
}

/** Chantier 33 (D335) : swarph join. */
export const SWARPH_REJOINDRE_MIN = '0.80.0';

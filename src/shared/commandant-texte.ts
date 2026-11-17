export const unicodeValide = (texte: string): boolean =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(texte);

/* eslint-disable no-control-regex, no-misleading-character-class -- chaque caractère de ces plages est refusé */
const INTERDITS =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;
/* eslint-enable no-control-regex, no-misleading-character-class */
export const longueurCommandant = (texte: string): number => [...texte].length;
export const texteCommandantValide = (texte: unknown, maximum: number): texte is string =>
  typeof texte === 'string' &&
  unicodeValide(texte) &&
  longueurCommandant(texte) <= maximum &&
  !INTERDITS.test(texte);

export const AVERTISSEMENT_COMMANDANT =
  'Réponse du cockpit : elle ne vaut pas un go pour un réglage, une identité, un merge ou une release.';

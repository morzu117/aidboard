/** Les états protocolaires sont traduits ; leur explication libre reste intacte. */
const LIBELLES_BOARD: Record<string, string> = {
  'not-taken': 'non prise',
  withdrawn: 'retirée',
  requested: 'demandée',
  unstaffable: 'sans détenteur disponible',
  open: 'ouverte',
  closed: 'fermée',
  fallback_fired: 'recours déclenché',
  taken: 'prise',
  confirmed: 'confirmée',
  unconfirmed: 'non confirmée',
  fulfilled: 'remplie',
  active: 'active',
};
// Les noms d'étape (idea, pre-build, build, review, ready, done) restent tels quels :
// ce sont des identifiants du board, écrits ainsi dans la chronologie, le graphe et « Déplacer ».

export function libelleBoard(valeur: string | null): string {
  if (!valeur) return '—';
  const morceaux = /^(\S+)( \([\s\S]*\))?$/.exec(valeur);
  const etat = morceaux?.[1] ?? valeur;
  return Object.hasOwn(LIBELLES_BOARD, etat)
    ? `${LIBELLES_BOARD[etat]}${morceaux?.[2] ?? ''}`
    : valeur;
}

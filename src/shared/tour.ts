/** D139 : le résumé d'un tour à relire, la première ligne non vide du dernier message, 140 caractères au plus. */
export function resumeTour(message: string | null): string | null {
  const ligne = message
    ?.split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!ligne) return null;
  return ligne.length > 140 ? `${ligne.slice(0, 139)}…` : ligne;
}

// Ce filtre réduit les fuites de valeurs reconnaissables ; un secret écrit en clair
// dans une phrase peut passer. Il ne garantit donc pas l'absence de secrets.

const MASQUE = '[masqué]';

function estIpv6(valeur: string): boolean {
  const adresse = valeur.replace(/%.+$/, '');
  if (!adresse.includes(':')) return false;
  const morceaux = adresse.split('::');
  if (morceaux.length > 2) return false;
  const groupes = adresse.split(':').filter(Boolean);
  let taille = 0;
  for (const groupe of groupes) {
    if (/^[\da-f]{1,4}$/i.test(groupe)) taille++;
    else if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(groupe)) {
      if (groupe !== groupes.at(-1) || groupe.split('.').some((n) => Number(n) > 255)) return false;
      taille += 2;
    } else return false;
  }
  return morceaux.length === 2
    ? taille < 8
    : taille === 8 && !adresse.startsWith(':') && !adresse.endsWith(':');
}

export function filtrerTexte(s: string): string {
  return filtrerAvecLimite(s, 140);
}

function filtrerAvecLimite(s: string, limite: number): string {
  let texte = s
    .replace(/(?:https?:\/\/|wss?:\/\/|file:\/\/|ssh:\/\/|git@)[^\s<>"'`]+/gi, MASQUE)
    .replace(
      /(?<![\p{L}\p{N}_./\\-])(?:\$\{HOME\}\/|\$HOME\/|~[\w.-]*\/|[a-z]:\\|\/)[^\s<>"'`,;!?()[\]{}]+/giu,
      MASQUE,
    )
    .replace(/\b(?:[a-z\d-]+\.)+ts\.net\b/gi, MASQUE)
    .replace(/(?<![\w:])(?:[\da-f]*:){2,}[\da-f:.]*(?:%[\w.-]+)?(?![\w:])/gi, (valeur) => {
      const adresse = valeur.replace(/\.+$/, '');
      return estIpv6(adresse) ? MASQUE + valeur.slice(adresse.length) : valeur;
    })
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (valeur) =>
      valeur.split('.').every((n) => Number(n) <= 255) ? MASQUE : valeur,
    )
    .replace(
      /\b(?:sk_live_|sk_test_|rk_live_|sk-|gh[pos]_|github_pat_|xox[abpr]-|AKIA|eyJ|glpat-)[a-z\d_./+=-]*/gi,
      MASQUE,
    )
    .replace(/(?<![\w+/-])[a-z\d+/_-]{24,}={0,2}(?![\w+/-])/gi, (valeur) => {
      // Une suite hexadécimale reste reconnaissable, même sans chiffre (deadbeef…).
      if (/^[a-f\d]{24,}$/i.test(valeur)) return MASQUE;
      const chiffres = valeur.match(/\d/g)?.length ?? 0;
      const segments = valeur.split(/[/-]/);
      return chiffres >= 2 &&
        /[a-z]/i.test(valeur) &&
        segments.every((segment) => !/[a-z]/i.test(segment) || /\d/.test(segment))
        ? MASQUE
        : valeur;
    })
    // Les contrôles sont traités après les motifs pour ne pas joindre deux valeurs.
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/\[masqué\](?: *\[masqué\])+/g, MASQUE);

  if (texte.length <= limite) return texte;
  let fin = limite - 1;
  const debutMasque = texte.lastIndexOf(MASQUE, fin);
  if (debutMasque >= 0 && debutMasque + MASQUE.length > fin) fin = debutMasque;
  const espace = texte.lastIndexOf(' ', fin);
  if (espace > 0) fin = espace;
  texte = texte.slice(0, fin).trimEnd();
  return `${texte}…`;
}

/** La coupe se mesure après masquage, avant la limite de présentation. */
export function texteCoupe(s: string): boolean {
  return filtrerAvecLimite(s, Infinity).length > 140;
}

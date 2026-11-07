import { filtrerValeurs } from './filtre.js';

const MASQUE = '[masqué]';

/** Nom de base git uniquement ; « secretary » ne commence pas par « secrets ». */
export function fichierSensible(chemin: string): boolean {
  const nom = chemin.slice(chemin.lastIndexOf('/') + 1).toLowerCase();
  return (
    /^\.env/.test(nom) ||
    /\.(?:pem|key|p12|pfx|ppk|kdbx)$/.test(nom) ||
    (nom.startsWith('id_') && !nom.endsWith('.pub')) ||
    /^(?:\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.pgpass)$/.test(nom) ||
    /\.(?:tfvars|tfstate(?:\..*)?)$/.test(nom) ||
    /^(?:kubeconfig|credentials|secrets)/.test(nom)
  );
}

const NOM_SENSIBLE =
  /password|passwd|pwd|secret|token|auth|api[_-]?key|credential|private[_-]?key|dsn|conn(?:ection)?[_-]?string/i;

function masquerCles(texte: string): string {
  // Toute valeur non vide est masquée, même null, un booléen ou un petit nombre.
  // Les chaînes vides restent visibles ; guillemets et ponctuation restent en place.
  let resultat = '';
  let position = 0;
  // On ne consomme que la clé et le séparateur : une clé ordinaire ne peut
  // pas avaler les clés suivantes. La frontière évite de rescanner un identifiant.
  for (const cle of texte.matchAll(
    /(?:\[(["'])([\w-]+)\1\]|(?<![\w-])(["']?)([\w-]+)\3)(\s*(?::=|=>|:|=)\s*)/g,
  )) {
    if (cle.index < position || !NOM_SENSIBLE.test(cle[2] ?? cle[4] ?? '')) continue;
    const debut = cle.index + cle[0].length;
    let fin = debut;
    const guillemet = /["'`]/.test(texte[debut] ?? '') ? texte[debut] : '';
    if (guillemet) {
      fin++;
      while (fin < texte.length && texte[fin] !== guillemet) {
        fin += texte[fin] === '\\' ? 2 : 1;
      }
      fin = Math.min(fin, texte.length);
      if (fin === debut + 1) continue;
    } else {
      while (fin < texte.length && !/[,;})"'`\r\n]/.test(texte[fin] ?? '')) fin++;
      while (fin > debut && /\s/.test(texte[fin - 1] ?? '')) fin--;
      if (fin === debut) continue;
    }
    resultat += texte.slice(position, debut) + guillemet + MASQUE;
    position = fin;
  }
  return resultat + texte.slice(position);
}

/** Filtre un diff entier : l'état PEM est local à cet appel. */
export function filtrerDiff(lignes: string[]): string[] {
  let bloc: string | undefined;
  function contenu(texte: string): string {
    let masquer = bloc !== undefined;
    for (const balise of texte.matchAll(/-----(BEGIN|END) ([A-Z0-9 ]+)-----/g)) {
      if (balise[1] === 'BEGIN' && bloc === undefined) {
        bloc = balise[2];
        masquer = true;
      } else if (balise[1] === 'END' && balise[2] === bloc) {
        bloc = undefined;
      }
    }
    return masquer
      ? MASQUE
      : filtrerValeurs(
          masquerCles(texte).replace(
            /\b(Bearer|Basic|Token|Digest)( +)(?![:=])[^\s"'`]+/gi,
            `$1$2${MASQUE}`,
          ),
        );
  }
  return lignes.map((ligne) => {
    const entete = ligne.match(/^(@@ .*? @@)(.*)$/);
    if (entete) return entete[1] + contenu(entete[2] ?? '');
    if (/^(?:diff --git |index |--- |\+\+\+ )/.test(ligne)) return ligne;
    if (/^[ +-]/.test(ligne)) return ligne[0] + contenu(ligne.slice(1));
    return contenu(ligne);
  });
}

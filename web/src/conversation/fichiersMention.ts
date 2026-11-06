import type { FileNode, FilesResponse } from '../../../src/shared/files.js';

/** Chantier 26 (D118) : les chemins de fichiers du worktree, et si l'arbre lu était tronqué. */
export interface FichiersMention {
  chemins: string[];
  tronque: boolean;
}

/** Au plus autant de lignes dans le menu : au-delà, on affine la saisie. */
export const FICHIERS_MAX = 50;

/** L'arbre de `GET /api/topics/:id/files?scope=tout`, aplati : les fichiers seuls, dans l'ordre de l'arbre. */
export function aplatir(r: FilesResponse): FichiersMention {
  const chemins: string[] = [];
  const parcourir = (nodes: FileNode[]) => {
    for (const n of nodes) {
      if (n.kind === 'file') chemins.push(n.path);
      else parcourir(n.entries ?? []);
    }
  };
  parcourir(r.tree);
  return { chemins, tronque: r.truncated };
}

/** La mention en cours : le dernier mot du champ, s'il commence par `@`. Sinon null. */
export function saisieMention(text: string): string | null {
  const m = /(?:^|\s)@(\S*)$/.exec(text);
  return m ? m[1]! : null;
}

/** Par nom de fichier d'abord (préfixe), puis par sous-chaîne du chemin ; l'ordre de l'arbre est gardé dans chaque groupe. */
export function filtrerFichiers(chemins: string[], requete: string): string[] {
  const q = requete.toLowerCase();
  const nom = (p: string) => p.slice(p.lastIndexOf('/') + 1).toLowerCase();
  const prefixe = chemins.filter((p) => nom(p).startsWith(q));
  const dedans = chemins.filter((p) => !nom(p).startsWith(q) && p.toLowerCase().includes(q));
  return [...prefixe, ...dedans].slice(0, FICHIERS_MAX);
}

/** Le texte une fois le fichier choisi : `@requete` devient `@chemin`, suivi d'une espace. */
export function insererMention(text: string, chemin: string): string {
  // une fonction, pas une chaîne : un `$` dans le chemin ne doit pas être lu comme un motif
  return text.replace(/@\S*$/, () => `@${chemin} `);
}

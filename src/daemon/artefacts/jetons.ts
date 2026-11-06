import { createHash, randomBytes } from 'node:crypto';

// Chantier 30 (D163) : un lien d'artefact désigne un contenu lu à l'émission, pas un fichier.
// Le jeton est limité dans le temps, pas à un seul usage : il sert autant de fois qu'on veut
// pendant 10 minutes, et se perd au redémarrage du daemon (rien n'est écrit sur disque).

export type TypeArtefact = 'html' | 'svg';

export interface ContenuArtefact {
  contenu: Buffer;
  type: TypeArtefact;
  /** sha256 hexadécimal du contenu servi */
  empreinte: string;
  /** epoch en millisecondes */
  expireA: number;
}

export const DUREE_JETON_MS = 10 * 60_000;
export const PLAFOND_JETONS = 200;

export class JetonsArtefacts {
  private readonly vivants = new Map<string, ContenuArtefact>();

  constructor(
    private readonly maintenant: () => number = Date.now,
    private readonly plafond = PLAFOND_JETONS,
  ) {}

  emettre(contenu: Buffer, type: TypeArtefact): { jeton: string; expireA: number } {
    this.purger();
    // une Map garde l'ordre d'insertion : la première clé est le jeton le plus ancien
    while (this.vivants.size >= this.plafond) {
      const plusAncien = this.vivants.keys().next().value;
      if (plusAncien === undefined) break;
      this.vivants.delete(plusAncien);
    }
    const jeton = randomBytes(32).toString('base64url');
    const expireA = this.maintenant() + DUREE_JETON_MS;
    const empreinte = createHash('sha256').update(contenu).digest('hex');
    this.vivants.set(jeton, { contenu, type, empreinte, expireA });
    return { jeton, expireA };
  }

  lire(jeton: string): ContenuArtefact | null {
    const c = this.vivants.get(jeton);
    if (!c) return null;
    if (c.expireA <= this.maintenant()) {
      this.vivants.delete(jeton);
      return null;
    }
    return c;
  }

  get taille(): number {
    return this.vivants.size;
  }

  private purger(): void {
    const t = this.maintenant();
    for (const [jeton, c] of this.vivants) if (c.expireA <= t) this.vivants.delete(jeton);
  }
}

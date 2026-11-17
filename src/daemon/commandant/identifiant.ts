import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { nomMeshValide } from '../config.js';

export type EtatIdentifiantCockpit =
  'absent' | 'valide' | 'expire' | 'revoque' | 'inconnu' | 'refuse';
export const identifiantCockpitValide = (valeur: unknown): valeur is string =>
  typeof valeur === 'string' && /^swck_[A-Za-z0-9_-]{43}$/.test(valeur);

/** Aucune erreur de système de fichiers ne traverse la frontière HTTP avec son contenu. */
export class IdentifiantsCockpit {
  constructor(private readonly home: string) {}
  private dossier(): string {
    return join(this.home, 'cockpit');
  }
  private chemin(mesh: string): string {
    if (!nomMeshValide(mesh)) throw new Error('Nom de mesh invalide');
    return join(this.dossier(), `${mesh}.token`);
  }
  private preparer(): void {
    mkdirSync(this.dossier(), { recursive: true, mode: 0o700 });
    if (!lstatSync(this.dossier()).isDirectory() || lstatSync(this.dossier()).isSymbolicLink())
      throw new Error('Dossier cockpit invalide');
    chmodSync(this.dossier(), 0o700);
  }
  lire(mesh: string): { valeur: string; saisie: string } | null {
    const chemin = this.chemin(mesh);
    let fd: number | undefined;
    try {
      const dossier = lstatSync(this.dossier());
      if (!dossier.isDirectory() || dossier.isSymbolicLink())
        throw new Error('Dossier cockpit invalide');
      fd = openSync(chemin, constants.O_RDONLY | constants.O_NOFOLLOW);
      const etat = fstatSync(fd);
      if (
        !etat.isFile() ||
        etat.size !== 48 ||
        (etat.mode & 0o777) !== 0o600 ||
        (dossier.mode & 0o777) !== 0o700
      )
        throw new Error('Fichier cockpit invalide');
      const valeur = readFileSync(fd, 'utf8');
      if (!identifiantCockpitValide(valeur)) throw new Error('Identifiant cockpit invalide');
      return { valeur, saisie: etat.mtime.toISOString() };
    } catch (erreur) {
      if ((erreur as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('Lecture de l’identifiant cockpit impossible');
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  ecrire(mesh: string, valeur: unknown): void {
    const chemin = this.chemin(mesh);
    if (!identifiantCockpitValide(valeur))
      throw new Error('Format de l’identifiant cockpit invalide');
    let temporaire: string | undefined;
    let fd: number | undefined;
    try {
      this.preparer();
      temporaire = join(this.dossier(), `.cockpit-${randomUUID()}.tmp`);
      fd = openSync(temporaire, 'wx', 0o600);
      fchmodSync(fd, 0o600);
      writeFileSync(fd, valeur, 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporaire, chemin);
      temporaire = undefined;
    } catch {
      throw new Error('Écriture de l’identifiant cockpit impossible');
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (temporaire) {
        try {
          unlinkSync(temporaire);
        } catch {
          /* nettoyage sans contenu */
        }
      }
    }
  }
  supprimer(mesh: string): void {
    const chemin = this.chemin(mesh);
    try {
      if (lstatSync(this.dossier()).isSymbolicLink()) throw new Error('Dossier cockpit invalide');
      unlinkSync(chemin);
    } catch (erreur) {
      if ((erreur as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('Suppression de l’identifiant cockpit impossible');
    }
  }
}

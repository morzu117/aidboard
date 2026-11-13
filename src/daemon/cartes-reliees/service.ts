import type { BoardCard, BoardResult } from '../../shared/board.js';
import { empreinteMesh } from '../../shared/meshes.js';
import type { MeshRegistry } from '../mesh/registre.js';
import { AidHttpError } from '../errors.js';
import { DepotCartesReliees, type Groupe, type Membre, type MembreLu } from './depot.js';

export interface CibleCarte {
  mesh: string;
  carte: number;
}
type Statut = 'ok' | 'mesh_change' | 'carte_remplacee' | 'lecture_impossible';
interface MembreAffiche {
  id: number;
  mesh: string;
  carte: number;
  statut: Statut;
  titre?: string | null;
  etape?: string | null;
  responsable?: string | null;
  obligations?: number;
  echeance?: string | null;
  maj?: string | null;
}
interface EntreeCache {
  expire: number;
  resultat: Promise<BoardResult<BoardCard>>;
}

export class CartesReliees {
  private readonly cache = new Map<string, EntreeCache>();
  private lectures = 0;
  private readonly attente: (() => void)[] = [];

  constructor(
    readonly depot: DepotCartesReliees,
    private readonly meshes?: MeshRegistry,
    private readonly maintenant: () => number = Date.now,
  ) {}

  private identite(mesh: string): string | null {
    if (!this.meshes?.liste().some((m) => m.nom === mesh && m.actif)) return null;
    const config = this.meshes.configuration(mesh);
    return empreinteMesh(config.cell, config.gateway);
  }

  private async limiter<T>(lire: () => Promise<T>): Promise<T> {
    if (this.lectures >= 4) await new Promise<void>((resolve) => this.attente.push(resolve));
    else this.lectures++;
    try {
      return await lire();
    } finally {
      const suivant = this.attente.shift();
      if (suivant) suivant();
      else this.lectures--;
    }
  }

  private lire(cible: CibleCarte, empreinte: string, frais = false) {
    const cle = JSON.stringify([cible.mesh, empreinte, cible.carte]);
    const date = this.maintenant();
    for (const [k, entree] of this.cache) if (entree.expire <= date) this.cache.delete(k);
    const connu = this.cache.get(cle);
    if (!frais && connu) return connu.resultat;
    const entree: EntreeCache = {
      expire: Infinity,
      resultat: this.limiter(async (): Promise<BoardResult<BoardCard>> => {
        try {
          return await this.meshes!.obtenir(cible.mesh).board.carte(cible.carte, {
            fresh: true,
            ...(frais ? { sansCache: true } : {}),
          });
        } catch {
          return { ok: false, kind: 'unknown', readAt: new Date().toISOString() };
        }
      }),
    };
    void entree.resultat.then(() => {
      entree.expire = this.maintenant() + 60_000;
    });
    if (!frais) this.cache.set(cle, entree);
    return entree.resultat;
  }

  async preparer(cible: CibleCarte): Promise<MembreLu> {
    const empreinte = this.identite(cible.mesh);
    if (!empreinte) throw new AidHttpError(400, 'mesh inactif');
    const resultat = await this.lire(cible, empreinte, true);
    if (this.identite(cible.mesh) !== empreinte) throw new AidHttpError(400, 'mesh inactif');
    if (!resultat.ok) {
      if (resultat.kind === 'not-found') throw new AidHttpError(404, 'carte introuvable');
      throw new AidHttpError(503, 'lecture impossible');
    }
    if (!resultat.data.threadUuid) throw new AidHttpError(409, 'carte sans thread_uuid');
    return {
      ...cible,
      empreinte,
      thread_uuid: resultat.data.threadUuid,
      carte_creee_a: resultat.data.createdAt,
    };
  }

  async creer(cibles: CibleCarte[], note: string | null): Promise<number> {
    const membres = await Promise.all(cibles.map((c) => this.preparer(c)));
    this.verifierIdentites(membres);
    return this.depot.creer(membres, note);
  }

  async ajouter(id: number, cible: CibleCarte): Promise<void> {
    this.depot.obtenir(id);
    const membre = await this.preparer(cible);
    this.verifierIdentites([membre]);
    this.depot.ajouter(id, membre);
  }

  private verifierIdentites(membres: MembreLu[]) {
    if (membres.some((m) => this.identite(m.mesh) !== m.empreinte))
      throw new AidHttpError(400, 'mesh inactif');
  }

  private async afficher(membre: Membre): Promise<MembreAffiche> {
    const base = { id: membre.id, mesh: membre.mesh, carte: membre.carte };
    if (this.identite(membre.mesh) !== membre.empreinte) return { ...base, statut: 'mesh_change' };
    const resultat = await this.lire(membre, membre.empreinte);
    if (this.identite(membre.mesh) !== membre.empreinte) return { ...base, statut: 'mesh_change' };
    if (!resultat.ok)
      return {
        ...base,
        statut: resultat.kind === 'not-found' ? 'carte_remplacee' : 'lecture_impossible',
      };
    const carte = resultat.data;
    if (carte.threadUuid !== membre.thread_uuid || carte.createdAt !== membre.carte_creee_a)
      return { ...base, statut: 'carte_remplacee' };
    return {
      ...base,
      statut: 'ok',
      titre: carte.title,
      etape: carte.stage,
      responsable: carte.assignee,
      obligations: carte.openObligations,
      echeance: carte.dueAt,
      maj: carte.updatedAt,
    };
  }

  async liste(cible?: CibleCarte) {
    const groupes = this.depot
      .liste()
      .filter(
        (g) =>
          !cible ||
          g.membres.some(
            (m) =>
              m.mesh === cible.mesh &&
              m.carte === cible.carte &&
              m.empreinte === this.identite(cible.mesh),
          ),
      );
    const resultat = await this.afficherGroupes(groupes);
    return cible ? (resultat[0] ?? null) : resultat;
  }

  async page(limite: number, apres: number) {
    const page = this.depot.page(limite, apres);
    return { groupes: await this.afficherGroupes(page.groupes), suivant: page.suivant };
  }

  private afficherGroupes(groupes: Groupe[]) {
    return Promise.all(
      groupes.map(async (groupe) => {
        const membres = await Promise.all(groupe.membres.map((m) => this.afficher(m)));
        const etapes = new Set(membres.filter((m) => m.statut === 'ok').map((m) => m.etape));
        return {
          id: groupe.id,
          note: groupe.note,
          cree_a: groupe.cree_a,
          membres,
          ecart: etapes.size > 1,
        };
      }),
    );
  }
}

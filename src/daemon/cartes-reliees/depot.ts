import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';

export interface MembreLu {
  mesh: string;
  empreinte: string;
  carte: number;
  thread_uuid: string;
  carte_creee_a: string | null;
}
export interface Membre extends MembreLu {
  id: number;
  groupe: number;
  ajoute_a: string;
}
export interface Groupe {
  id: number;
  note: string | null;
  cree_a: string;
  membres: Membre[];
}

/** Les écritures sont synchrones et transactionnelles, après les lectures du mesh. */
export class DepotCartesReliees {
  constructor(private readonly db: Db) {}

  page(limite: number, apres: number): { groupes: Groupe[]; suivant: number | null } {
    const lignes = this.db
      .prepare('SELECT * FROM groupes_cartes WHERE id > ? ORDER BY id LIMIT ?')
      .all(apres, limite + 1) as Omit<Groupe, 'membres'>[];
    const selection = lignes.slice(0, limite);
    const lireMembres = this.db.prepare(
      'SELECT * FROM membres_groupe WHERE groupe = ? ORDER BY id',
    );
    return {
      groupes: selection.map((g) => ({ ...g, membres: lireMembres.all(g.id) as Membre[] })),
      suivant: lignes.length > limite ? selection[selection.length - 1]!.id : null,
    };
  }

  liste(): Groupe[] {
    const groupes = this.db.prepare('SELECT * FROM groupes_cartes ORDER BY id').all() as Omit<
      Groupe,
      'membres'
    >[];
    const membres = this.db.prepare('SELECT * FROM membres_groupe ORDER BY id').all() as Membre[];
    return groupes.map((g) => ({ ...g, membres: membres.filter((m) => m.groupe === g.id) }));
  }

  obtenir(id: number): Groupe {
    const groupe = this.liste().find((g) => g.id === id);
    if (!groupe) throw new AidHttpError(404, 'groupe introuvable');
    return groupe;
  }

  creer(membres: MembreLu[], note: string | null): number {
    return this.db.transaction(() => {
      const { nombre } = this.db.prepare('SELECT count(*) AS nombre FROM groupes_cartes').get() as {
        nombre: number;
      };
      if (nombre >= 500) throw new AidHttpError(409, 'limite de 500 groupes');
      const id = Number(
        this.db
          .prepare('INSERT INTO groupes_cartes (note, cree_a) VALUES (?, ?)')
          .run(note, new Date().toISOString()).lastInsertRowid,
      );
      for (const membre of membres) this.inserer(id, membre);
      return id;
    })();
  }

  ajouter(id: number, membre: MembreLu): void {
    this.db.transaction(() => {
      this.obtenir(id);
      this.inserer(id, membre);
    })();
  }

  retirer(id: number, membre: number): void {
    this.db.transaction(() => {
      const groupe = this.obtenir(id);
      if (!groupe.membres.some((m) => m.id === membre))
        throw new AidHttpError(404, 'membre introuvable');
      this.db.prepare('DELETE FROM membres_groupe WHERE id = ? AND groupe = ?').run(membre, id);
      if (groupe.membres.length <= 2) {
        this.db.prepare('DELETE FROM membres_groupe WHERE groupe = ?').run(id);
        this.db.prepare('DELETE FROM groupes_cartes WHERE id = ?').run(id);
      }
    })();
  }

  noter(id: number, note: string | null): void {
    this.obtenir(id);
    this.db.prepare('UPDATE groupes_cartes SET note = ? WHERE id = ?').run(note, id);
  }

  private inserer(groupe: number, membre: MembreLu): void {
    if (
      this.db
        .prepare('SELECT id FROM membres_groupe WHERE mesh = ? AND empreinte = ? AND carte = ?')
        .get(membre.mesh, membre.empreinte, membre.carte)
    )
      throw new AidHttpError(409, 'carte déjà dans un groupe');
    if (
      this.db
        .prepare('SELECT id FROM membres_groupe WHERE groupe = ? AND mesh = ?')
        .get(groupe, membre.mesh)
    )
      throw new AidHttpError(409, 'mesh déjà présent dans le groupe');
    this.db
      .prepare(
        `INSERT INTO membres_groupe
         (groupe, mesh, empreinte, carte, thread_uuid, carte_creee_a, ajoute_a)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        groupe,
        membre.mesh,
        membre.empreinte,
        membre.carte,
        membre.thread_uuid,
        membre.carte_creee_a,
        new Date().toISOString(),
      );
  }
}

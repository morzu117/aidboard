import type { Db } from '../db.js';

/** D312 : une étiquette ne peut pas être réutilisée silencieusement pour une autre identité. */
export function activerMesh(
  db: Db,
  nom: string,
  empreinte: string,
): 'nouveau' | 'connu' | 'rebranche' {
  return db.transaction(() => {
    const connu = db.prepare('SELECT empreinte FROM meshes_connus WHERE nom = ?').get(nom) as
      { empreinte: string } | undefined;
    if (connu && connu.empreinte !== empreinte) return 'rebranche';
    const maintenant = new Date().toISOString();
    if (connu) {
      db.prepare('UPDATE meshes_connus SET vu_a = ? WHERE nom = ?').run(maintenant, nom);
      return 'connu';
    }
    db.prepare('INSERT INTO meshes_connus (nom, empreinte, vu_a) VALUES (?, ?, ?)').run(
      nom,
      empreinte,
      maintenant,
    );
    return 'nouveau';
  })();
}

/** L'archivage et la libération du nom sont atomiques ; aucune activation au démarrage en 46.1. */
export function archiverMesh(db: Db, nom: string, date: string): void {
  db.transaction(() => {
    const archive = `${nom}@archive-${date}`;
    for (const table of [
      'mesh_inbox',
      'mesh_state',
      'aid_etats',
      'aid_propositions',
      'swairm_propositions',
      'avis_mesh',
    ])
      db.prepare(`UPDATE ${table} SET mesh = ? WHERE mesh = ?`).run(archive, nom);
    db.prepare('DELETE FROM meshes_connus WHERE nom = ?').run(nom);
  })();
}

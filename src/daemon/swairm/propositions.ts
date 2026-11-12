import type { Db } from '../db.js';
import type { lireBoardSwairm } from './board.js';

export interface PropositionSwairm {
  id: number;
  mesh: string;
  projet: string;
  sujet: string;
  etat: string;
  titre: string;
  carte: number;
}

/** D288 : transaction locale uniquement ; aucun accès à la porte ni au mesh. */
export function releverEtatsSwairm(db: Db, lecture: Awaited<ReturnType<typeof lireBoardSwairm>>) {
  if (!lecture.board.ok || lecture.swairm.etat !== 'ok') return;
  db.transaction(() => {
    const maintenant = new Date().toISOString();
    for (const s of lecture.sujets) {
      if (s.carte === null || s.conflit.length > 0) {
        // Un lien rétabli commence un nouveau relevé, sans réveiller une transition passée.
        db.prepare('DELETE FROM swairm_etats WHERE projet = ? AND sujet = ?').run(s.projet, s.id);
        continue;
      }
      const connu = db
        .prepare('SELECT etat FROM swairm_etats WHERE projet = ? AND sujet = ?')
        .get(s.projet, s.id) as { etat: string } | undefined;
      if (
        connu &&
        connu.etat !== s.etat &&
        ['plan_validated', 'merged', 'abandoned'].includes(s.etat)
      )
        db.prepare(
          `INSERT OR IGNORE INTO swairm_propositions
           (mesh, projet, sujet, etat, titre, carte, cree_a) VALUES ('principal', ?, ?, ?, ?, ?, ?)`,
        ).run(s.projet, s.id, s.etat, s.titre, s.carte, maintenant);
      db.prepare(
        `INSERT INTO swairm_etats (projet, sujet, etat, vu_a) VALUES (?, ?, ?, ?)
         ON CONFLICT(projet, sujet) DO UPDATE SET etat = excluded.etat, vu_a = excluded.vu_a`,
      ).run(s.projet, s.id, s.etat, maintenant);
    }
  })();
}

export function propositionsSwairm(db: Db): PropositionSwairm[] {
  // Le succès est persistant : fermer aussi après une navigation ou un redémarrage.
  db.prepare(
    `UPDATE swairm_propositions SET fermee_a = ? WHERE mesh = 'principal' AND fermee_a IS NULL
     AND confirmation IN (SELECT id FROM pda_demandes
       WHERE action = 'mesh.ecrire' AND resultat = 'executee'
       AND json_extract(envoi, '$.code') = 'succes')`,
  ).run(new Date().toISOString());
  return db
    .prepare(
      `SELECT mesh, id, projet, sujet, etat, titre, carte FROM swairm_propositions
       WHERE mesh = 'principal' AND fermee_a IS NULL ORDER BY id`,
    )
    .all() as PropositionSwairm[];
}

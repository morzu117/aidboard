import type { Db } from '../db.js';
import type { lireBoardAid } from './board.js';
import { raisonDeplacement } from '../../shared/deplacements.js';
import { ETAPES_DEPLACEMENT } from '../../shared/etats.js';

export interface PropositionAid {
  id: number;
  sujet: string;
  carte: number;
  etape: 'review' | 'ready';
}

/** Un nouveau lecteur amorce son relevé sans rejouer les transitions durant l'arrêt. */
export function creerReleveAid(db: Db, cell: string) {
  let amorce = false;
  return (lecture: Awaited<ReturnType<typeof lireBoardAid>>) => {
    if (!lecture.board.ok || lecture.erreurs.length) return;
    db.transaction(() => {
      if (!amorce) db.prepare('DELETE FROM aid_etats').run();
      const presents = new Set<string>();
      for (const s of lecture.sujets) {
        const carte = lecture.cartes.find((c) => c.id === s.carte);
        if (!cell || !carte || s.conflit.length || raisonDeplacement(carte, cell)) {
          db.prepare('DELETE FROM aid_etats WHERE sujet = ?').run(s.sujetId);
          continue;
        }
        presents.add(s.sujetId);
        const avant = db.prepare('SELECT * FROM aid_etats WHERE sujet = ?').get(s.sujetId) as
          { carte: number; phase: string | null; etat: string; pr: number | null } | undefined;
        const etape =
          avant && avant.carte === carte.id
            ? s.state === 'merged' && avant.etat !== 'merged'
              ? 'ready'
              : (s.phase === 'review' && avant.phase !== 'review') ||
                  (avant.pr === null && s.prNumber !== null)
                ? 'review'
                : null
            : null;
        if (
          etape &&
          ETAPES_DEPLACEMENT.indexOf(etape) >
            ETAPES_DEPLACEMENT.indexOf(carte.stage as (typeof ETAPES_DEPLACEMENT)[number])
        )
          db.prepare(
            `INSERT OR IGNORE INTO aid_propositions (sujet, carte, etape, cree_a) VALUES (?, ?, ?, ?)`,
          ).run(s.sujetId, carte.id, etape, new Date().toISOString());
        db.prepare(
          `INSERT INTO aid_etats (sujet, carte, phase, etat, pr) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(sujet) DO UPDATE SET carte=excluded.carte, phase=excluded.phase, etat=excluded.etat, pr=excluded.pr`,
        ).run(s.sujetId, carte.id, s.phase, s.state, s.prNumber);
      }
      for (const s of db.prepare('SELECT sujet FROM aid_etats').all() as { sujet: string }[])
        if (!presents.has(s.sujet))
          db.prepare('DELETE FROM aid_etats WHERE sujet = ?').run(s.sujet);
    })();
    amorce = true;
  };
}

export function propositionsAid(db: Db): PropositionAid[] {
  db.prepare(
    `UPDATE aid_propositions SET fermee_a = ? WHERE fermee_a IS NULL
    AND confirmation IN (SELECT id FROM pda_demandes WHERE action = 'mesh.etat'
    AND resultat = 'executee' AND json_extract(envoi, '$.code') = 'succes')`,
  ).run(new Date().toISOString());
  return db
    .prepare(
      'SELECT id, sujet, carte, etape FROM aid_propositions WHERE fermee_a IS NULL ORDER BY id',
    )
    .all() as PropositionAid[];
}

import type { Db } from '../db.js';

const TOUJOURS = new Set(['appairage', 'pda.activer', 'host.option', 'reglage', 'desarmement']);
interface LigneReglage {
  action: string;
  actif: number;
  modifie_a: number | null;
}
interface LigneArmement {
  arme: number;
  arme_a: number | null;
  desarme_a: number | null;
}

export function creerReglage(db: Db) {
  const modifier = (action: string, actif: number) => {
    const resultat = db
      .prepare('UPDATE confirmations_reglage SET actif = ?, modifie_a = ? WHERE action = ?')
      .run(actif, Date.now(), action);
    if (resultat.changes !== 1) throw new Error('action inconnue');
  };
  return {
    lire() {
      const lignes = db
        .prepare('SELECT action, actif, modifie_a FROM confirmations_reglage ORDER BY rowid')
        .all() as LigneReglage[];
      return lignes.map((l) => ({ action: l.action, actif: l.actif === 1, modifieA: l.modifie_a }));
    },
    exige(action: string) {
      if (action === 'essai' || TOUJOURS.has(action)) return true;
      const ligne = db
        .prepare('SELECT actif FROM confirmations_reglage WHERE action = ?')
        .get(action) as { actif: number } | undefined;
      return ligne?.actif === 1;
    },
    rallumer(action: string) {
      modifier(action, 1);
    },
    // Réservé à l'exécution d'une demande reglage confirmée par la porte.
    couperConfirme(action: string) {
      modifier(action, 0);
    },
    arme() {
      const ligne = db
        .prepare('SELECT arme FROM confirmations_armement WHERE id = 1')
        .get() as LigneArmement;
      return ligne.arme === 1;
    },
    lireArmement() {
      const ligne = db
        .prepare('SELECT * FROM confirmations_armement WHERE id = 1')
        .get() as LigneArmement;
      return { arme: ligne.arme === 1, armeA: ligne.arme_a, desarmeA: ligne.desarme_a };
    },
    armer() {
      db.prepare(
        'UPDATE confirmations_armement SET arme = 1, arme_a = ? WHERE id = 1 AND arme = 0',
      ).run(Date.now());
    },
    // Réservé à la porte de désarmement.
    desarmerConfirme() {
      db.prepare(
        'UPDATE confirmations_armement SET arme = 0, desarme_a = ? WHERE id = 1 AND arme = 1',
      ).run(Date.now());
    },
  };
}

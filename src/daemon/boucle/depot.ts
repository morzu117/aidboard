import type { Db } from '../db.js';
import { transition, type ActionBoucle, type EtatBoucle, type Tentative } from './etat.js';

interface Boucle {
  id: string;
  sujetId: string;
  etat: EtatBoucle;
}

type DonneesEtat = Omit<EtatBoucle, 'phase' | 'tete' | 'etapes'>;
type DonneesEtape = Omit<Tentative, 'type' | 'tentative'>;

interface LigneBoucle {
  id: string;
  sujet_id: string;
  phase: EtatBoucle['phase'];
  tete: string;
  donnees: string;
}

interface LigneEtape {
  type: Tentative['type'];
  tentative: number;
  donnees: string;
}

function enregistrerEtapes(db: Db, id: string, etapes: Tentative[]): void {
  db.prepare('DELETE FROM boucle_etapes WHERE boucle_id = ?').run(id);
  const inserer = db.prepare(
    'INSERT INTO boucle_etapes (boucle_id, position, type, tentative, donnees) VALUES (?, ?, ?, ?, ?)',
  );
  for (const [position, { type, tentative, ...donnees }] of etapes.entries()) {
    inserer.run(id, position, type, tentative, JSON.stringify(donnees));
  }
}

export function creer(db: Db, { id, sujetId, etat }: Boucle): void {
  const { phase, tete, etapes, ...donnees } = etat;
  db.transaction(() => {
    db.prepare(
      'INSERT INTO boucles (id, sujet_id, phase, tete, donnees) VALUES (?, ?, ?, ?, ?)',
    ).run(id, sujetId, phase, tete, JSON.stringify(donnees));
    enregistrerEtapes(db, id, etapes);
  })();
}

export function enregistrer(db: Db, { id, sujetId, etat }: Boucle): void {
  const { phase, tete, etapes, ...donnees } = etat;
  db.transaction(() => {
    const resultat = db
      .prepare('UPDATE boucles SET phase = ?, tete = ?, donnees = ? WHERE id = ? AND sujet_id = ?')
      .run(phase, tete, JSON.stringify(donnees), id, sujetId);
    if (resultat.changes !== 1) throw new Error('Boucle inconnue pour ce sujet');
    enregistrerEtapes(db, id, etapes);
  })();
}

function decoder(db: Db, ligne: LigneBoucle): Boucle {
  const lignes = db
    .prepare(
      'SELECT type, tentative, donnees FROM boucle_etapes WHERE boucle_id = ? ORDER BY position',
    )
    .all(ligne.id) as LigneEtape[];
  const etapes = lignes.map(({ type, tentative, donnees }) => ({
    type,
    tentative,
    ...(JSON.parse(donnees) as DonneesEtape),
  }));
  return {
    id: ligne.id,
    sujetId: ligne.sujet_id,
    etat: {
      phase: ligne.phase,
      tete: ligne.tete,
      ...(JSON.parse(ligne.donnees) as DonneesEtat),
      etapes,
    },
  };
}

export function lire(db: Db, id: string): Boucle | undefined {
  return db.transaction(() => {
    const ligne = db.prepare('SELECT * FROM boucles WHERE id = ?').get(id) as
      LigneBoucle | undefined;
    if (ligne) return decoder(db, ligne);
  })();
}

export function lireDerniere(db: Db, sujetId: string): Boucle | undefined {
  const ligne = db
    .prepare('SELECT * FROM boucles WHERE sujet_id = ? ORDER BY rowid DESC LIMIT 1')
    .get(sujetId) as LigneBoucle | undefined;
  if (ligne) return decoder(db, ligne);
}

export function verdictRevueBoucle(db: Db, sujetId: string) {
  const boucle = lireDerniere(db, sujetId);
  if (!boucle) return undefined;
  const revue = boucle.etat.etapes.findLast(({ type }) => type === 'revue');
  return { tete: revue?.teteArrivee ?? null, issue: revue?.issue ?? null };
}

export function lireAvecGroupes(db: Db): Boucle[] {
  const lignes = db
    .prepare("SELECT * FROM boucles WHERE json_array_length(donnees, '$.groupes') > 0")
    .all() as LigneBoucle[];
  return lignes.map((ligne) => decoder(db, ligne));
}

export function reprendre(db: Db, maintenant: number): (Boucle & { actions: ActionBoucle[] })[] {
  return db
    .transaction(() => {
      const lignes = db
        .prepare(
          "SELECT * FROM boucles WHERE phase IN ('plan', 'acceptation', 'dev', 'gate', 'revue')",
        )
        .all() as LigneBoucle[];
      const reprises = [];
      for (const ligne of lignes) {
        const boucle = decoder(db, ligne);
        const reprise = transition(boucle.etat, { type: 'etape_perdue' }, maintenant);
        if (reprise.actions.length === 0) continue;
        const resultat = { ...boucle, ...reprise };
        enregistrer(db, resultat);
        reprises.push(resultat);
      }
      return reprises;
    })
    .immediate();
}

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { creer, enregistrer, lire, reprendre } from '../../src/daemon/boucle/depot.js';
import { openDb } from '../../src/daemon/db.js';

const MAINTENANT = 1_000;
const SUJET = 'sujet-fictif';
const AUTRE_SUJET = 'autre-sujet-fictif';
const TETE = 'a'.repeat(40);

type Boucle = Parameters<typeof creer>[1];

function boucleInitiale(id = 'boucle-1', sujetId = SUJET): Boucle {
  return {
    id,
    sujetId,
    etat: {
      phase: 'plan',
      acceptation: true,
      redevCap: 2,
      redevs: 0,
      tete: TETE,
      empreintePlan: null,
      gate: null,
      revue: null,
      etapes: [],
    },
  };
}

describe('dépôt de boucles', () => {
  let dossier: string;
  let chemin: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    dossier = mkdtempSync(join(tmpdir(), 'aid-boucle-'));
    chemin = join(dossier, 'state.db');
    db = openDb(chemin);
    db.prepare(
      `INSERT INTO workspaces (id, name, root, base_branch, worktrees_dir, created_at)
       VALUES ('espace-fictif', 'Espace fictif', ?, 'main', ?, 't0')`,
    ).run(dossier, dossier);
    const insererSujet = db.prepare(
      `INSERT INTO topics
       VALUES (?, 'espace-fictif', ?, 'Sujet fictif', 'feat', ?, 'main', ?, 'active',
               NULL, 'disabled', 't0', 't0', NULL, NULL, NULL)`,
    );
    for (const sujet of [SUJET, AUTRE_SUJET]) {
      insererSujet.run(sujet, sujet, `feat/${sujet}`, join(dossier, sujet));
    }
  });

  afterEach(() => {
    if (db?.open) db.close();
    if (dossier) rmSync(dossier, { recursive: true, force: true });
  });

  it('relit à l’identique la boucle créée puis persiste les mises à jour de la boucle et de ses tentatives', () => {
    const boucle = boucleInitiale();
    creer(db, boucle);
    expect(lire(db, boucle.id)).toEqual(boucle);

    const avancee: Boucle = {
      ...boucle,
      etat: {
        ...boucle.etat,
        phase: 'dev',
        empreintePlan: 'c'.repeat(64),
        etapes: [
          {
            type: 'plan',
            tentative: 1,
            agentId: null,
            debut: MAINTENANT - 100,
            echeance: MAINTENANT + 100,
            issue: 'pass',
          },
          {
            type: 'dev',
            tentative: 1,
            agentId: null,
            debut: MAINTENANT,
            echeance: MAINTENANT + 200,
            issue: null,
          },
        ],
      },
    };
    enregistrer(db, avancee);
    db.close();
    db = openDb(chemin);
    expect(lire(db, boucle.id)).toEqual(avancee);
  });

  it.each(['arretee', 'livraison_prete'] as const)(
    'verrouille le sujet entre connexions et libère le verrou en phase %s',
    (phase) => {
      const premiere = boucleInitiale();
      const seconde = boucleInitiale('boucle-2');
      const independante = boucleInitiale('boucle-3', AUTRE_SUJET);
      creer(db, premiere);
      const autreConnexion = openDb(chemin);
      try {
        expect(() => creer(autreConnexion, seconde)).toThrow();
        expect(lire(autreConnexion, seconde.id)).toBeUndefined();
        creer(autreConnexion, independante);
        expect(lire(db, independante.id)).toEqual(independante);

        const terminee: Boucle = { ...premiere, etat: { ...premiere.etat, phase } };
        enregistrer(db, terminee);
        creer(autreConnexion, seconde);
        expect(lire(db, premiere.id)).toEqual(terminee);
        expect(lire(db, seconde.id)).toEqual(seconde);
      } finally {
        autreConnexion.close();
      }
    },
  );

  it('persiste cannot_evaluate pour l’agent perdu au redémarrage et ne reprend jamais deux fois sa tentative', () => {
    const boucle = boucleInitiale();
    const tentative = {
      type: 'plan',
      tentative: 1,
      agentId: 'agent-fictif-perdu',
      debut: MAINTENANT - 100,
      echeance: MAINTENANT + 100,
      issue: null,
    } as const;
    creer(db, { ...boucle, etat: { ...boucle.etat, etapes: [tentative] } });

    db.close();
    db = openDb(chemin);
    const reprises = reprendre(db, MAINTENANT);
    expect(reprises).toHaveLength(1);
    expect(reprises[0]).toMatchObject({
      id: boucle.id,
      etat: {
        phase: 'escalade',
        etapes: [{ ...tentative, issue: 'cannot_evaluate' }],
      },
      actions: [{ type: 'escalader', raison: 'cannot_evaluate' }],
    });

    db.close();
    db = openDb(chemin);
    expect(reprendre(db, MAINTENANT + 1)).toEqual([]);
    expect(lire(db, boucle.id)?.etat).toEqual(reprises[0]?.etat);
  });
});

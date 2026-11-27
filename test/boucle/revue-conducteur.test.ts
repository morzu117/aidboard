import { describe, expect, it } from 'vitest';
import { transition, type EtatBoucle, type EvenementBoucle } from '../../src/daemon/boucle/etat.js';
import { lireRevue } from '../../src/daemon/boucle/revue.js';

const TETE = 'a'.repeat(40);
const EMPREINTE = 'b'.repeat(64);
const FICHIER = 'src/exemple.ts';
const POINT = 'critere-a';
const SESSION = 'session-fictive';
const MAINTENANT = 1_000;

function reponseRevue(categories: string[]) {
  const verdict = categories.length > 0 ? 'fail' : 'pass';
  const donnees = {
    tete: TETE,
    verdicts: { fichiers: { [FICHIER]: verdict }, points: { [POINT]: verdict } },
    findings: categories.map((categorie) => ({
      severite: 'mineure',
      categorie,
      emplacement: `${FICHIER}:12`,
      probleme: 'Le filtre ignore un critère.',
      action: 'Appliquer le critère.',
      point: POINT,
    })),
  };
  return `\`\`\`json\n${JSON.stringify(donnees)}\n\`\`\``;
}

const ATTENDU = { fichiers: [FICHIER], points: [POINT], tete: TETE };

function etatEnRevue(): EtatBoucle {
  return {
    phase: 'revue',
    acceptation: true,
    redevCap: 2,
    redevs: 0,
    tete: TETE,
    empreintePlan: EMPREINTE,
    gate: { tete: TETE, issue: 'pass' },
    revue: null,
    etapes: [
      {
        type: 'revue',
        tentative: 1,
        agentId: SESSION,
        debut: MAINTENANT - 100,
        echeance: MAINTENANT + 100,
        issue: null,
      },
    ],
  };
}

function lireFinDeRevue(texteFinal: string): EvenementBoucle[] {
  const revue = lireRevue(texteFinal, ATTENDU);
  if (!revue.ok) return [{ type: 'artefact_manquant' }];
  return [
    { type: 'revue_terminee', tete: TETE, issue: 'pass' },
    { type: 'triage_termine', categories: revue.categories },
  ];
}

function appliquerEvenements(etat: EtatBoucle, evenements: EvenementBoucle[]) {
  const actions = [];
  for (const evenement of evenements) {
    const resultat = transition(etat, evenement, MAINTENANT);
    etat = resultat.etat;
    actions.push(...resultat.actions);
  }
  return { etat, actions };
}

function verifierEvenementsValides(evenements: EvenementBoucle[], categories: string[]) {
  expect(evenements).toEqual([
    { type: 'revue_terminee', tete: TETE, issue: 'pass' },
    { type: 'triage_termine', categories },
  ]);
}

describe('lecture de la réponse finale et triage dans la machine', () => {
  it('rend un triage vide qui mène à la livraison prête', () => {
    const evenements = lireFinDeRevue(reponseRevue([]));
    verifierEvenementsValides(evenements, []);
    const resultat = appliquerEvenements(etatEnRevue(), evenements);
    expect(resultat.etat.phase).toBe('livraison_prete');
    expect(resultat.actions).toEqual([]);
  });

  it('renvoie bug et nit au dev', () => {
    const categories = ['bug', 'nit'];
    const evenements = lireFinDeRevue(reponseRevue(categories));
    verifierEvenementsValides(evenements, categories);
    const resultat = appliquerEvenements(etatEnRevue(), evenements);
    expect(resultat.etat).toMatchObject({ phase: 'dev', redevs: 1 });
    expect(resultat.actions).toEqual([{ type: 'lancer_etape', etape: 'dev' }]);
  });

  it.each(['design', 'categorie-inconnue'])('escalade la catégorie %s', (categorie) => {
    const evenements = lireFinDeRevue(reponseRevue([categorie]));
    verifierEvenementsValides(evenements, [categorie]);
    const resultat = appliquerEvenements(etatEnRevue(), evenements);
    expect(resultat.etat).toMatchObject({ phase: 'escalade', redevs: 0 });
    expect(resultat.actions).toEqual([expect.objectContaining({ type: 'escalader' })]);
  });

  it('relance la même revue quand la réponse finale est en prose', () => {
    const evenements = lireFinDeRevue('CLEAN');
    expect(evenements).toEqual([{ type: 'artefact_manquant' }]);
    const resultat = appliquerEvenements(etatEnRevue(), evenements);
    expect(resultat.etat).toMatchObject({ phase: 'revue', revue: null, redevs: 0 });
    expect(resultat.etat.etapes).toMatchObject([
      { type: 'revue', tentative: 1, agentId: SESSION, issue: null, relance: true },
    ]);
    expect(resultat.actions).toEqual([{ type: 'relancer_etape', etape: 'revue' }]);
  });

  it('escalade ambiguity au second bloc invalide sans relancer la revue', () => {
    const premier = lireFinDeRevue('```json\n{}\n```');
    expect(premier).toEqual([{ type: 'artefact_manquant' }]);
    const relance = appliquerEvenements(etatEnRevue(), premier);
    expect(relance.actions).toEqual([{ type: 'relancer_etape', etape: 'revue' }]);

    const second = lireFinDeRevue(`${reponseRevue([])}\n\n${reponseRevue([])}`);
    expect(second).toEqual([{ type: 'artefact_manquant' }]);
    const resultat = appliquerEvenements(relance.etat, second);
    expect(resultat.etat).toMatchObject({ phase: 'escalade', revue: null, redevs: 0 });
    expect(resultat.etat.etapes).toHaveLength(1);
    expect(resultat.actions).toEqual([{ type: 'escalader', raison: 'ambiguity' }]);
  });

  it('escalade redev_cap sur un nouveau bug après un re-dev et un re-test', () => {
    const premier = lireFinDeRevue(reponseRevue(['bug']));
    verifierEvenementsValides(premier, ['bug']);
    const dev = appliquerEvenements(etatEnRevue(), premier);
    expect(dev.etat).toMatchObject({ phase: 'dev', redevs: 1 });

    const retest = transition(dev.etat, { type: 'tests_modifies' }, MAINTENANT);
    expect(retest.etat).toMatchObject({ phase: 'acceptation', redevs: 2 });
    const nouvelleRevue = appliquerEvenements(retest.etat, [
      { type: 'etape_terminee', etape: 'acceptation', tete: TETE },
      { type: 'etape_terminee', etape: 'dev', tete: TETE },
      { type: 'gate_termine', tete: TETE, issue: 'pass' },
    ]);
    expect(nouvelleRevue.etat).toMatchObject({ phase: 'revue', redevs: 2 });

    const second = lireFinDeRevue(reponseRevue(['bug']));
    verifierEvenementsValides(second, ['bug']);
    const resultat = appliquerEvenements(nouvelleRevue.etat, second);
    expect(resultat.etat).toMatchObject({ phase: 'escalade', redevs: 2 });
    expect(resultat.actions).toEqual([{ type: 'escalader', raison: 'redev_cap' }]);
  });
});

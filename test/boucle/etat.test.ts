import { describe, expect, it } from 'vitest';
import {
  transition,
  type ActionBoucle,
  type EtatBoucle,
  type EvenementBoucle,
} from '../../src/daemon/boucle/etat.js';

const MAINTENANT = 1_000;
const TETE = 'a'.repeat(40);
const NOUVELLE_TETE = 'b'.repeat(40);
const EMPREINTE = 'c'.repeat(64);
const NOUVELLE_EMPREINTE = 'd'.repeat(64);

function etatInitial(acceptation = true): EtatBoucle {
  return {
    phase: 'plan',
    acceptation,
    redevCap: 2,
    redevs: 0,
    tete: TETE,
    empreintePlan: null,
    gate: null,
    revue: null,
    etapes: [
      {
        type: 'plan',
        tentative: 1,
        agentId: 'agent-fictif',
        debut: MAINTENANT - 100,
        echeance: MAINTENANT + 100,
        issue: null,
      },
    ],
  };
}

function avancer(
  etat: EtatBoucle,
  evenement: EvenementBoucle,
  phase: EtatBoucle['phase'],
  actions: ActionBoucle[],
): EtatBoucle {
  const avant = structuredClone(etat);
  const resultat = transition(etat, evenement, MAINTENANT);
  expect(etat).toEqual(avant);
  expect(resultat.etat.phase).toBe(phase);
  expect(resultat.actions).toEqual(actions);
  return resultat.etat;
}

function attendreGo(acceptation = true) {
  return avancer(
    etatInitial(acceptation),
    { type: 'plan_termine', empreinte: EMPREINTE },
    'attente_go',
    [],
  );
}

function terminerAcceptation(etat: EtatBoucle) {
  return avancer(etat, { type: 'etape_terminee', etape: 'acceptation', tete: TETE }, 'dev', [
    { type: 'lancer_etape', etape: 'dev' },
  ]);
}

function lancerDev(acceptation = true) {
  const attente = attendreGo(acceptation);
  if (!acceptation) {
    return avancer(attente, { type: 'go' }, 'dev', [{ type: 'lancer_etape', etape: 'dev' }]);
  }
  return terminerAcceptation(
    avancer(attente, { type: 'go' }, 'acceptation', [
      { type: 'lancer_etape', etape: 'acceptation' },
    ]),
  );
}

function lancerGate(etat = lancerDev()) {
  return avancer(etat, { type: 'etape_terminee', etape: 'dev', tete: TETE }, 'gate', [
    { type: 'lancer_gate' },
  ]);
}

function validerGate(etat = lancerGate()) {
  return avancer(etat, { type: 'gate_termine', tete: TETE, issue: 'pass' }, 'revue', [
    { type: 'lancer_etape', etape: 'revue' },
  ]);
}

function validerRevue(etat = validerGate()) {
  return avancer(etat, { type: 'revue_terminee', tete: TETE }, 'triage', []);
}

describe('transition de boucle', () => {
  it('enchaîne plan, GO, acceptation, dev, gate, revue et triage jusqu’à la livraison', () => {
    const triage = validerRevue();
    expect(triage.empreintePlan).toBe(EMPREINTE);
    expect(triage.redevs).toBe(0);
    expect(triage.gate).toMatchObject({ tete: TETE, issue: 'pass' });
    expect(triage.revue).toMatchObject({ tete: TETE, issue: 'pass' });
    avancer(triage, { type: 'triage_termine', categories: [] }, 'livraison_prete', []);
  });

  it('enchaîne le GO directement vers le dev si l’acceptation est désactivée', () => {
    const dev = lancerDev(false);
    expect(dev.etapes).toMatchObject([{ type: 'plan' }, { type: 'dev' }]);
  });

  it('refuse le GO avant la fin du plan et après le démarrage du dev', () => {
    for (const etat of [etatInitial(), lancerDev()]) {
      const avant = structuredClone(etat);
      expect(transition(etat, { type: 'go' }, MAINTENANT)).toEqual({ etat: avant, actions: [] });
      expect(etat).toEqual(avant);
    }
  });

  it('arrête le dev si l’empreinte du plan change après le GO et attend un nouveau GO', () => {
    const dev = lancerDev();
    const attente = avancer(
      dev,
      { type: 'plan_modifie', empreinte: NOUVELLE_EMPREINTE },
      'attente_go',
      [{ type: 'arreter_etape', etape: 'dev' }],
    );
    expect(attente.empreintePlan).toBe(NOUVELLE_EMPREINTE);
    expect(attente.etapes).not.toContainEqual(expect.objectContaining({ issue: null }));
    avancer(attente, { type: 'go' }, 'acceptation', [
      { type: 'lancer_etape', etape: 'acceptation' },
    ]);
  });

  it('conserve le dev si le plan signalé a la même empreinte', () => {
    const dev = lancerDev();
    expect(avancer(dev, { type: 'plan_modifie', empreinte: EMPREINTE }, 'dev', [])).toEqual(dev);
  });

  it('marque delai_depasse sur un tic après l’échéance et escalade sans événement d’agent', () => {
    const plan = etatInitial();
    expect(transition(plan, { type: 'tic' }, MAINTENANT)).toEqual({ etat: plan, actions: [] });
    const resultat = transition(plan, { type: 'tic' }, MAINTENANT + 101);
    expect(resultat.etat.phase).toBe('escalade');
    expect(resultat.etat.etapes).toMatchObject([{ type: 'plan', issue: 'delai_depasse' }]);
    expect(resultat.actions).toContainEqual({ type: 'escalader', raison: 'delai_depasse' });
  });

  it('lance la revue sur un gate pass à la tête courante', () => {
    expect(validerGate().gate).toMatchObject({ tete: TETE, issue: 'pass' });
  });

  it('compte un re-dev sur un gate fail', () => {
    const dev = avancer(lancerGate(), { type: 'gate_termine', tete: TETE, issue: 'fail' }, 'dev', [
      { type: 'lancer_etape', etape: 'dev' },
    ]);
    expect(dev.redevs).toBe(1);
  });

  it('escalade un gate cannot_evaluate sans lancer la revue', () => {
    const escalade = avancer(
      lancerGate(),
      { type: 'gate_termine', tete: TETE, issue: 'cannot_evaluate' },
      'escalade',
      [{ type: 'escalader', raison: 'cannot_evaluate' }],
    );
    expect(escalade.etapes.at(-1)).toMatchObject({ type: 'gate', issue: 'cannot_evaluate' });
  });

  it.each(['revue', 'triage'] as const)(
    'invalide les preuves et refait le gate depuis %s si la tête bouge',
    (phase) => {
      const etat = phase === 'revue' ? validerGate() : validerRevue();
      const resultat = transition(etat, { type: 'tete_modifiee', tete: NOUVELLE_TETE }, MAINTENANT);
      expect(resultat.etat).toMatchObject({
        phase: 'gate',
        tete: NOUVELLE_TETE,
        gate: null,
        revue: null,
      });
      expect(resultat.actions).toContainEqual({ type: 'lancer_gate' });
      expect(resultat.actions).not.toContainEqual({ type: 'lancer_etape', etape: 'revue' });
    },
  );

  it.each(['bug', 'test-gap', 'nit'])(
    'renvoie le finding %s au dev et compte un re-dev',
    (categorie) => {
      const dev = avancer(
        validerRevue(),
        { type: 'triage_termine', categories: [categorie] },
        'dev',
        [{ type: 'lancer_etape', etape: 'dev' }],
      );
      expect(dev.redevs).toBe(1);
    },
  );

  it.each(['design', 'archi', 'scope-creep', 'categorie-inconnue'])(
    'escalade le finding %s vers l’humain',
    (categorie) => {
      const resultat = transition(
        validerRevue(),
        { type: 'triage_termine', categories: [categorie] },
        MAINTENANT,
      );
      expect(resultat.etat.phase).toBe('escalade');
      expect(resultat.actions).toEqual([expect.objectContaining({ type: 'escalader' })]);
    },
  );

  it.each(['dev', 'acceptation'] as const)(
    'escalade la troisième relance (vers %s) après un re-dev et un re-test',
    (etape) => {
      const gateEnEchec = { type: 'gate_termine', tete: TETE, issue: 'fail' } as const;
      const dev = avancer(lancerGate(), gateEnEchec, 'dev', [
        { type: 'lancer_etape', etape: 'dev' },
      ]);
      expect(dev.redevs).toBe(1);
      const acceptation = avancer(dev, { type: 'tests_modifies' }, 'acceptation', [
        { type: 'arreter_etape', etape: 'dev' },
        { type: 'lancer_etape', etape: 'acceptation' },
      ]);
      expect(acceptation.redevs).toBe(2);
      const nouveauDev = terminerAcceptation(acceptation);
      expect(nouveauDev.redevs).toBe(2);
      const [etat, evenement] =
        etape === 'dev'
          ? [lancerGate(nouveauDev), gateEnEchec]
          : [nouveauDev, { type: 'tests_modifies' } as const];

      const resultat = transition(etat, evenement, MAINTENANT);
      expect(resultat.etat).toMatchObject({ phase: 'escalade', redevs: 2 });
      expect(resultat.actions).toContainEqual({ type: 'escalader', raison: 'redev_cap' });
      expect(resultat.actions).not.toContainEqual({ type: 'lancer_etape', etape });
      expect(resultat.actions).not.toContainEqual({ type: 'relancer_etape', etape });
    },
  );

  it('relance une seule fois la même tentative sans artefact, puis escalade ambiguity', () => {
    const plan = etatInitial();
    const relance = avancer(plan, { type: 'artefact_manquant' }, 'plan', [
      { type: 'relancer_etape', etape: 'plan' },
    ]);
    expect(relance.etapes).toMatchObject([
      { type: 'plan', tentative: 1, agentId: 'agent-fictif', issue: null },
    ]);
    const resultat = transition(relance, { type: 'artefact_manquant' }, MAINTENANT);
    expect(resultat.etat.phase).toBe('escalade');
    expect(resultat.etat.etapes).toHaveLength(1);
    expect(resultat.actions).toContainEqual({ type: 'escalader', raison: 'ambiguity' });
    expect(resultat.actions).not.toContainEqual({ type: 'relancer_etape', etape: 'plan' });
    expect(resultat.actions).not.toContainEqual({ type: 'lancer_etape', etape: 'plan' });
  });

  it.each([0, 39, 41])('refuse une issue de gate avec une tête de %i caractères', (longueur) => {
    const gate = lancerGate();
    const avant = structuredClone(gate);
    expect(() =>
      transition(
        gate,
        { type: 'gate_termine', tete: 'a'.repeat(longueur), issue: 'pass' },
        MAINTENANT,
      ),
    ).toThrow();
    expect(gate).toEqual(avant);
  });
});

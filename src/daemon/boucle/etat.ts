import type { GroupeBoucle } from './groupes.js';

type Etape = 'plan' | 'acceptation' | 'dev' | 'gate' | 'revue';
type EtapeAgent = Exclude<Etape, 'gate'>;
export type Issue = 'pass' | 'fail' | 'cannot_evaluate' | 'skipped' | 'delai_depasse';

export interface Tentative {
  type: Etape | 'triage';
  tentative: number;
  agentId: string | null;
  debut: number;
  echeance: number | null;
  issue: Issue | null;
  fin?: number;
  relance?: boolean;
  acteur?: { genre: string; modele: string; role: string; sessionId: string };
  teteDepart?: string;
  teteArrivee?: string;
  preuve?: { codeSortie?: number; comptes?: Record<string, number> };
  categories?: string[];
  route?: 'dev' | 'humain' | 'livraison';
}

interface ResultatEtape {
  tete: string;
  issue: Issue;
}

export interface EtatBoucle {
  phase: Etape | 'attente_go' | 'triage' | 'livraison_prete' | 'escalade' | 'arretee';
  acceptation: boolean;
  redevCap: number;
  redevs: number;
  tete: string;
  empreintePlan: string | null;
  gate: ResultatEtape | null;
  revue: ResultatEtape | null;
  etapes: Tentative[];
  groupes?: GroupeBoucle[];
}

export type EvenementBoucle =
  | { type: 'plan_termine' | 'plan_modifie'; empreinte: string }
  | { type: 'go' | 'tic' | 'tests_modifies' | 'artefact_manquant' | 'arreter' | 'etape_perdue' }
  | { type: 'etape_terminee'; etape: 'acceptation' | 'dev'; tete: string }
  | { type: 'gate_termine'; tete: string; issue: Issue }
  | { type: 'revue_terminee'; tete: string; issue?: 'pass' | 'fail' }
  | { type: 'tete_modifiee'; tete: string }
  | { type: 'triage_termine'; categories: string[] };

export type ActionBoucle =
  | { type: 'lancer_etape' | 'relancer_etape'; etape: EtapeAgent }
  | { type: 'arreter_etape'; etape: Etape }
  | { type: 'lancer_gate' }
  | { type: 'escalader'; raison: string };

interface ResultatTransition {
  etat: EtatBoucle;
  actions: ActionBoucle[];
}

function courante(etat: EtatBoucle): Tentative | undefined {
  const derniere = etat.etapes.at(-1);
  if (derniere?.type === etat.phase && derniere.issue === null) return derniere;
}

export function transition(
  etat: EtatBoucle,
  evenement: EvenementBoucle,
  maintenant: number,
): ResultatTransition {
  if ('tete' in evenement && evenement.tete.length !== 40) {
    throw new Error('Une tête de commit doit compter 40 caractères');
  }

  const tentative = courante(etat);
  const portes = { gate: null, revue: null };
  const inchange = { etat, actions: [] };
  const terminal = etat.phase === 'arretee' || etat.phase === 'livraison_prete';

  function modifier(changements: Partial<EtatBoucle>, actions: ActionBoucle[] = []) {
    return { etat: { ...etat, ...changements }, actions };
  }

  function etapes(ajout: Partial<Tentative>) {
    if (!tentative) return etat.etapes;
    return [...etat.etapes.slice(0, -1), { ...tentative, ...ajout }];
  }

  function clore(issue: Issue, teteArrivee = etat.tete) {
    return etapes({ issue, fin: maintenant, teteArrivee });
  }

  function arreter(): ActionBoucle[] {
    return tentative && tentative.type !== 'triage'
      ? [{ type: 'arreter_etape', etape: tentative.type }]
      : [];
  }

  function escalader(raison: string, etatDepart = etat, actions: ActionBoucle[] = []) {
    return {
      etat: { ...etatDepart, phase: 'escalade' as const },
      actions: [...actions, { type: 'escalader' as const, raison }],
    };
  }

  function lancer(phase: Etape, etatDepart = etat): ResultatTransition {
    const tentative =
      (etatDepart.etapes.findLast((etape) => etape.type === phase)?.tentative ?? 0) + 1;
    const action: ActionBoucle =
      phase === 'gate' ? { type: 'lancer_gate' } : { type: 'lancer_etape', etape: phase };
    return {
      etat: {
        ...etatDepart,
        phase,
        etapes: [
          ...etatDepart.etapes,
          {
            type: phase,
            tentative,
            agentId: null,
            debut: maintenant,
            echeance: null,
            issue: null,
            teteDepart: etatDepart.tete,
          },
        ],
      },
      actions: [action],
    };
  }

  function relancer(phase: 'dev' | 'acceptation', etatDepart = etat, actions: ActionBoucle[] = []) {
    if (etatDepart.redevs >= etatDepart.redevCap)
      return escalader('redev_cap', etatDepart, actions);
    const suite = lancer(phase, etatDepart);
    return {
      etat: { ...suite.etat, ...portes, redevs: etat.redevs + 1 },
      actions: [...actions, ...suite.actions],
    };
  }

  const transitions: { [T in EvenementBoucle['type']]: () => ResultatTransition } = {
    plan_termine: () => {
      if (evenement.type !== 'plan_termine' || etat.phase !== 'plan') return inchange;
      return modifier({
        phase: 'attente_go',
        empreintePlan: evenement.empreinte,
        etapes: clore('pass'),
      });
    },
    go: () => {
      if (etat.phase !== 'attente_go') return inchange;
      return lancer(etat.acceptation ? 'acceptation' : 'dev');
    },
    plan_modifie: () => {
      if (
        evenement.type !== 'plan_modifie' ||
        etat.phase === 'plan' ||
        etat.empreintePlan === evenement.empreinte
      )
        return inchange;
      return modifier(
        {
          ...portes,
          phase: 'attente_go',
          empreintePlan: evenement.empreinte,
          etapes: clore('skipped'),
        },
        arreter(),
      );
    },
    etape_terminee: () => {
      if (evenement.type !== 'etape_terminee' || evenement.etape !== etat.phase) return inchange;
      return lancer(evenement.etape === 'dev' ? 'gate' : 'dev', {
        ...etat,
        ...portes,
        tete: evenement.tete,
        etapes: clore('pass', evenement.tete),
      });
    },
    gate_termine: () => {
      if (evenement.type !== 'gate_termine' || etat.phase !== 'gate') return inchange;
      if (evenement.tete !== etat.tete) {
        return lancer('gate', { ...etat, ...portes, etapes: clore('skipped', evenement.tete) });
      }
      const fini = {
        ...etat,
        gate: { tete: evenement.tete, issue: evenement.issue },
        etapes: clore(evenement.issue),
      };
      if (evenement.issue === 'pass') return lancer('revue', fini);
      if (evenement.issue === 'fail') return relancer('dev', fini);
      return escalader(evenement.issue, fini);
    },
    revue_terminee: () => {
      if (evenement.type !== 'revue_terminee' || etat.phase !== 'revue') return inchange;
      if (
        evenement.tete !== etat.tete ||
        etat.gate?.tete !== etat.tete ||
        etat.gate.issue !== 'pass'
      ) {
        return lancer('gate', { ...etat, ...portes, etapes: clore('skipped', evenement.tete) });
      }
      const issue = evenement.issue ?? 'pass';
      return modifier({
        phase: 'triage',
        revue: { tete: evenement.tete, issue },
        etapes: clore(issue, evenement.tete),
      });
    },
    tete_modifiee: () => {
      if (evenement.type !== 'tete_modifiee' || evenement.tete === etat.tete) return inchange;
      const change = { ...etat, ...portes, tete: evenement.tete };
      if (etat.phase !== 'gate' && etat.phase !== 'revue' && etat.phase !== 'triage') {
        return { etat: change, actions: [] };
      }
      const suite = lancer('gate', { ...change, etapes: clore('skipped', evenement.tete) });
      return { etat: suite.etat, actions: [...arreter(), ...suite.actions] };
    },
    triage_termine: () => {
      if (evenement.type !== 'triage_termine' || etat.phase !== 'triage') return inchange;
      const categories = evenement.categories;
      function consigner(route: NonNullable<Tentative['route']>): EtatBoucle {
        const numero =
          (etat.etapes.findLast((etape) => etape.type === 'triage')?.tentative ?? 0) + 1;
        const tete = etat.revue?.tete ?? etat.tete;
        return {
          ...etat,
          etapes: [
            ...etat.etapes,
            {
              type: 'triage',
              tentative: numero,
              agentId: null,
              debut: maintenant,
              echeance: null,
              issue: 'pass',
              fin: maintenant,
              teteDepart: tete,
              teteArrivee: tete,
              categories: [...categories],
              route,
            },
          ],
        };
      }
      if (categories.length === 0) {
        return modifier({ phase: 'livraison_prete', etapes: consigner('livraison').etapes });
      }
      if (
        evenement.categories.every((categorie) => ['bug', 'test-gap', 'nit'].includes(categorie))
      ) {
        return relancer('dev', consigner(etat.redevs >= etat.redevCap ? 'humain' : 'dev'));
      }
      return escalader('finding', consigner('humain'));
    },
    tests_modifies: () => {
      if (!etat.acceptation || etat.phase !== 'dev') return inchange;
      return relancer('acceptation', { ...etat, etapes: clore('skipped') }, arreter());
    },
    artefact_manquant: () => {
      if (tentative?.type === 'triage') return inchange;
      if (!tentative || tentative.type === 'gate') return inchange;
      if (tentative.relance) {
        return escalader('ambiguity', { ...etat, etapes: clore('cannot_evaluate') });
      }
      return modifier({ etapes: etapes({ relance: true }) }, [
        { type: 'relancer_etape', etape: tentative.type },
      ]);
    },
    tic: () => {
      if (!tentative || tentative.echeance === null || maintenant < tentative.echeance)
        return inchange;
      return escalader('delai_depasse', { ...etat, etapes: clore('delai_depasse') }, arreter());
    },
    etape_perdue: () => {
      if (!tentative) return inchange;
      return escalader('cannot_evaluate', { ...etat, etapes: clore('cannot_evaluate') });
    },
    arreter: () => modifier({ phase: 'arretee', etapes: clore('skipped') }, arreter()),
  };

  return terminal ? inchange : transitions[evenement.type]();
}

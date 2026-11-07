import { attendDecision } from '../../shared/decision.js';
import type { Db } from '../db.js';
import type { EventStore } from '../events/store.js';
import { abonnementsActifs } from './abonnements.js';
import { envoyer, type DependancesEnvoi } from './envoi.js';

export interface DependancesDeclencheur {
  log?: (message: string) => void;
  db: Db;
  store: EventStore;
  actif: () => boolean;
  envoi: () => DependancesEnvoi;
  envoyer?: typeof envoyer;
  /** Instant Unix en millisecondes. */
  maintenant?: () => number;
  programmer?: typeof setTimeout;
  annuler?: typeof clearTimeout;
}

export function creerDeclencheur(deps: DependancesDeclencheur) {
  const maintenant = deps.maintenant ?? Date.now;
  const programmer = deps.programmer ?? setTimeout;
  const annuler = deps.annuler ?? clearTimeout;
  let minuterie: ReturnType<typeof setTimeout> | undefined;
  let arrete = false;
  let dernierEnvoi = 0;
  const enCours = new Set<Promise<void>>();

  function compter(): number {
    const agents = deps.db
      .prepare(
        `SELECT a.pending, a.status_reason AS statusReason FROM agents a
         JOIN runs r ON r.id = a.run_id JOIN topics t ON t.id = r.topic_id
         WHERE a.closed_at IS NULL AND t.state != 'archived'`,
      )
      .all() as Array<{ pending: string | null; statusReason: string | null }>;
    return agents.filter((a) =>
      attendDecision({
        attend: a.pending !== null,
        question: a.pending !== null && JSON.parse(a.pending).kind === 'question',
        statusReason: a.statusReason,
      }),
    ).length;
  }

  let precedent = compter();

  function expedier(n: number) {
    if (arrete || n === 0 || !deps.actif()) return;
    dernierEnvoi = n;
    // La fenêtre mesure les départs, jamais la durée du transport.
    minuterie = programmer(() => {
      minuterie = undefined;
      try {
        const actuel = compter();
        precedent = actuel;
        if (actuel > dernierEnvoi) expedier(actuel);
      } catch {
        (deps.log ?? console.error)('Erreur du compteur push');
      }
    }, 30_000);
    for (const abonnement of abonnementsActifs(deps.db, maintenant())) {
      const tache = (async () => {
        let statut: 'ok' | 'expire' | 'echec' = 'echec';
        try {
          statut = (await (deps.envoyer ?? envoyer)(abonnement, n, deps.envoi())).statut;
        } catch {
          // Une erreur injectée ou de chargement des clés ne doit pas exposer l'endpoint.
        }
        if (statut === 'expire') {
          deps.db
            .prepare('DELETE FROM push_abonnements WHERE appareil_id = ? AND endpoint = ?')
            .run(abonnement.appareilId, abonnement.endpoint);
        }
        deps.store.append({
          source: 'daemon',
          type: 'push.envoye',
          data: { appareilId: abonnement.appareilId, statut },
        });
      })();
      enCours.add(tache);
      void tache.finally(() => enCours.delete(tache));
    }
  }

  function observer() {
    try {
      const actuel = compter();
      const hausse = actuel > precedent;
      precedent = actuel;
      if (hausse && minuterie === undefined) expedier(actuel);
    } catch {
      (deps.log ?? console.error)('Erreur du compteur push');
    }
  }
  deps.store.on('event', observer);
  return {
    async arreter() {
      arrete = true;
      deps.store.off('event', observer);
      if (minuterie !== undefined) annuler(minuterie);
      minuterie = undefined;
      await Promise.all(enCours);
    },
  };
}

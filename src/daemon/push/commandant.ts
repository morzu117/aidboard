import type { Db } from '../db.js';
import type { EventStore } from '../events/store.js';
import { abonnementsActifs } from './abonnements.js';
import { envoyer, type DependancesEnvoi } from './envoi.js';

export async function notifierCommandant(
  id: number,
  deps: {
    db: Db;
    store: EventStore;
    actif: () => boolean;
    envoi: () => DependancesEnvoi;
    envoyer?: typeof envoyer;
  },
): Promise<void> {
  if (!deps.actif() || !Number.isSafeInteger(id) || id < 0) return;
  await Promise.all(
    abonnementsActifs(deps.db, Date.now()).map(async (abonnement) => {
      let statut: 'ok' | 'expire' | 'echec' = 'echec';
      try {
        statut = (await (deps.envoyer ?? envoyer)(abonnement, { c: id }, deps.envoi())).statut;
      } catch {
        /* aucun message du transport ne sort */
      }
      if (statut === 'expire')
        deps.db
          .prepare('DELETE FROM push_abonnements WHERE appareil_id = ? AND endpoint = ?')
          .run(abonnement.appareilId, abonnement.endpoint);
      deps.store.append({
        source: 'daemon',
        type: 'push.envoye',
        data: { appareilId: abonnement.appareilId, statut },
      });
    }),
  );
}

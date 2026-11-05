import { useEffect, useState, useSyncExternalStore } from 'react';
import type { NavPlacement, NavState } from '../../../src/shared/model.js';
import { annoncerPlacementNav, ecouterNavCache, getNavCacheSnapshot } from '../ui/Nav.js';
import { type AidApi, useAid } from './useAidState.js';

// Chantier 26 (D111, D112) : le placement d'un sujet pour l'écran Sujet, lu et changé dans le cache de la barre.

const duCache = (topicId: string): NavPlacement | null =>
  getNavCacheSnapshot()?.placements?.find((p) => p.topicId === topicId) ?? null;

/** Le placement du sujet, suivi dans le cache de la barre ; lu une fois par l'API si le cache est vide. */
export function usePlacement(topicId: string | undefined): NavPlacement | null {
  const { call } = useAid();
  const duCacheVivant = useSyncExternalStore(ecouterNavCache, () =>
    topicId ? duCache(topicId) : null,
  );
  const [repli, setRepli] = useState<{ topicId: string; placement: NavPlacement | null } | null>(
    null,
  );
  useEffect(() => {
    if (!topicId || getNavCacheSnapshot()) return;
    let annule = false;
    call<NavState>('GET', '/api/nav').then(
      (r) => {
        if (!annule)
          setRepli({
            topicId,
            placement: r.placements?.find((p) => p.topicId === topicId) ?? null,
          });
      },
      () => {},
    );
    return () => {
      annule = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId]);
  if (getNavCacheSnapshot()) return duCacheVivant;
  return repli && repli.topicId === topicId ? repli.placement : null;
}

type Patch = Partial<Pick<NavPlacement, 'pinned' | 'archived' | 'displayName'>>;

/** Change le placement : la barre et l'en-tête le prennent tout de suite, et reviennent en arrière sur un refus. */
export async function changerPlacement(
  call: AidApi['call'],
  topicId: string,
  patch: Patch,
): Promise<void> {
  const avant = duCache(topicId);
  annoncerPlacementNav(topicId, patch);
  try {
    await call('PATCH', `/api/nav/placements/${topicId}`, patch);
  } catch (err) {
    if (avant) {
      const retour: Patch = {};
      for (const k of Object.keys(patch) as (keyof Patch)[])
        Object.assign(retour, { [k]: avant[k] });
      annoncerPlacementNav(topicId, retour);
    }
    throw err;
  }
}

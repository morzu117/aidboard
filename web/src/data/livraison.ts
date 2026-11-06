import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LivraisonGit } from '../../../src/shared/git.js';
import type { ActionRun, Topic } from '../../../src/shared/model.js';
import { lirePr, type PrLue } from '../ui/livraisonVue.js';
import { AidApiError } from './api.js';
import { fetchLivraison } from './git.js';
import { type AidApi, useAid, useAidClient } from './useAidState.js';

// Chantier 27 : les lectures de l'écran Livraison. La PR se relit par `pr.rafraichir`, à l'ouverture
// et sur clic (D18), jamais en tâche de fond.

const message = (err: unknown) => (err instanceof AidApiError ? err.message : String(err));

/** `useAid().call` change à chaque rendu : un effet qui en dépend repartirait en boucle. */
function useCallStable(): AidApi['call'] {
  const client = useAidClient();
  return useMemo(() => (m, p, b) => client.request(m, p, b), [client]);
}

/** Une action lancée depuis l'écran, suivie par son `actionId` : jamais « la dernière » d'un autre écran. */
export function useActionSuivie(topicId: string) {
  const { state, outputs } = useAid();
  const call = useCallStable();
  const [id, setId] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const [refus, setRefus] = useState<string | null>(null);
  const run = id ? (state?.actions.find((a) => a.id === id) ?? null) : null;
  const enCours = envoi || (id !== null && (!run || run.state === 'running'));
  const derniere = id ? outputs[id]?.at(-1)?.line : undefined;
  const echec =
    refus ??
    (run && run.state !== 'running' && run.state !== 'succeeded'
      ? (derniere ??
        (run.state === 'needs_human' ? 'Action humaine requise.' : 'L’action a échoué.'))
      : null);

  const lancer = useCallback(
    async (actionId: string, body: Record<string, unknown> = {}) => {
      setRefus(null);
      setId(null);
      setEnvoi(true);
      try {
        const r = await call<{ actionId: string }>(
          'POST',
          `/api/topics/${topicId}/actions/${actionId}`,
          body,
        );
        setId(r.actionId);
      } catch (err) {
        setRefus(message(err));
      } finally {
        setEnvoi(false);
      }
    },
    [call, topicId],
  );

  return { run, enCours, echec, reussi: run?.state === 'succeeded', lancer };
}

/** Le dernier `topic.test` du sujet, d'où qu'il ait été lancé. */
export function dernierTest(actions: readonly ActionRun[], topicId: string): ActionRun | null {
  return (
    actions
      .filter((a) => a.action === 'topic.test' && a.topicId === topicId)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0] ?? null
  );
}

export interface Livraison {
  pr: PrLue | null;
  lecturePr: { enCours: boolean; echec: string | null };
  git: LivraisonGit | null;
  erreurGit: string | null;
  test: ActionRun | null;
  relire: () => void;
}

/** `revue` : le commit d'une revue à situer par rapport à HEAD (D125). */
export function useLivraison(topic: Topic, revue: string | null): Livraison {
  const { state } = useAid();
  const call = useCallStable();
  const lecture = useActionSuivie(topic.id);
  const { lancer } = lecture;
  const [git, setGit] = useState<LivraisonGit | null>(null);
  const [erreurGit, setErreurGit] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const lisible = !topic.worktreeMissing && topic.state !== 'archived';

  useEffect(() => {
    if (lisible && topic.prNumber !== null) void lancer('pr.rafraichir');
  }, [lisible, topic.prNumber, lancer, version]);

  useEffect(() => {
    if (!lisible) return;
    let vivant = true;
    fetchLivraison(call, topic.id, revue ?? undefined).then(
      (g) => {
        if (!vivant) return;
        setGit(g);
        setErreurGit(null);
      },
      (err: unknown) => vivant && setErreurGit(message(err)),
    );
    return () => {
      vivant = false;
    };
  }, [call, topic.id, revue, lisible, version]);

  return {
    pr: lecture.reussi ? lirePr(lecture.run?.result ?? null) : null,
    lecturePr: { enCours: lecture.enCours, echec: lecture.echec },
    git,
    erreurGit,
    test: dernierTest(state?.actions ?? [], topic.id),
    relire: () => setVersion((v) => v + 1),
  };
}

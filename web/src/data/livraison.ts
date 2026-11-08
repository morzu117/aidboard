import { useConfirmation } from '../ui/AttenteConfirmation.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LivraisonGit } from '../../../src/shared/git.js';
import type { MemoryPage } from '../../../src/shared/memory.js';
import type { ActionRun, Topic } from '../../../src/shared/model.js';
import {
  type Fraicheur,
  fraicheurRevue,
  lirePr,
  type PrLue,
  type SourceRevue,
  sourceRevue,
} from '../ui/livraisonVue.js';
import { AidApiError } from './api.js';
import { fetchLivraison } from './git.js';
import { fetchSubjectMemory } from './memory.js';
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
  const client = useAidClient();
  const confirmation = useConfirmation(() => client.refresh());
  const { recevoir } = confirmation;
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
        if (recevoir(r)) return;
        setId(r.actionId);
      } catch (err) {
        setRefus(message(err));
      } finally {
        setEnvoi(false);
      }
    },
    [call, topicId, recevoir],
  );

  return {
    confirmation,
    run,
    enCours,
    echec,
    reussi: confirmation.executee !== null || run?.state === 'succeeded',
    lancer,
  };
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
  /** La page `review` du sujet ; undefined tant qu'elle n'est pas lue. */
  page: MemoryPage | null | undefined;
  source: SourceRevue | null;
  /** null tant que la page, ou la position de son commit par rapport à HEAD, n'est pas lue. */
  fraicheur: Fraicheur | null;
  relire: () => void;
}

const SHA = /^[0-9a-f]{4,40}$/;

/** `namespace` : celui du workspace, où vit la page `review` du sujet (comme l'onglet Revue). */
export function useLivraison(topic: Topic, namespace: string): Livraison {
  const { state } = useAid();
  const call = useCallStable();
  const lecture = useActionSuivie(topic.id);
  const { lancer } = lecture;
  // `pour` : le commit de revue demandé avec cette lecture, pour ne pas lire la fraîcheur d'une autre
  const [git, setGit] = useState<{ g: LivraisonGit; pour: string | null } | null>(null);
  const [erreurGit, setErreurGit] = useState<string | null>(null);
  const [page, setPage] = useState<MemoryPage | null | undefined>(undefined);
  const [version, setVersion] = useState(0);
  const lisible = !topic.worktreeMissing && topic.state !== 'archived';
  const pr = lecture.reussi ? lirePr(lecture.run?.result ?? null) : null;

  useEffect(() => {
    if (lisible && topic.prNumber !== null) void lancer('pr.rafraichir');
  }, [lisible, topic.prNumber, lancer, version]);

  useEffect(() => {
    let vivant = true;
    fetchSubjectMemory(call, namespace, topic.slug).then(
      (pages) => vivant && setPage(pages.review ?? null),
      () => vivant && setPage(null),
    );
    return () => {
      vivant = false;
    };
  }, [call, namespace, topic.slug, version]);

  const source = page === undefined ? null : sourceRevue(page, pr?.reviews ?? []);
  const revue = source?.commit && SHA.test(source.commit) ? source.commit : null;

  useEffect(() => {
    if (!lisible || page === undefined) return;
    let vivant = true;
    fetchLivraison(call, topic.id, revue ?? undefined).then(
      (g) => {
        if (!vivant) return;
        setGit({ g, pour: revue });
        setErreurGit(null);
      },
      (err: unknown) => vivant && setErreurGit(message(err)),
    );
    return () => {
      vivant = false;
    };
  }, [call, topic.id, revue, lisible, page, version]);

  const verif = git && git.pour === revue ? (git.g.revue ?? null) : null;
  const enLecture = lisible && (page === undefined || (revue !== null && verif === null));
  return {
    pr,
    lecturePr: { enCours: lecture.enCours, echec: lecture.echec },
    git: git?.g ?? null,
    erreurGit,
    test: dernierTest(state?.actions ?? [], topic.id),
    page,
    source,
    fraicheur: enLecture ? null : fraicheurRevue(source, verif),
    relire: () => setVersion((v) => v + 1),
  };
}

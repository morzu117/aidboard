import { useEffect, useRef, useState } from 'react';
import type { MemoryPage } from '../../../src/shared/memory.js';
import { fetchSubjectMemory, type MemoryKind } from '../data/memory.js';
import { useAid } from '../data/useAidState.js';
import { Memoire } from '../ui/Memoire.js';
import { mostUrgent } from '../ui/Statut.js';
import { useAgentRoutes } from '../conversation/routes.js';
import { OngletArtefacts } from './OngletArtefacts.js';
import { OngletLivraison } from './OngletLivraison.js';
import { OngletFichiers } from './OngletFichiers.js';
import { OngletGit } from './OngletGit.js';

type OngletId =
  'plan' | 'git' | 'fichiers' | 'artefacts' | 'livraison' | 'review' | 'retro' | 'dev-handoff';

const ONGLETS_FIXES: Array<{ id: OngletId; label: string }> = [
  // chantier 26 (D119) : l'onglet du sujet ; son id et son data-node restent `plan`
  { id: 'plan', label: 'Sujet' },
  { id: 'git', label: 'Git' },
  { id: 'fichiers', label: 'Fichiers' },
  // chantier 30 (D167) : HTML, Markdown et SVG produits par l'agent
  { id: 'artefacts', label: 'Artefacts' },
  // chantier 27 (D133) : le résumé de l'écran Livraison
  { id: 'livraison', label: 'Livraison' },
];
// Q3 (chantier 15) : Revue/Rétro/Passation n'apparaissent que si leur page mémoire existe.
const ONGLETS_MEMOIRE: Array<{ id: OngletId; label: string; kind: MemoryKind }> = [
  { id: 'review', label: 'Revue', kind: 'review' },
  { id: 'retro', label: 'Rétro', kind: 'retro' },
  { id: 'dev-handoff', label: 'Passation', kind: 'dev-handoff' },
];
const DATA_NODE: Record<OngletId, string> = {
  plan: '1-3.onglets.plan',
  git: '1-3.onglets.git',
  fichiers: '1-3.onglets.fichiers',
  artefacts: '1-3.onglets.artefacts',
  livraison: '1-3.onglets.livraison',
  review: '1-3.onglets.revue',
  retro: '1-3.onglets.retro',
  'dev-handoff': '1-3.onglets.passation',
};

// D.2 (chantier 15) : panneau droit de l'écran Sujet, onglets Plan/Git/Fichiers fixes,
// Revue/Rétro/Passation ajoutés seulement quand leur page mémoire existe pour le sujet.
export function PanneauContexte({
  namespace,
  topicSlug,
  topicId,
  base,
  remote,
  activeAgentId,
  initialOnglet,
  onVoirAgent,
}: {
  namespace: string;
  topicSlug: string;
  topicId: string;
  base: string;
  remote: string | null;
  activeAgentId: string | null;
  initialOnglet?: 'git' | 'fichiers' | 'review';
  /** Chantier 26 (D119) : « Voir la question » sélectionne l'onglet de cet agent. */
  onVoirAgent?: (agentId: string) => void;
}) {
  const { state, call } = useAid();
  const [pages, setPages] = useState<Partial<Record<MemoryKind, MemoryPage>> | null>(null);
  const [onglet, setOnglet] = useState<OngletId>(initialOnglet ?? 'plan');
  const refs = useRef<Partial<Record<OngletId, HTMLButtonElement | null>>>({});
  // review D (finding 1, re-dev) : savoir si le focus est dans le panneau avant d'y toucher.
  const panneauRef = useRef<HTMLElement | null>(null);
  // review D (finding 5) : compte les replis involontaires sur Plan (onglet disparu) pour que
  // l'effet de focus plus bas ne se déclenche que sur ceux-ci, pas sur une sélection normale.
  const [repli, setRepli] = useState(0);
  // chantier 30 (D168) : le fichier que « Ouvrir dans Artefacts » a choisi dans Fichiers
  const [artefactDemande, setArtefactDemande] = useState<string | null>(null);
  // D167 : pas d'onglet Artefacts pour un agent distant, son worktree n'est pas sur ce daemon
  const { distant } = useAgentRoutes();

  // review D (finding 4) : au changement de sujet, vider les pages pendant le rendu (avant la
  // requête suivante) — sinon les onglets Revue/Rétro/Passation de l'ancien sujet restent
  // affichés jusqu'à ce que la requête du nouveau sujet réponde.
  const clePages = `${namespace}/${topicSlug}`;
  const [cleChargee, setCleChargee] = useState(clePages);
  if (clePages !== cleChargee) {
    setCleChargee(clePages);
    setPages(null);
    setArtefactDemande(null);
  }

  useEffect(() => {
    let cancelled = false;
    fetchSubjectMemory(call, namespace, topicSlug)
      .then((p) => {
        if (!cancelled) setPages(p);
      })
      .catch(() => {
        if (!cancelled) setPages({});
      });
    return () => {
      cancelled = true;
    };
    // même motif que Memoire.tsx : `call` change d'identité à chaque rendu, le suivre ici
    // redéclencherait la lecture à l'infini.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespace, topicSlug, state]);

  // D119 : la question en attente la plus urgente du sujet, un shell compris
  const runIds = (state?.runs ?? []).filter((r) => r.topicId === topicId).map((r) => r.id);
  const decision = mostUrgent(
    (state?.agents ?? []).filter((a) => runIds.includes(a.runId) && a.pending),
  );

  const onglets = [
    ...ONGLETS_FIXES.filter((o) => o.id !== 'artefacts' || !distant),
    ...ONGLETS_MEMOIRE.filter((o) => pages?.[o.kind] !== undefined),
  ];
  const ids = onglets.map((o) => o.id);
  // l'onglet mémoire sélectionné peut disparaître (page retirée ailleurs) : repli sur Plan,
  // pendant le rendu (même motif que la réinitialisation des pages plus haut).
  // Chantier 27 (D131) : pas avant que les pages soient lues, sinon ?onglet=review retombe sur Plan.
  if (pages !== null && onglet !== 'plan' && !ids.includes(onglet)) {
    setOnglet('plan');
    setRepli((n) => n + 1);
  }
  const actif = ids.includes(onglet) ? onglet : 'plan';

  // review D (finding 5) : le repli ci-dessus laisse le focus sur un bouton qui vient de
  // quitter le DOM — le ramener sur Plan, mais seulement pour un repli (pas une sélection
  // normale de l'onglet Plan, où allerVers gère déjà le focus lui-même).
  // review D (finding 1, re-dev) : un repli déclenché par un changement de sujet ne doit pas
  // voler le focus à l'extérieur du panneau (champ de saisie, terminal) — seulement le ramener
  // s'il est déjà perdu (body/null) ou déjà dans le panneau (motif ci-dessus).
  useEffect(() => {
    if (repli === 0) return;
    const actif = document.activeElement;
    const perdu = actif === null || actif === document.body;
    const dansLePanneau = !!panneauRef.current && panneauRef.current.contains(actif);
    if (perdu || dansLePanneau) refs.current.plan?.focus();
  }, [repli]);

  function allerVers(id: OngletId) {
    setOnglet(id);
    refs.current[id]?.focus();
  }

  function onTablistKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = ids.indexOf(actif);
    const suivant =
      e.key === 'ArrowRight' ? ids[(i + 1) % ids.length] : ids[(i - 1 + ids.length) % ids.length];
    allerVers(suivant!);
  }

  return (
    <aside
      className="panneau-contexte"
      data-node="1-3.panneau"
      aria-label="Panneau du sujet"
      ref={panneauRef}
    >
      <div
        className="onglets"
        data-node="1-3.onglets"
        role="tablist"
        aria-label="Onglets du panneau"
        onKeyDown={onTablistKeyDown}
      >
        {onglets.map(({ id, label }) => (
          <button
            key={id}
            ref={(el) => {
              refs.current[id] = el;
            }}
            className={`onglet${id === actif ? ' est-actif' : ''}`}
            data-node={DATA_NODE[id]}
            data-action="panneau.onglet"
            role="tab"
            id={`panneau-tab-${id}`}
            aria-selected={id === actif}
            aria-controls={id === actif ? `panneau-tabpanel-${id}` : undefined}
            tabIndex={id === actif ? 0 : -1}
            type="button"
            onClick={() => allerVers(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        className="panneau-contenu"
        data-node="1-3.panneau.contenu"
        role="tabpanel"
        id={`panneau-tabpanel-${actif}`}
        aria-labelledby={`panneau-tab-${actif}`}
        tabIndex={0}
      >
        {actif === 'plan' && (
          <>
            <section
              className="sujet-decision"
              data-node="1-3.panneau.decision"
              aria-label="Prochaine décision"
            >
              <p className="sujet-decision-titre">Prochaine décision</p>
              {decision?.pending ? (
                <>
                  <p className="sujet-decision-question" data-node="1-3.panneau.decision.question">
                    {decision.pending.question}
                  </p>
                  {onVoirAgent && (
                    <button
                      className="bouton bouton--fantome"
                      data-node="1-3.panneau.decision.voir"
                      data-action="agent.voir-question"
                      type="button"
                      onClick={() => onVoirAgent(decision.id)}
                    >
                      Voir la question
                    </button>
                  )}
                </>
              ) : (
                <p className="texte-discret" data-node="1-3.panneau.decision.aucune">
                  Aucune décision en attente
                </p>
              )}
            </section>
            <Memoire
              only="plan"
              namespace={namespace}
              topicSlug={topicSlug}
              emptyMessage="Plan pas encore écrit"
            />
          </>
        )}
        {actif === 'git' && <OngletGit topicId={topicId} base={base} remote={remote} />}
        {actif === 'fichiers' && (
          <OngletFichiers
            topicId={topicId}
            activeAgentId={activeAgentId}
            onOuvrirArtefact={
              distant
                ? undefined
                : (path) => {
                    setArtefactDemande(path);
                    allerVers('artefacts');
                  }
            }
          />
        )}
        {actif === 'artefacts' && (
          <OngletArtefacts topicId={topicId} initialPath={artefactDemande} />
        )}
        {actif === 'livraison' && <OngletLivraison topicId={topicId} namespace={namespace} />}
        {actif === 'review' && (
          <Memoire only="review" namespace={namespace} topicSlug={topicSlug} />
        )}
        {actif === 'retro' && <Memoire only="retro" namespace={namespace} topicSlug={topicSlug} />}
        {actif === 'dev-handoff' && (
          <Memoire only="dev-handoff" namespace={namespace} topicSlug={topicSlug} />
        )}
      </div>
    </aside>
  );
}

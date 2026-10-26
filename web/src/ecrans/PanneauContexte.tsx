import { useEffect, useRef, useState } from 'react';
import type { MemoryPage } from '../../../src/shared/memory.js';
import { fetchSubjectMemory, type MemoryKind } from '../data/memory.js';
import { useAid } from '../data/useAidState.js';
import { Memoire } from '../ui/Memoire.js';
import { OngletFichiers } from './OngletFichiers.js';
import { OngletGit } from './OngletGit.js';

type OngletId = 'plan' | 'git' | 'fichiers' | 'review' | 'retro' | 'dev-handoff';

const ONGLETS_FIXES: Array<{ id: OngletId; label: string }> = [
  { id: 'plan', label: 'Plan' },
  { id: 'git', label: 'Git' },
  { id: 'fichiers', label: 'Fichiers' },
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
}: {
  namespace: string;
  topicSlug: string;
  topicId: string;
  base: string;
  remote: string | null;
  activeAgentId: string | null;
  initialOnglet?: 'git' | 'fichiers';
}) {
  const { state, call } = useAid();
  const [pages, setPages] = useState<Partial<Record<MemoryKind, MemoryPage>> | null>(null);
  const [onglet, setOnglet] = useState<OngletId>(initialOnglet ?? 'plan');
  const refs = useRef<Partial<Record<OngletId, HTMLButtonElement | null>>>({});

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

  const onglets = [
    ...ONGLETS_FIXES,
    ...ONGLETS_MEMOIRE.filter((o) => pages?.[o.kind] !== undefined),
  ];
  const ids = onglets.map((o) => o.id);
  // l'onglet mémoire sélectionné peut disparaître (page retirée ailleurs) : repli sur Plan.
  const actif = ids.includes(onglet) ? onglet : 'plan';

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
    <aside className="panneau-contexte" data-node="1-3.panneau" aria-label="Panneau du sujet">
      <div
        className="onglets"
        data-node="1-3.onglets"
        role="tablist"
        aria-label="Panneau du sujet"
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
            aria-controls={`panneau-tabpanel-${id}`}
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
          <Memoire
            only="plan"
            namespace={namespace}
            topicSlug={topicSlug}
            emptyMessage="Plan pas encore écrit"
          />
        )}
        {actif === 'git' && <OngletGit topicId={topicId} base={base} remote={remote} />}
        {actif === 'fichiers' && <OngletFichiers topicId={topicId} activeAgentId={activeAgentId} />}
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

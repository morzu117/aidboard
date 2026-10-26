import { useEffect, useState } from 'react';
import type { MemoryPage, MemoryProposal, ProposalKind } from '../../../src/shared/memory.js';
import { AidApiError } from '../data/api.js';
import {
  applyProposal,
  fetchOpenProposals,
  fetchSubjectMemory,
  MEMORY_KIND_LABELS,
  MEMORY_KINDS,
  type MemoryKind,
  rejectProposal,
} from '../data/memory.js';
import { useAid } from '../data/useAidState.js';
import { depuis } from './depuis.js';

const PROPOSAL_KIND_LABELS: Record<ProposalKind, string> = {
  tags: 'Tags',
  duplicate: 'Doublon',
  split: 'Découpage',
};

function Propositions({ namespace, topicSlug }: { namespace: string; topicSlug: string }) {
  const { state, call } = useAid();
  const [proposals, setProposals] = useState<MemoryProposal[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchOpenProposals(call, namespace, topicSlug)
      .then((p) => {
        if (!cancelled) setProposals(p);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // `call` change d'identité à chaque rendu (useAid le reconstruit à chaque fois) : le suivre
    // ici redéclencherait la lecture à l'infini (nouvel objet retourné à chaque fetch).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespace, topicSlug, state]);

  async function decide(id: string, decision: 'apply' | 'reject') {
    setBusy(id);
    setErreur(null);
    try {
      await (decision === 'apply' ? applyProposal(call, id) : rejectProposal(call, id));
      setProposals((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      setErreur(err instanceof AidApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (proposals.length === 0) return null;

  return (
    <div className="memoire-propositions" data-node="1-3.memoire.propositions">
      {erreur && (
        <p className="message-erreur" role="alert">
          {erreur}
        </p>
      )}
      {proposals.map((p) => (
        <div
          key={p.id}
          className="memoire-proposition"
          data-node="1-3.memoire.proposition"
          data-bind="proposition"
        >
          <p className="texte-discret">
            <span className="pastille pastille--discret">{PROPOSAL_KIND_LABELS[p.kind]}</span>{' '}
            {p.rationale}
          </p>
          <div className="carte-actions">
            <button
              className="bouton bouton--contour"
              data-action="memoire.proposition.appliquer"
              type="button"
              disabled={busy === p.id}
              onClick={() => void decide(p.id, 'apply')}
            >
              Appliquer
            </button>
            <button
              className="bouton bouton--fantome"
              data-action="memoire.proposition.rejeter"
              type="button"
              disabled={busy === p.id}
              onClick={() => void decide(p.id, 'reject')}
            >
              Rejeter
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Memoire({
  namespace,
  topicSlug,
  only,
  emptyMessage,
}: {
  namespace: string;
  topicSlug: string;
  // D.2 (chantier 15) : affiche une seule phase, sans le sélecteur ni les propositions — pour
  // le panneau contextuel, qui porte déjà ses propres onglets (Plan/Revue/Rétro/Passation).
  only?: MemoryKind;
  emptyMessage?: string;
}) {
  const { state, call } = useAid();
  const [pages, setPages] = useState<Partial<Record<MemoryKind, MemoryPage>> | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [selected, setSelected] = useState<MemoryKind>(only ?? 'plan');

  useEffect(() => {
    let cancelled = false;
    fetchSubjectMemory(call, namespace, topicSlug)
      .then((p) => {
        if (!cancelled) {
          setPages(p);
          setErreur(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setErreur(err instanceof AidApiError ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // `state` change à chaque événement daemon (DM4) : on relit la mémoire avec, sans filtrer sur
    // memory.page précisément — un GET de plus par événement est sans conséquence. `call` change
    // d'identité à chaque rendu (useAid le reconstruit à chaque fois) : le suivre ici
    // redéclencherait la lecture à l'infini (nouvel objet retourné à chaque fetch).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespace, topicSlug, state]);

  const page = pages?.[only ?? selected];

  if (only) {
    return (
      <div className="memoire-page-seule" data-node="1-3.memoire.page-seule">
        {erreur && (
          <p className="message-erreur" role="alert" data-node="1-3.memoire.erreur">
            {erreur}
          </p>
        )}
        {!pages ? (
          <div className="squelette" data-node="1-3.memoire.squelette">
            <span className="sq sq--grand-bloc" />
          </div>
        ) : page ? (
          <div className="memoire-page" data-node="1-3.memoire.page">
            <p className="texte-discret" data-node="1-3.memoire.page.meta">
              révision {page.revision} · {depuis(page.updatedAt)}
            </p>
            <pre className="memoire-corps" data-node="1-3.memoire.page.corps">
              {page.body}
            </pre>
          </div>
        ) : (
          <p className="texte-faible" data-node="1-3.memoire.absente">
            {emptyMessage ?? 'pas encore écrite'}
          </p>
        )}
      </div>
    );
  }

  return (
    <section className="memoire" data-node="1-3.memoire" aria-label="Mémoire">
      <h2 className="titre-zone" data-node="1-3.memoire.titre">
        Mémoire
      </h2>
      <Propositions namespace={namespace} topicSlug={topicSlug} />
      <div className="memoire-onglets" role="tablist" aria-label="Phases">
        {MEMORY_KINDS.map((kind) => (
          <button
            key={kind}
            className={`onglet${kind === selected ? ' est-actif' : ''}`}
            data-node={`1-3.memoire.onglet-${kind}`}
            data-action="memoire.choisir"
            role="tab"
            aria-selected={kind === selected}
            type="button"
            onClick={() => setSelected(kind)}
          >
            {MEMORY_KIND_LABELS[kind]}
          </button>
        ))}
      </div>
      {erreur && (
        <p className="message-erreur" role="alert" data-node="1-3.memoire.erreur">
          {erreur}
        </p>
      )}
      {!pages ? (
        <div className="squelette" data-node="1-3.memoire.squelette">
          <span className="sq sq--grand-bloc" />
        </div>
      ) : page ? (
        <div className="memoire-page" data-node="1-3.memoire.page">
          <p className="texte-discret" data-node="1-3.memoire.page.meta">
            révision {page.revision} · {depuis(page.updatedAt)}
          </p>
          <pre className="memoire-corps" data-node="1-3.memoire.page.corps">
            {page.body}
          </pre>
        </div>
      ) : (
        <p className="texte-faible" data-node="1-3.memoire.absente">
          pas encore écrite
        </p>
      )}
    </section>
  );
}

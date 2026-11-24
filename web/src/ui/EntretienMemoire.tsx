import { useEffect, useState } from 'react';
import type { MemoryProposal } from '../../../src/shared/memory.js';
import {
  applyProposal,
  fetchOpenLessonProposals,
  PROPOSAL_KIND_LABELS,
  rejectProposal,
} from '../data/memory.js';
import { useAidClient } from '../data/useAidState.js';

const RACINE = '1-2.liste.groupe-entretien-memoire';

function apercu({ kind, payload }: MemoryProposal): string {
  switch (kind) {
    case 'tags':
      return (payload as { tags: string[] }).tags.join(', ');
    case 'duplicate':
      return (payload as { duplicateOf: string }).duplicateOf;
    case 'split':
      return (payload as { pages: { title: string }[] }).pages.map((page) => page.title).join(', ');
    case 'retro':
      return (payload as { lecons: { slug: string }[] }).lecons
        .map((lecon) => lecon.slug)
        .join(', ');
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function EntretienMemoire() {
  const client = useAidClient();
  const [propositions, setPropositions] = useState<MemoryProposal[]>([]);
  const [erreurLecture, setErreurLecture] = useState<string | null>(null);
  const [erreurDecision, setErreurDecision] = useState<{
    proposition: MemoryProposal;
    message: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let actif = true;
    void fetchOpenLessonProposals(client.request.bind(client)).then(
      (liste) => {
        if (actif) setPropositions(liste);
      },
      (err: unknown) => {
        if (actif) setErreurLecture(message(err));
      },
    );
    return () => {
      actif = false;
    };
  }, [client]);

  const decider = async (proposition: MemoryProposal, decision: 'apply' | 'reject') => {
    const call = client.request.bind(client);
    setBusy(true);
    setErreurDecision(null);
    try {
      await (decision === 'apply' ? applyProposal : rejectProposal)(call, proposition.id);
      setPropositions((liste) => liste.filter((p) => p.id !== proposition.id));
    } catch (err) {
      setErreurDecision({ proposition, message: message(err) });
    }
    try {
      setPropositions(await fetchOpenLessonProposals(call));
      setErreurLecture(null);
    } catch (err) {
      setErreurLecture(message(err));
    } finally {
      setBusy(false);
    }
  };

  const erreurHorsListe =
    erreurDecision && !propositions.some((p) => p.id === erreurDecision.proposition.id);
  return (
    <>
      {(propositions.length > 0 || erreurLecture) && (
        <section
          className="groupe boite-section"
          data-node={RACINE}
          aria-label="Entretien de la mémoire"
        >
          <div className="groupe-entete">
            <h2 className="titre-zone boite-section-titre" data-node={`${RACINE}.titre`}>
              Entretien de la mémoire
            </h2>
          </div>
          {erreurLecture && (
            <p className="message-erreur" role="alert">
              Lecture des propositions impossible. {erreurLecture}
            </p>
          )}
          {propositions.map((p) => {
            const id = `${RACINE}.proposition-${p.id}`;
            return (
              <article
                className="element"
                key={p.id}
                data-node={id}
                style={{ overflowWrap: 'anywhere' }}
              >
                <div className="element-entete">
                  <span className="badge">{PROPOSAL_KIND_LABELS[p.kind]}</span>
                  <span>{p.slug}</span>
                </div>
                <p className="element-detail">{p.rationale}</p>
                <p className="element-detail">{apercu(p)}</p>
                <div className="element-actions">
                  <button
                    className="bouton bouton--primaire"
                    type="button"
                    data-node={`${id}.appliquer`}
                    disabled={busy}
                    onClick={() => void decider(p, 'apply')}
                  >
                    Appliquer
                  </button>
                  <button
                    className="bouton"
                    type="button"
                    data-node={`${id}.rejeter`}
                    disabled={busy}
                    onClick={() => void decider(p, 'reject')}
                  >
                    Rejeter
                  </button>
                </div>
                {erreurDecision?.proposition.id === p.id && (
                  <p className="message-erreur" role="alert">
                    {erreurDecision.message}
                  </p>
                )}
              </article>
            );
          })}
        </section>
      )}
      {erreurHorsListe && (
        <p className="message-erreur" role="alert" style={{ overflowWrap: 'anywhere' }}>
          {erreurDecision.proposition.slug} · {erreurDecision.message}
        </p>
      )}
    </>
  );
}

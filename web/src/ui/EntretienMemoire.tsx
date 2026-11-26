import { useEffect, useState } from 'react';
import type { RetroPayload } from '../../../src/daemon/memory/retro.js';
import { parseMarkdown } from '../../../src/shared/memory-markdown.js';
import type { MemoryProposal } from '../../../src/shared/memory.js';
import {
  applyProposal,
  fetchOpenMaintenanceProposals,
  PROPOSAL_KIND_LABELS,
  rejectProposal,
} from '../data/memory.js';
import { useAidClient } from '../data/useAidState.js';

const RACINE = '1-2.liste.groupe-entretien-memoire';

function apercu({ kind, payload }: MemoryProposal): string | undefined {
  switch (kind) {
    case 'tags':
      return (payload as { tags: string[] }).tags.join(', ');
    case 'duplicate':
      return (payload as { duplicateOf: string }).duplicateOf;
    case 'split':
      return (payload as { pages: { title: string }[] }).pages.map((page) => page.title).join(', ');
  }
}

function PropositionRetro({
  payload,
  id,
  busy,
}: {
  payload: RetroPayload;
  id: string;
  busy: boolean;
}) {
  const { retro, lecons, sources } = payload;
  return (
    <>
      <p className="element-detail">
        lu : {sources.pages.length} pages, {sources.actions} actions, {sources.reprises} reprises
      </p>
      <p
        className="element-detail"
        data-testid={`${id}.retro`}
        style={{ maxHeight: '12rem', overflowY: 'auto', whiteSpace: 'pre-wrap' }}
      >
        {parseMarkdown(retro.text).body}
      </p>
      {lecons.map(({ slug, text }, index) => {
        const { title, body } = parseMarkdown(text);
        const leconId = `${id}.lecon-${index + 1}`;
        return (
          <div className="element-detail" key={slug}>
            <label>
              <input
                type="checkbox"
                name="lecons"
                value={slug}
                defaultChecked
                disabled={busy}
                data-node={`${leconId}.garder`}
                data-testid={`${leconId}.garder`}
              />{' '}
              {slug} · {title}
            </label>
            <details>
              <summary data-node={`${leconId}.corps`} data-testid={`${leconId}.corps`}>
                Voir le texte
              </summary>
              <p style={{ whiteSpace: 'pre-wrap' }}>{body}</p>
            </details>
          </div>
        );
      })}
    </>
  );
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
    void fetchOpenMaintenanceProposals(client.request.bind(client)).then(
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

  const decider = async (
    proposition: MemoryProposal,
    decision: 'apply' | 'reject',
    body?: { lecons: string[] },
  ) => {
    const call = client.request.bind(client);
    setBusy(true);
    setErreurDecision(null);
    try {
      if (decision === 'apply') await applyProposal(call, proposition.id, body);
      else await rejectProposal(call, proposition.id);
      setPropositions((liste) => liste.filter((p) => p.id !== proposition.id));
    } catch (err) {
      setErreurDecision({ proposition, message: message(err) });
    }
    try {
      setPropositions(await fetchOpenMaintenanceProposals(call));
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
            const retro = p.kind === 'retro' ? (p.payload as RetroPayload) : null;
            return (
              <article
                className="element"
                key={p.id}
                data-node={id}
                data-testid={id}
                style={{ overflowWrap: 'anywhere' }}
              >
                <div className="element-entete">
                  <span className="badge">{PROPOSAL_KIND_LABELS[p.kind]}</span>
                  <span>{retro ? `Rétro de ${p.slug.split('/').slice(2).join('/')}` : p.slug}</span>
                </div>
                <p className="element-detail">{p.rationale}</p>
                {retro ? (
                  <form
                    id={id}
                    style={{ display: 'contents' }}
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (busy) return;
                      const lecons = new FormData(event.currentTarget).getAll('lecons').map(String);
                      void decider(p, 'apply', { lecons });
                    }}
                  >
                    <PropositionRetro payload={retro} id={id} busy={busy} />
                  </form>
                ) : (
                  <p className="element-detail">{apercu(p)}</p>
                )}
                <div className="element-actions">
                  <button
                    className="bouton bouton--primaire"
                    type={retro ? 'submit' : 'button'}
                    form={retro ? id : undefined}
                    data-node={`${id}.appliquer`}
                    disabled={busy}
                    onClick={retro ? undefined : () => void decider(p, 'apply')}
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

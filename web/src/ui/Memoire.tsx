import { useEffect, useState } from 'react';
import type { MemoryPage } from '../../../src/shared/memory.js';
import { AidApiError } from '../data/api.js';
import {
  fetchSubjectMemory,
  MEMORY_KIND_LABELS,
  MEMORY_KINDS,
  type MemoryKind,
} from '../data/memory.js';
import { useAid } from '../data/useAidState.js';
import { depuis } from './depuis.js';

export function Memoire({ namespace, topicSlug }: { namespace: string; topicSlug: string }) {
  const { state, call } = useAid();
  const [pages, setPages] = useState<Partial<Record<MemoryKind, MemoryPage>> | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [selected, setSelected] = useState<MemoryKind>('plan');

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
    // memory.page précisément — un GET de plus par événement est sans conséquence.
  }, [call, namespace, topicSlug, state]);

  const page = pages?.[selected];

  return (
    <section className="memoire" data-node="1-3.memoire" aria-label="Mémoire">
      <h2 className="titre-zone" data-node="1-3.memoire.titre">
        Mémoire
      </h2>
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

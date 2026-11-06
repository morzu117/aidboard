import { useState } from 'react';
import { court } from '../ui/livraisonVue.js';
import { Dialogue } from './Dialogue.js';

// Chantier 27 (D128) : la confirmation du merge, sur le Mac. Elle nomme la tête et cite ce qui ne bloque
// pas (D127). Le chantier 34 la remplacera par la demande au téléphone.

export type Strategie = 'merge' | 'squash' | 'rebase';

export interface ChoixMerge {
  strategy: Strategie;
  deleteBranch: boolean;
  cleanupAfter: boolean;
}

const STRATEGIES: Array<{ id: Strategie; label: string }> = [
  { id: 'merge', label: 'Merge commit' },
  { id: 'squash', label: 'Squash' },
  { id: 'rebase', label: 'Rebase' },
];

export function ConfirmerMerge({
  tete,
  base,
  citations,
  enCours,
  onConfirmer,
  onClose,
}: {
  tete: string;
  base: string;
  citations: string[];
  enCours: boolean;
  onConfirmer: (choix: ChoixMerge) => void;
  onClose: () => void;
}) {
  const [strategy, setStrategy] = useState<Strategie>('merge');
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [cleanupAfter, setCleanupAfter] = useState(false);
  return (
    <Dialogue titre={`Fusionner ${court(tete)} dans ${base} ?`} onClose={onClose}>
      <form
        className="livraison-dialogue"
        data-node="livraison.confirmer-merge"
        onSubmit={(e) => {
          e.preventDefault();
          onConfirmer({ strategy, deleteBranch, cleanupAfter });
        }}
      >
        <p className="texte-discret">
          GitHub refusera si la tête de la PR n’est plus <code>{court(tete)}</code> au moment du
          merge.
        </p>
        {citations.length > 0 && (
          <div data-node="livraison.confirmer-merge.citations">
            <p>Ne bloque pas, mais à savoir :</p>
            <ul className="livraison-citations">
              {citations.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        )}
        <fieldset className="livraison-strategies" data-node="livraison.confirmer-merge.strategie">
          <legend>Stratégie</legend>
          {STRATEGIES.map((s) => (
            <label key={s.id} className="livraison-choix">
              <input
                type="radio"
                name="strategie"
                value={s.id}
                checked={strategy === s.id}
                onChange={() => setStrategy(s.id)}
              />
              {s.label}
            </label>
          ))}
        </fieldset>
        <label className="livraison-choix">
          <input
            type="checkbox"
            data-node="livraison.confirmer-merge.supprimer-branche"
            checked={deleteBranch}
            onChange={(e) => setDeleteBranch(e.target.checked)}
          />
          Supprimer la branche
        </label>
        <label className="livraison-choix">
          <input
            type="checkbox"
            data-node="livraison.confirmer-merge.nettoyer"
            checked={cleanupAfter}
            onChange={(e) => setCleanupAfter(e.target.checked)}
          />
          Nettoyer le sujet après
        </label>
        <div className="dialogue-actions">
          <button className="bouton bouton--fantome" type="button" onClick={onClose}>
            Annuler
          </button>
          <button
            className="bouton bouton--primaire"
            type="submit"
            data-node="livraison.confirmer-merge.valider"
            disabled={enCours}
          >
            {enCours ? 'Fusion…' : `Fusionner ${court(tete)}`}
          </button>
        </div>
      </form>
    </Dialogue>
  );
}

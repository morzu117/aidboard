import type { ReactNode } from 'react';

// Chantier 25 (D110) : le bandeau commun des états dégradés (planche Etats de la V4). Il dit ce qui s'est passé,
// ce qui marche encore et quoi faire. Le ton vient avec un libellé, jamais la couleur seule.

export type TonBandeau = 'neutre' | 'ambre' | 'rouge';

const LIBELLE_TON: Record<TonBandeau, string> = {
  neutre: 'Information',
  ambre: 'À surveiller',
  rouge: 'Bloqué',
};

export interface ActionBandeau {
  label: string;
  onClick: () => void;
  /** pendant l'action : bouton désactivé */
  enCours?: boolean;
}

export function Bandeau({
  ton,
  constat,
  continue: ceQuiContinue,
  action,
  node,
  children,
}: {
  ton: TonBandeau;
  /** ce qui s'est passé : « Board indisponible » */
  constat: string;
  /** ce qui marche encore */
  continue?: ReactNode;
  action?: ActionBandeau;
  node: string;
  /** détail sous le constat (dernière lecture, étape du test…) */
  children?: ReactNode;
}) {
  return (
    <div
      className={`bandeau bandeau--${ton}`}
      role={ton === 'neutre' ? 'status' : 'alert'}
      data-node={node}
      data-ton={ton}
    >
      <div className="bandeau-texte">
        <p className="bandeau-constat">
          <span className="bandeau-ton" data-node={`${node}.ton`}>
            {LIBELLE_TON[ton]}
          </span>{' '}
          <span data-node={`${node}.constat`}>{constat}</span>
        </p>
        {children && (
          <div className="texte-discret" data-node={`${node}.detail`}>
            {children}
          </div>
        )}
        {ceQuiContinue && (
          <p className="texte-faible" data-node={`${node}.continue`}>
            {ceQuiContinue}
          </p>
        )}
      </div>
      {action && (
        <button
          className="bouton bouton--contour"
          type="button"
          data-node={`${node}.action`}
          disabled={action.enCours}
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

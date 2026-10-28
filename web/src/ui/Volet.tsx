import { type ReactNode, useEffect, useRef } from 'react';
import type { EcranId } from './Barre.js';

// Q6 tranchée (chantier 15) : même élément en permanence, jamais démonté — seule sa
// présentation change (colonne normale ≥ 1280 px, pop-up dessous via CSS/attributs). Un
// démontage relancerait les requêtes de ses enfants et perdrait leur état. Partagé par
// Layout (volet « nav », B.2) et Sujet (volet « panneau ») : d'où le `screen` explicite.
export function Volet({
  screen,
  nom,
  titre,
  ouvert,
  inert,
  onFermer,
  boutonRef,
  children,
}: {
  screen: EcranId;
  nom: 'nav' | 'panneau';
  titre: string;
  ouvert: boolean;
  inert?: boolean;
  onFermer: () => void;
  boutonRef: { current: HTMLButtonElement | null };
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ouvert) ref.current?.focus();
  }, [ouvert]);
  useEffect(() => {
    if (!ouvert) return;
    // Capture (pas bubble) : Échap referme la pop-up avant que les raccourcis du fil de
    // conversation (ex. MarkMenu, en document.addEventListener) ne voient l'événement.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onFermer();
        boutonRef.current?.focus();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusables = ref.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const premier = focusables[0]!;
      const dernier = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === premier) {
        e.preventDefault();
        dernier.focus();
      } else if (!e.shiftKey && document.activeElement === dernier) {
        e.preventDefault();
        premier.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ouvert, onFermer, boutonRef]);
  return (
    <div
      ref={ref}
      className={`volet volet--${nom}${ouvert ? ' est-ouvert' : ''}`}
      data-node={`${screen}.volet.${nom}`}
      role={ouvert ? 'dialog' : undefined}
      aria-modal={ouvert || undefined}
      aria-label={ouvert ? titre : undefined}
      tabIndex={ouvert ? -1 : undefined}
      inert={inert || undefined}
    >
      {ouvert && (
        <button
          className="bouton-icone volet-fermer"
          data-node={`${screen}.volet.fermer`}
          type="button"
          aria-label="Fermer"
          onClick={() => {
            onFermer();
            boutonRef.current?.focus();
          }}
        >
          ×
        </button>
      )}
      {children}
    </div>
  );
}

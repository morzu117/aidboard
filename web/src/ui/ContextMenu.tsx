import { useEffect, useRef, useState } from 'react';

export interface MenuItem {
  id: string;
  label: string;
  onSelect?: () => void;
  disabled?: boolean;
  separatorBefore?: boolean;
  submenu?: MenuItem[];
  /** pastille de couleur affichée avant le libellé (menu Couleur) */
  swatch?: string;
}

/**
 * Menu flottant accessible (brief §2.4, §5.2.1) : `role="menu"`/`menuitem`, flèches haut/bas,
 * Entrée/Espace, Échap, clic extérieur. Sous-menu = liste secondaire dépliée sur place (pas de
 * positionnement flottant imbriqué), pour « Déplacer vers… » et « Couleur ».
 */
export function ContextMenu({
  items,
  label,
  onClose,
}: {
  items: MenuItem[];
  label: string;
  onClose: () => void;
}) {
  const [ouvert, setOuvert] = useState<string | null>(null);
  const racineRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const visibles: MenuItem[] = [];
  for (const it of items) {
    visibles.push(it);
    if (it.submenu && ouvert === it.id) visibles.push(...it.submenu);
  }

  useEffect(() => {
    const premier = visibles[0];
    if (premier) itemRefs.current.get(premier.id)?.focus();
    // focus initial seulement : ne pas re-déplacer le focus à chaque changement de sous-menu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (racineRef.current && !racineRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  const activer = (it: MenuItem) => {
    if (it.disabled) return;
    if (it.submenu) {
      setOuvert((cur) => (cur === it.id ? null : it.id));
      return;
    }
    it.onSelect?.();
    onClose();
  };

  const deplacerFocus = (depuisId: string, sens: 1 | -1) => {
    const i = visibles.findIndex((it) => it.id === depuisId);
    if (i === -1 || visibles.length === 0) return;
    const suivant = visibles[(i + sens + visibles.length) % visibles.length];
    if (suivant) itemRefs.current.get(suivant.id)?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent, it: MenuItem) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      deplacerFocus(it.id, 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      deplacerFocus(it.id, -1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activer(it);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Tab') {
      // pattern APG menu : Tab/Shift+Tab ferment le menu plutôt que d'en faire sortir le focus.
      e.preventDefault();
      onClose();
    }
  };

  const ligne = (it: MenuItem, sousNiveau: boolean) => (
    <button
      key={it.id}
      type="button"
      role="menuitem"
      ref={(el) => {
        if (el) itemRefs.current.set(it.id, el);
        else itemRefs.current.delete(it.id);
      }}
      className={`menu-contextuel-item${sousNiveau ? ' menu-contextuel-item--sous' : ''}${
        it.separatorBefore ? ' menu-contextuel-item--separe' : ''
      }`}
      aria-disabled={it.disabled || undefined}
      aria-haspopup={it.submenu ? 'menu' : undefined}
      aria-expanded={it.submenu ? ouvert === it.id : undefined}
      onClick={() => activer(it)}
      onKeyDown={(e) => onKeyDown(e, it)}
    >
      {it.swatch && (
        <span
          className="menu-contextuel-pastille"
          style={{ background: it.swatch }}
          aria-hidden="true"
        />
      )}
      {it.label}
    </button>
  );

  return (
    <div className="menu-contextuel" role="menu" aria-label={label} ref={racineRef}>
      {items.map((it) => (
        <div key={it.id}>
          {ligne(it, false)}
          {it.submenu && ouvert === it.id && (
            <div className="menu-contextuel-sous" role="menu" aria-label={`${it.label} — ${label}`}>
              {it.submenu.map((s) => ligne(s, true))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

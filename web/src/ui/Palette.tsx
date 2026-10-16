import { type KeyboardEvent, useMemo, useState } from 'react';

export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Les mots tapés doivent tous apparaître dans le libellé ou l'indice, sans tenir compte des accents. */
export function filterItems(items: PaletteItem[], query: string): PaletteItem[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return items.filter((i) => {
    const hay = fold(`${i.label} ${i.hint ?? ''}`);
    return words.every((w) => hay.includes(w));
  });
}

/** ⌘K / Ctrl+K, sauf dans un terminal : là, Ctrl+K efface la fin de ligne du shell. */
export function isPaletteShortcut(
  e: Pick<globalThis.KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'target'>,
) {
  if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey)) return false;
  return !(e.target instanceof Element && e.target.closest('.xterm'));
}

export function Palette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const shown = useMemo(() => filterItems(items, query), [items, query]);
  const current = Math.min(active, Math.max(shown.length - 1, 0));
  const run = (i: PaletteItem | undefined) => {
    if (!i) return;
    onClose();
    i.run();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') setActive((current + 1) % Math.max(shown.length, 1));
    else if (e.key === 'ArrowUp')
      setActive((current - 1 + shown.length) % Math.max(shown.length, 1));
    else if (e.key === 'Enter') run(shown[current]);
    else if (e.key === 'Escape') onClose();
    else return;
    e.preventDefault();
  };
  return (
    <div className="voile voile--haut" data-layer="overlay" onMouseDown={onClose}>
      <div
        className="dialogue palette"
        role="dialog"
        aria-modal="true"
        aria-label="Rechercher ou lancer une action"
        data-node="palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          className="champ"
          data-node="palette.champ"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-liste"
          aria-activedescendant={shown[current] ? `palette-${shown[current].id}` : undefined}
          aria-label="Rechercher un sujet ou une action"
          placeholder="Rechercher un sujet ou une action…"
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKey}
        />
        {shown.length === 0 ? (
          <p className="palette__vide" data-node="palette.vide">
            Aucun résultat.
          </p>
        ) : (
          <ul
            className="palette__liste"
            id="palette-liste"
            role="listbox"
            data-node="palette.liste"
          >
            {shown.map((i, n) => (
              <li
                key={i.id}
                id={`palette-${i.id}`}
                role="option"
                aria-selected={n === current}
                className={`palette__item${n === current ? ' est-choisi' : ''}`}
                data-node={`palette.${i.id}`}
                onMouseEnter={() => setActive(n)}
                onClick={() => run(i)}
              >
                <span>{i.label}</span>
                {i.hint && <span className="palette__indice">{i.hint}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

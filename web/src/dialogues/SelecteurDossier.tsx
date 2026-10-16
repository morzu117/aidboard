import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { FsListing } from '../../../src/shared/fs.js';
import { AidApiError } from '../data/api.js';
import { useAid } from '../data/useAidState.js';

/** Explorateur de dossiers servi par le daemon : un navigateur ne donne jamais le chemin absolu d'un dossier. */
export function SelecteurDossier({
  start,
  selected,
  onSelect,
}: {
  start?: string;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const { call } = useAid();
  const [listing, setListing] = useState<FsListing | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [goto, setGoto] = useState('');

  // Seule la dernière demande compte : une réponse arrivée en retard (le premier chargement, par exemple) ne doit pas
  // écraser un dossier choisi ou un chemin tapé depuis.
  const latest = useRef(0);
  // un chemin tapé depuis la demande : la liste s'affiche, le champ garde la saisie
  const typed = useRef(false);
  const open = useCallback(
    (path: string | undefined, showHidden: boolean) => {
      const mine = ++latest.current;
      typed.current = false;
      const qs = new URLSearchParams();
      if (path) qs.set('path', path);
      if (showHidden) qs.set('hidden', 'true');
      call<FsListing>('GET', `/api/fs/dirs?${qs}`).then(
        (l) => {
          if (mine !== latest.current) return;
          setListing(l);
          if (!typed.current) setGoto(l.path);
          setError(null);
        },
        (err: unknown) => {
          if (mine !== latest.current) return;
          setError(err instanceof AidApiError ? err.message : String(err));
        },
      );
    },
    [call],
  );

  // le premier affichage seulement : changer `start` en cours de route ne doit pas arracher l'utilisateur à son dossier
  useEffect(() => {
    open(start, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // pas de <form> ici : le sélecteur vit dans le formulaire du dialogue, et un <form> imbriqué est supprimé par le navigateur
  // (Entrée enregistrerait alors le dépôt au lieu de naviguer) ; jsdom, lui, ne le voit pas
  function submitGoto() {
    open(goto.trim() || undefined, hidden);
  }
  function onGotoKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    submitGoto();
  }

  return (
    <div className="selecteur-dossier" role="group" aria-label="Choisir le dossier du dépôt">
      <div className="selecteur-dossier__barre">
        <input
          className="champ"
          aria-label="Aller au dossier"
          value={goto}
          onChange={(e) => {
            typed.current = true;
            setGoto(e.target.value);
          }}
          onKeyDown={onGotoKey}
          spellCheck={false}
        />
        <button className="bouton" type="button" onClick={submitGoto}>
          Aller
        </button>
      </div>
      {error && (
        <p className="message-erreur" role="alert">
          {error}
        </p>
      )}
      <ul className="selecteur-dossier__liste" aria-label="Dossiers">
        {listing?.home && listing.path !== listing.home && (
          <li>
            <button
              type="button"
              className="selecteur-dossier__ligne"
              onClick={() => open(listing.home, hidden)}
            >
              <span aria-hidden>⌂</span> Dossier personnel
            </button>
          </li>
        )}
        {listing?.parent && (
          <li>
            <button
              type="button"
              className="selecteur-dossier__ligne"
              onClick={() => open(listing.parent!, hidden)}
            >
              <span aria-hidden>↑</span> Dossier parent
            </button>
          </li>
        )}
        {listing?.entries.map((e) => (
          <li key={e.path} className="selecteur-dossier__item">
            <button
              type="button"
              className="selecteur-dossier__ligne"
              onClick={() => open(e.path, hidden)}
            >
              <span aria-hidden>{e.isRepo ? '◆' : '▸'}</span> {e.name}
              {e.isRepo && <span className="pastille pastille--code">dépôt git</span>}
            </button>
            {e.isRepo && (
              <button
                type="button"
                className="bouton bouton--contour"
                aria-label={`Choisir ${e.name}`}
                onClick={() => onSelect(e.path)}
              >
                Choisir
              </button>
            )}
          </li>
        ))}
        {listing && listing.entries.length === 0 && (
          <li className="selecteur-dossier__vide">Aucun sous-dossier.</li>
        )}
        {listing?.truncated && (
          <li className="selecteur-dossier__vide">
            Liste tronquée : utiliser « Aller au dossier ».
          </li>
        )}
      </ul>
      <label className="selecteur-dossier__cache">
        <input
          type="checkbox"
          checked={hidden}
          onChange={(e) => {
            setHidden(e.target.checked);
            if (listing) open(listing.path, e.target.checked);
          }}
        />
        Afficher les dossiers cachés
      </label>
      <div className="selecteur-dossier__choix">
        <button
          type="button"
          className={listing?.isRepo ? 'bouton bouton--primaire' : 'bouton'}
          disabled={!listing}
          onClick={() => listing && onSelect(listing.path)}
        >
          Choisir ce dossier
        </button>
        <span className="apercu-branche" data-selection>
          {selected ? `Dépôt choisi : ${selected}` : 'Aucun dossier choisi'}
        </span>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import type { Artefact, ArtefactsResponse, LienArtefact } from '../../../src/shared/artefacts.js';
import { AidApiError } from '../data/api.js';
import { demanderLien, fetchArtefacts } from '../data/artefacts.js';
import { fetchFileContent } from '../data/files.js';
import { useAid } from '../data/useAidState.js';
import { renderMarkdown } from '../ui/markdown.js';

type TypeArtefact = Artefact['type'];

/** Le type d'un chemin, comme la liste du daemon (D161) ; null hors de ces types. */
export function typeArtefact(path: string): TypeArtefact | null {
  const p = path.toLowerCase();
  if (p.endsWith('.md')) return 'md';
  if (p.endsWith('.svg')) return 'svg';
  if (p.endsWith('.html') || p.endsWith('.htm')) return 'html';
  return null;
}

const TYPE_LABEL: Record<TypeArtefact, string> = { html: 'HTML', md: 'Markdown', svg: 'SVG' };
const message = (err: unknown) => (err instanceof AidApiError ? err.message : String(err));
const heure = (iso: string | Date) =>
  new Date(iso).toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

interface Ligne {
  path: string;
  name: string;
  type: TypeArtefact;
  status: Artefact['status'] | '';
  modifieA: string | null;
}

type Vue =
  | { kind: 'md'; contenu: string; luA: Date }
  | { kind: 'cadre'; lien: LienArtefact; luA: Date; cle: number; ferme: boolean };

// Chantier 30 (D167) : l'onglet Artefacts. Le Markdown est rendu dans la page, comme Fichiers ;
// le HTML et le SVG passent par un cadre sandboxé, servi par le second port (une autre origine,
// sans cookie ni API). `initialPath` vient de « Ouvrir dans Artefacts » (D168).
export function OngletArtefacts({
  topicId,
  initialPath,
}: {
  topicId: string;
  initialPath?: string | null;
}) {
  const { call } = useAid();
  const [donnees, setDonnees] = useState<ArtefactsResponse | null>(null);
  const [listeErreur, setListeErreur] = useState<string | null>(null);
  const [selection, setSelection] = useState<string | null>(null);
  const [vue, setVue] = useState<Vue | null>(null);
  const [vueErreur, setVueErreur] = useState<string | null>(null);
  const [chargement, setChargement] = useState(false);
  const chargements = useRef(0);
  const demande = useRef(0);

  useEffect(() => {
    let annule = false;
    fetchArtefacts(call, topicId).then(
      (r) => {
        if (annule) return;
        setDonnees(r);
        setListeErreur(null);
      },
      (err: unknown) => {
        if (!annule) setListeErreur(message(err));
      },
    );
    return () => {
      annule = true;
    };
    // même motif que les autres onglets : `call` change d'identité à chaque rendu
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId]);

  const lignes: Ligne[] = (donnees?.artefacts ?? []).map((a) => ({ ...a }));
  // D161 : un fichier ouvert depuis Fichiers s'affiche, même sans statut git
  const typeInitial = initialPath ? typeArtefact(initialPath) : null;
  if (initialPath && typeInitial && !lignes.some((l) => l.path === initialPath)) {
    lignes.unshift({
      path: initialPath,
      name: initialPath.split('/').pop() ?? initialPath,
      type: typeInitial,
      status: '',
      modifieA: null,
    });
  }
  const etat = donnees?.etat ?? null;
  const choisie = lignes.find((l) => l.path === selection) ?? null;

  function ouvrir(ligne: Pick<Ligne, 'path' | 'type'>) {
    const n = ++demande.current;
    setSelection(ligne.path);
    setVueErreur(null);
    setChargement(true);
    setVue(null);
    if (ligne.type === 'md') {
      fetchFileContent(call, topicId, ligne.path).then(
        (r) => {
          if (n !== demande.current) return;
          setVue({ kind: 'md', contenu: r.content, luA: new Date() });
          setChargement(false);
        },
        (err: unknown) => {
          if (n !== demande.current) return;
          setVueErreur(message(err));
          setChargement(false);
        },
      );
      return;
    }
    if (etat && !etat.disponible) {
      setChargement(false);
      return;
    }
    demanderLien(call, topicId, ligne.path).then(
      (lien) => {
        if (n !== demande.current) return;
        chargements.current = 0;
        setVue({ kind: 'cadre', lien, luA: new Date(), cle: n, ferme: false });
        setChargement(false);
      },
      (err: unknown) => {
        if (n !== demande.current) return;
        setVueErreur(message(err));
        setChargement(false);
      },
    );
  }

  // D168 : arrivé depuis Fichiers, le fichier est ouvert dès que l'état du port est connu
  const ouvertInitial = useRef<string | null>(null);
  useEffect(() => {
    if (!initialPath || !typeInitial || !donnees || ouvertInitial.current === initialPath) return;
    ouvertInitial.current = initialPath;
    ouvrir({ path: initialPath, type: typeInitial });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPath, donnees]);

  // D167 (lab, MUST 1) : le cadre ne peut rien charger, mais il peut encore naviguer. Le premier
  // `load` est l'artefact ; au deuxième, il a quitté sa page, et l'onglet ferme le cadre. Cela limite
  // la fuite sans l'empêcher : la requête de la navigation est déjà partie.
  function surChargement() {
    chargements.current += 1;
    if (chargements.current >= 2) {
      setVue((v) => (v?.kind === 'cadre' ? { ...v, ferme: true } : v));
    }
  }

  const portIndisponible = etat !== null && !etat.disponible;
  const rendu = vue?.kind === 'md' ? renderMarkdown(vue.contenu) : null;

  return (
    <div className="artefacts" data-node="1-3.artefacts">
      {listeErreur && (
        <p className="message-erreur" role="alert">
          {listeErreur}
        </p>
      )}
      {portIndisponible && (
        <p className="pastille pastille--discret" data-node="1-3.artefacts.port" role="status">
          Port des artefacts {etat.port ?? ''} indisponible
          {etat.raison ? ` : ${etat.raison}` : ''}. Le HTML et le SVG ne s’affichent pas ; le
          Markdown reste lisible.
        </p>
      )}
      {donnees && lignes.length === 0 && (
        <p className="texte-discret" data-node="1-3.artefacts.vide">
          Aucun artefact sur ce sujet. Un agent en crée en écrivant un fichier .html, .md ou .svg.
        </p>
      )}
      {lignes.length > 0 && (
        <ul className="artefacts-liste" data-node="1-3.artefacts.liste" aria-label="Artefacts">
          {lignes.map((l) => (
            <li key={l.path}>
              <button
                type="button"
                className={`artefact${l.path === selection ? ' est-actif' : ''}`}
                data-action="artefacts.ouvrir"
                data-chemin={l.path}
                aria-current={l.path === selection || undefined}
                title={l.path}
                onClick={() => ouvrir(l)}
              >
                <span className="artefact-nom">{l.name}</span>
                <span className="artefact-type">{TYPE_LABEL[l.type]}</span>
                {l.status && (
                  <span className={`fichier-etat fichier-etat--${l.status.toLowerCase()}`}>
                    {l.status}
                  </span>
                )}
                {l.modifieA && (
                  <time className="artefact-heure texte-faible" dateTime={l.modifieA}>
                    {heure(l.modifieA)}
                  </time>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {choisie && (
        <section
          className="artefact-vue"
          data-node="1-3.artefacts.vue"
          aria-label={`Artefact ${choisie.name}`}
        >
          <div className="artefact-entete">
            <span className="fil-ariane">{choisie.path}</span>
            {vue && (
              <span className="texte-faible" data-node="1-3.artefacts.lu-a">
                Lu à {heure(vue.luA)}
              </span>
            )}
            <div className="actions">
              <button
                className="bouton"
                type="button"
                data-action="artefacts.recharger"
                disabled={chargement || (choisie.type !== 'md' && portIndisponible)}
                onClick={() => ouvrir(choisie)}
              >
                Recharger
              </button>
              {vue?.kind === 'cadre' && (
                <a
                  className="bouton"
                  data-action="artefacts.ouvrir-a-part"
                  href={vue.lien.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Ouvrir à part
                </a>
              )}
            </div>
          </div>
          {chargement && <p className="texte-discret">Chargement…</p>}
          {vueErreur && (
            <p className="message-erreur" role="alert">
              {vueErreur}
            </p>
          )}
          {rendu && (
            <article className="document" data-node="1-3.artefacts.document">
              {rendu.body}
            </article>
          )}
          {vue?.kind === 'cadre' && !vue.ferme && (
            <>
              <div className="artefact-cadre">
                {/* D164 et D167 : allow-scripts seul, jamais allow-same-origin ; le second port
                    pose aussi `sandbox` dans sa CSP, pour « Ouvrir à part » */}
                <iframe
                  key={vue.cle}
                  title={`Artefact ${choisie.name}`}
                  src={vue.lien.url}
                  sandbox="allow-scripts"
                  referrerPolicy="no-referrer"
                  data-node="1-3.artefacts.cadre"
                  onLoad={surChargement}
                />
              </div>
              <p className="texte-faible" data-node="1-3.artefacts.frontiere">
                Ni fetch, ni XHR, ni WebSocket : cet artefact ne charge rien. Il peut encore
                naviguer dans son propre cadre.
              </p>
            </>
          )}
          {vue?.kind === 'cadre' && vue.ferme && (
            <p className="message-erreur" role="status" data-node="1-3.artefacts.ferme">
              L’artefact a quitté sa page : cadre fermé. Recharger pour le rouvrir.
            </p>
          )}
        </section>
      )}
    </div>
  );
}

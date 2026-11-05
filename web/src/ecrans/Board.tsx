import { useEffect, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import type {
  BoardCardSummary,
  BoardErrorKind,
  BoardProject,
  BoardResult,
} from '../../../src/shared/board.js';
import { useBoardCards, useBoardProjects } from '../data/board.js';
import { useAid } from '../data/useAidState.js';
import { Layout } from '../ui/Layout.js';
import { useViewport } from '../ui/useViewport.js';

/**
 * Chantier 24 : le board swarph en lecture seule. Aucune écriture (pas de commentaire, pas de « Prendre ») ;
 * le contenu des pairs est toujours rendu en texte brut (D98) ; les colonnes suivent les `stage` reçus.
 */

type Action = 'retour' | 'relire' | 'doctor' | null;

/** Message et action de chaque erreur classée par le daemon (D95, spec Board « Messages »). */
export const MESSAGES_BOARD: Record<BoardErrorKind, { texte: string; action: Action }> = {
  forbidden: { texte: 'Tu ne peux pas lire cette carte', action: 'retour' },
  unreachable: { texte: 'Le gateway ne répond pas', action: 'relire' },
  'too-old': { texte: 'Mets à jour swarph', action: 'doctor' },
  absent: { texte: 'Swarph est introuvable', action: 'doctor' },
  credential: { texte: 'Swarph ne trouve pas l’identifiant de cette cell', action: 'doctor' },
  timeout: { texte: 'Le board met trop de temps à répondre', action: 'relire' },
  format: { texte: 'Réponse du board illisible', action: null },
  // un fil de 1000 messages peut dépasser le tampon : relire ne changerait rien (D95 bis)
  'too-large': { texte: 'Trop volumineux pour être affiché (plus de 4 Mo)', action: null },
  unknown: { texte: 'Lecture du board impossible', action: 'relire' },
};

export function MessageBoard({
  kind,
  node,
  onRelire,
}: {
  kind: BoardErrorKind;
  node: string;
  onRelire: () => void;
}) {
  // un kind que cette version ne connaît pas se lit comme `unknown` (D96)
  const m = MESSAGES_BOARD[kind] ?? MESSAGES_BOARD.unknown;
  return (
    <div className="board-message" role="alert" data-node={node} data-kind={kind}>
      <p className="board-message-texte">{m.texte}</p>
      {m.action === 'retour' && (
        <Link className="bouton" to="/board" data-node={`${node}.retour`}>
          Retour au board
        </Link>
      )}
      {m.action === 'relire' && (
        <button className="bouton" type="button" data-node={`${node}.relire`} onClick={onRelire}>
          Relire
        </button>
      )}
      {m.action === 'doctor' && (
        <p className="texte-discret" data-node={`${node}.doctor`}>
          Lance <code>aid doctor</code> dans un terminal.
        </p>
      )}
    </div>
  );
}

/** Secondes écoulées depuis `iso`, relues toutes les secondes. */
function useAge(iso: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : Math.max(0, Math.round((now - at) / 1000));
}

export const ageTexte = (s: number) =>
  s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;

export function PastilleLecture({
  enLecture,
  luA,
  node,
}: {
  enLecture: boolean;
  luA: string | null;
  node: string;
}) {
  const age = useAge(luA);
  return (
    <span className="board-pastille" data-node={node} aria-live="polite">
      <span className={`point point--${enLecture ? 'attente' : 'ok'}`} aria-hidden="true" />
      {enLecture ? 'Lecture du board…' : age !== null ? `Board lu il y a ${ageTexte(age)}` : ''}
    </span>
  );
}

const SANS_ETAPE = '(sans étape)';

/** Les colonnes dans l'ordre où les `stage` apparaissent dans la réponse ; jamais une liste fixe. */
export function colonnes(cards: BoardCardSummary[]): Array<[string, BoardCardSummary[]]> {
  const par = new Map<string, BoardCardSummary[]>();
  for (const c of cards) {
    const s = c.stage ?? SANS_ETAPE;
    const l = par.get(s);
    if (l) l.push(c);
    else par.set(s, [c]);
  }
  return [...par];
}

function CarteResume({ c, slug }: { c: BoardCardSummary; slug: string }) {
  return (
    <li>
      <Link
        className="board-carte"
        to={`/board/cartes/${c.id}`}
        data-node={`board.carte-${c.id}`}
        data-action="board.carte.ouvrir"
      >
        <span className="board-carte-ref">
          {slug} · #{c.id}
        </span>
        <span className="board-carte-titre">{c.title ?? 'sans titre'}</span>
        <span className="board-carte-meta">
          <span>{c.assignee ?? 'sans responsable'}</span>
          <span>{c.dueAt ? `échéance ${c.dueAt.slice(0, 10)}` : 'sans échéance'}</span>
          {c.openObligations > 0 && (
            <span>
              {c.openObligations} obligation{c.openObligations > 1 ? 's' : ''} ouverte
              {c.openObligations > 1 ? 's' : ''}
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}

function Cartes({
  projet,
  onLecture,
}: {
  projet: BoardProject;
  onLecture: (l: { enLecture: boolean; luA: string | null; relire: () => void }) => void;
}) {
  const { result, enLecture, luA, erreur, relire } = useBoardCards(projet.id);
  const viewport = useViewport();
  const [choisie, setChoisie] = useState<string | null>(null);
  useEffect(() => onLecture({ enLecture, luA, relire: () => void relire() }), [enLecture, luA]); // eslint-disable-line react-hooks/exhaustive-deps
  // retirées en pleine lecture (projets relus en erreur) : le parent ne garde pas « Lecture du board… », mais garde
  // la relecture fraîche des cartes, sans quoi elles retombent à leur retour sur l'erreur gardée 5 s par le daemon
  useEffect(
    () => () => onLecture({ enLecture: false, luA: null, relire: () => void relire() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const slug = projet.slug ?? String(projet.id);
  if (erreur && !result)
    return (
      <p className="message-erreur" role="alert" data-node="board.cartes.erreur">
        {erreur}
      </p>
    );
  if (!result) return null;
  if (!result.ok)
    return <MessageBoard kind={result.kind} node="board.cartes.message" onRelire={relire} />;
  const cols = colonnes(result.data);
  if (cols.length === 0)
    return (
      <p className="texte-discret" data-node="board.cartes.vide">
        Aucune carte dans ce projet.
      </p>
    );
  // petite largeur : une colonne à la fois
  const etroit = viewport === 'phone';
  const visible = etroit ? (cols.find(([s]) => s === choisie) ?? cols[0]!) : null;
  return (
    <div className="board-colonnes-zone">
      {etroit && (
        <div className="board-onglets" role="tablist" data-node="board.onglets">
          {cols.map(([s, l]) => (
            <button
              key={s}
              className={`board-onglet${s === visible![0] ? ' est-actif' : ''}`}
              role="tab"
              aria-selected={s === visible![0]}
              type="button"
              onClick={() => setChoisie(s)}
            >
              {s} <span className="compteur">{l.length}</span>
            </button>
          ))}
        </div>
      )}
      <div className={`board-colonnes${etroit ? ' board-colonnes--une' : ''}`}>
        {(etroit ? [visible!] : cols).map(([s, l]) => (
          <section className="board-colonne" key={s} data-node={`board.colonne-${s}`}>
            {/* en petite largeur, l'onglet actif tient lieu de titre */}
            {!etroit && (
              <h2 className="board-colonne-titre">
                {s} <span className="compteur">{l.length}</span>
              </h2>
            )}
            <ul className="board-cartes">
              {l.map((c) => (
                <CarteResume key={c.id} c={c} slug={slug} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function Contenu({ cell }: { cell: string }) {
  const projets = useBoardProjects();
  const [params, setParams] = useSearchParams();
  const [cartes, setCartes] = useState<{
    enLecture: boolean;
    luA: string | null;
    relire: () => void;
  } | null>(null);
  const r: BoardResult<BoardProject[]> | null = projets.result;
  const liste = r?.ok ? r.data : [];
  const voulu = Number(params.get('projet'));
  const projet = liste.find((p) => p.id === voulu) ?? liste[0] ?? null;
  const enLecture = projets.enLecture || (cartes?.enLecture ?? false);
  const luA = cartes?.luA ?? projets.luA;
  // projets et cartes ensemble, aussi depuis le message d'erreur : sinon les cartes, relues sans fresh à leur
  // retour, retombent sur l'erreur gardée 5 s par le daemon
  const relire = () => {
    void projets.relire();
    cartes?.relire();
  };
  return (
    <main className="page board" data-node="board">
      <div className="entete" data-node="board.entete">
        <div className="entete-texte">
          <h1 className="titre-ecran" data-node="board.entete.titre">
            Board
          </h1>
          <p className="resume" data-node="board.identite">
            Lecture seule, sous l’identité de la cell <strong>{cell}</strong>
            {projet ? ` · projet ${projet.id}` : ''}.
          </p>
        </div>
        <div className="board-lecture">
          <PastilleLecture enLecture={enLecture} luA={luA} node="board.pastille" />
          <button
            className="bouton"
            type="button"
            data-node="board.relire"
            data-action="board.relire"
            onClick={relire}
          >
            Relire
          </button>
        </div>
      </div>
      {projets.erreur && !r && (
        <p className="message-erreur" role="alert" data-node="board.erreur">
          {projets.erreur}
        </p>
      )}
      {r && !r.ok && <MessageBoard kind={r.kind} node="board.message" onRelire={relire} />}
      {r?.ok && liste.length === 0 && (
        <p className="texte-discret" data-node="board.projets.vide">
          Aucun projet lisible par cette cell.
        </p>
      )}
      {liste.length > 1 && (
        <nav className="board-projets" aria-label="Projets" data-node="board.projets">
          {liste.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`board-projet${p.id === projet?.id ? ' est-actif' : ''}`}
              aria-pressed={p.id === projet?.id}
              onClick={() => setParams({ projet: String(p.id) })}
            >
              {p.slug ?? p.title ?? `#${p.id}`}
            </button>
          ))}
        </nav>
      )}
      {liste.length === 1 && projet && (
        <p className="board-projet-seul" data-node="board.projet">
          {projet.slug ?? `#${projet.id}`}
          {projet.title ? ` · ${projet.title}` : ''}
        </p>
      )}
      {projet && <Cartes key={projet.id} projet={projet} onLecture={setCartes} />}
    </main>
  );
}

export function Board() {
  const { state } = useAid();
  // l'écran n'existe que si le mesh est configuré : sinon, ni onglet ni message
  if (state && !state.mesh) return <Navigate to="/" replace />;
  return (
    <Layout screen="board">{state?.mesh ? <Contenu cell={state.mesh.state.cell} /> : null}</Layout>
  );
}

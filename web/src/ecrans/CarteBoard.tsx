import type { ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import type {
  BoardCard,
  BoardCardSheet,
  BoardGraph,
  BoardObligations,
  BoardResult,
  BoardThread,
} from '../../../src/shared/board.js';
import { useBoardCard } from '../data/board.js';
import { useAid } from '../data/useAidState.js';
import { Layout } from '../ui/Layout.js';
import {
  ageTexte,
  BandeauBoard,
  boardIndisponible,
  MessageBoard,
  PastilleLecture,
} from './Board.js';

/**
 * Chantier 24 (24.8) : la fiche d'une carte du board, en lecture seule. Quatre lectures indépendantes : une
 * partie en échec affiche son message à sa place, le reste s'affiche. Tout le contenu des pairs est du texte
 * brut (D98) ; « CarteBoard » pour ne pas confondre avec l'écran « Carte, plus tard » de la spec.
 */

const TIRET = '—';
const date = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : TIRET);
const age = (iso: string | null) => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(at)
    ? TIRET
    : `il y a ${ageTexte(Math.max(0, Math.round((Date.now() - at) / 1000)))}`;
};

function Bloc({
  id,
  titre,
  result,
  onRelire,
  children,
}: {
  id: string;
  titre: string;
  result: BoardResult<unknown>;
  onRelire: () => void;
  children: ReactNode;
}) {
  return (
    <section className="carte-board-bloc" data-node={`carte-board.${id}`}>
      <h2 className="carte-board-bloc-titre">{titre}</h2>
      {result.ok ? (
        children
      ) : (
        <MessageBoard kind={result.kind} node={`carte-board.${id}.message`} onRelire={onRelire} />
      )}
    </section>
  );
}

function Corps({ card }: { card: BoardCard }) {
  return card.body ? (
    <p className="carte-board-texte" data-node="carte-board.corps.texte">
      {card.body}
    </p>
  ) : (
    <p className="texte-discret">Aucun corps.</p>
  );
}

function Graphe({ g }: { g: BoardGraph }) {
  return (
    <>
      {g.steps.length === 0 ? (
        <p className="texte-discret">Aucune étape.</p>
      ) : (
        <table className="carte-board-table">
          <thead>
            <tr>
              <th>Étape</th>
              <th>Obligatoire</th>
              <th>État</th>
              <th>Détenteur</th>
              <th>Échéance</th>
            </tr>
          </thead>
          <tbody>
            {g.steps.map((s, i) => (
              <tr key={`${s.step ?? ''}-${i}`} data-node={`carte-board.graphe.etape-${i}`}>
                <td>{s.step ?? TIRET}</td>
                <td>{s.mandatory === null ? TIRET : s.mandatory ? 'oui' : 'non'}</td>
                {/* en entier, jamais abrégé : ce texte explique le blocage */}
                <td className="carte-board-etat">{s.state ?? TIRET}</td>
                <td>{s.holder ?? TIRET}</td>
                <td>{date(s.due)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <dl className="carte-board-faits">
        <dt>Manque</dt>
        <dd data-node="carte-board.graphe.manque">
          {g.missing.length ? g.missing.join(', ') : TIRET}
        </dd>
        <dt>Non confirmé</dt>
        <dd data-node="carte-board.graphe.non-confirme">
          {g.unconfirmed.length ? g.unconfirmed.join(', ') : TIRET}
        </dd>
        <dt>Étape déduite</dt>
        <dd data-node="carte-board.graphe.deduite">{g.stageImplied ?? TIRET}</dd>
      </dl>
    </>
  );
}

function Obligations({ o }: { o: BoardObligations }) {
  return (
    <>
      {o.truncated && (
        <p className="board-tronquee" data-node="carte-board.obligations.tronquee">
          Liste tronquée par le board
        </p>
      )}
      {o.obligations.length === 0 ? (
        <p className="texte-discret">Aucune obligation.</p>
      ) : (
        <table className="carte-board-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Étape</th>
              <th>Détenteur</th>
              <th>Statut</th>
              <th>Indication</th>
              <th>Fermée</th>
              <th>Preuve</th>
            </tr>
          </thead>
          <tbody>
            {o.obligations.map((x) => (
              <tr key={x.id} data-node={`carte-board.obligation-${x.id}`}>
                <td>{x.id}</td>
                <td>{x.step ?? TIRET}</td>
                <td>{x.holder ?? TIRET}</td>
                {/* status fait foi ; state n'est qu'une indication (#1456) */}
                <td>{x.status ?? TIRET}</td>
                <td className="texte-discret">{x.state ?? TIRET}</td>
                <td>{x.closed ? (x.closedAt ? `oui, ${date(x.closedAt)}` : 'oui') : 'non'}</td>
                <td>
                  {x.closeOutcome
                    ? `${x.closeOutcome}${x.closeEvidence ? ` · ${x.closeEvidence}` : ''}`
                    : TIRET}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Fil({ t }: { t: BoardThread }) {
  return (
    <>
      {t.capped && (
        <p className="board-tronquee" data-node="carte-board.fil.limite">
          Fil limité à 1000 messages
        </p>
      )}
      {t.messages.length === 0 ? (
        <p className="texte-discret">Aucun message.</p>
      ) : (
        <ol className="carte-board-fil">
          {t.messages.map((m) => (
            <li key={m.id} data-node={`carte-board.message-${m.id}`}>
              <p className="carte-board-fil-entete">
                <span className="carte-board-auteur">{m.author}</span>
                <span className="texte-discret" title={m.createdAt ?? undefined}>
                  {age(m.createdAt)}
                </span>
              </p>
              <p className="carte-board-texte">{m.content ?? ''}</p>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function Historique({ card }: { card: BoardCard }) {
  return card.stageHistory.length === 0 ? (
    <p className="texte-discret">Aucun historique.</p>
  ) : (
    <table className="carte-board-table">
      <thead>
        <tr>
          <th>Étape</th>
          <th>Auteur</th>
          <th>Date</th>
        </tr>
      </thead>
      <tbody>
        {card.stageHistory.map((h, i) => (
          <tr key={i} data-node={`carte-board.historique-${i}`}>
            <td>{h.stage ?? TIRET}</td>
            <td>{h.by}</td>
            <td>{date(h.at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Seul un lien https vers GitHub devient cliquable ; tout autre lien d'un pair reste du texte. */
const GITHUB = /^https:\/\/github\.com\/[^\s"'<>]+$/;

function GitHub({ card }: { card: BoardCard }) {
  const liens = Object.entries(card.links);
  return liens.length === 0 ? (
    <p className="texte-discret">Aucune PR citée.</p>
  ) : (
    <ul className="carte-board-liens">
      {liens.map(([k, v]) => (
        <li key={k} data-node={`carte-board.lien-${k}`}>
          <span className="texte-discret">{k} </span>
          {GITHUB.test(v) ? (
            <a href={v} target="_blank" rel="noreferrer noopener">
              {v}
            </a>
          ) : (
            <span>{v}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Fiche({ s, relire }: { s: BoardCardSheet; relire: () => void }) {
  const c = s.card.ok ? s.card.data : null;
  return (
    <>
      {c && (
        <p className="carte-board-meta" data-node="carte-board.meta">
          <span>{c.stage ?? '(sans étape)'}</span>
          <span>{c.assignee ?? 'sans responsable'}</span>
          <span>{c.dueAt ? `échéance ${c.dueAt.slice(0, 10)}` : 'sans échéance'}</span>
          <span>créée par {c.author}</span>
        </p>
      )}
      <Bloc id="corps" titre="Corps" result={s.card} onRelire={relire}>
        {c && <Corps card={c} />}
      </Bloc>
      <Bloc id="graphe" titre="Graphe d’étapes" result={s.graph} onRelire={relire}>
        {s.graph.ok && <Graphe g={s.graph.data} />}
      </Bloc>
      <Bloc id="obligations" titre="Obligations" result={s.obligations} onRelire={relire}>
        {s.obligations.ok && <Obligations o={s.obligations.data} />}
      </Bloc>
      <Bloc id="fil" titre="Fil" result={s.thread} onRelire={relire}>
        {s.thread.ok && <Fil t={s.thread.data} />}
      </Bloc>
      <Bloc id="historique" titre="Historique" result={s.card} onRelire={relire}>
        {c && <Historique card={c} />}
      </Bloc>
      <Bloc id="github" titre="GitHub" result={s.card} onRelire={relire}>
        {c && <GitHub card={c} />}
      </Bloc>
    </>
  );
}

/** Chantier 31 (D180) : aussi monté par l'interface d'un appareil, sans la coque du Mac. */
export function Contenu({ cardId }: { cardId: number }) {
  const { result, enLecture, luA, erreur, relire, reussieA } = useBoardCard(cardId);
  const c = result?.card.ok ? result.card.data : null;
  return (
    <main className="page carte-board" data-node="carte-board">
      <nav className="carte-board-ariane" aria-label="Fil d’Ariane" data-node="carte-board.ariane">
        {/* retour au projet de la carte, pas au premier de la liste */}
        <Link
          to={c?.projectId != null ? `/board?projet=${c.projectId}` : '/board'}
          data-node="carte-board.retour"
        >
          Board
        </Link>
        <span aria-hidden="true"> › </span>
        <span>
          {c?.projectId !== null && c?.projectId !== undefined ? `projet ${c.projectId} · ` : ''}#
          {cardId}
        </span>
      </nav>
      <div className="entete" data-node="carte-board.entete">
        <div className="entete-texte">
          <h1 className="titre-ecran" data-node="carte-board.titre">
            {c?.title ?? `Carte #${cardId}`}
          </h1>
        </div>
        <div className="board-lecture">
          <PastilleLecture enLecture={enLecture} luA={luA} node="carte-board.pastille" />
          <button
            className="bouton"
            type="button"
            data-node="carte-board.relire"
            data-action="board.relire"
            onClick={() => void relire()}
          >
            Relire
          </button>
        </div>
      </div>
      {boardIndisponible(result?.card, erreur) && (
        <BandeauBoard
          reussieA={reussieA}
          enLecture={enLecture}
          onReessayer={() => void relire()}
          node="carte-board.bandeau"
        />
      )}
      {erreur && !result && (
        <p className="message-erreur" role="alert" data-node="carte-board.erreur">
          {erreur}
        </p>
      )}
      {result && <Fiche s={result} relire={() => void relire()} />}
    </main>
  );
}

export function CarteBoard() {
  const { state } = useAid();
  const { cardId } = useParams();
  const id = cardId && /^\d+$/.test(cardId) ? Number(cardId) : NaN;
  if (state && !state.mesh) return <Navigate to="/" replace />;
  if (!Number.isSafeInteger(id) || id <= 0) return <Navigate to="/board" replace />;
  return <Layout screen="board">{state?.mesh ? <Contenu cardId={id} /> : null}</Layout>;
}

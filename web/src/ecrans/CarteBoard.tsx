import { CartesReliees } from '../ui/CartesReliees.js';
import { AvatarCell } from '../ui/AvatarCell.js';
import { AidCarte, ErreursAid, NouveauSujetCarte } from '../ui/AidBoard.js';
import { liensSwairm } from '../../../src/shared/swairm-board.js';
import type { LecturePrSwairm } from '../../../src/shared/swairm-trailers.js';
import { cheminMesh, instantaneMesh, useMeshLecture } from '../data/meshLecture.js';
import { useSwairmCommits } from '../data/swairm-commits.js';
import { ErreursSwairm, SwairmCarte } from '../ui/SwairmBoard.js';
import { ChangerEtat } from '../ui/ChangerEtat.js';
import { EcrireAuMesh } from '../ui/EcrireAuMesh.js';
import { useState, type ReactNode } from 'react';
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
import { chronologie } from '../data/chronologie.js';
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

function Graphe({ g, cellLocale }: { g: BoardGraph; cellLocale?: string }) {
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
                <td>
                  {s.holder && <AvatarCell nom={s.holder} cellLocale={cellLocale} />}
                  {s.holder ?? TIRET}
                </td>
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

function Obligations({
  o,
  s,
  relire,
}: {
  o: BoardObligations;
  s: BoardCardSheet & { mesh: string };
  relire: () => void;
}) {
  const { state } = useAid();
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
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {o.obligations.map((x) => (
              <tr key={x.id} data-node={`carte-board.obligation-${x.id}`}>
                <td>{x.id}</td>
                <td>{x.step ?? TIRET}</td>
                <td>
                  {x.holder && (
                    <AvatarCell
                      nom={x.holder}
                      cellLocale={instantaneMesh(state, s.mesh)?.state.cell}
                    />
                  )}
                  {x.holder ?? TIRET}
                </td>
                {/* status fait foi ; state n'est qu'une indication (#1456) */}
                <td>{x.status ?? TIRET}</td>
                <td className="texte-discret">{x.state ?? TIRET}</td>
                <td>{x.closed ? (x.closedAt ? `oui, ${date(x.closedAt)}` : 'oui') : 'non'}</td>
                <td>
                  {x.closeOutcome
                    ? `${x.closeOutcome}${x.closeEvidence ? ` · ${x.closeEvidence}` : ''}`
                    : TIRET}
                </td>
                <td>
                  {s.card.ok && (
                    <ChangerEtat
                      mesh={s.mesh}
                      obligation={x}
                      carte={s.card.data.id}
                      etape={
                        s.graph.ok
                          ? s.graph.data.steps.find((e) => x.step !== null && e.step === x.step)
                          : undefined
                      }
                      relire={relire}
                    />
                  )}
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

function Chronologie({
  s,
  commits: lecture,
}: {
  s: BoardCardSheet & { mesh: string };
  commits: LecturePrSwairm | null;
}) {
  const commits = s.card.ok && liensSwairm(s.card.data.body ?? '').length > 0 ? lecture : null;
  const [filtres, setFiltres] = useState({
    etape: true,
    obligation: true,
    fil: true,
    commit: true,
  });
  const { entrees, limites } = chronologie({ ...s, commits: commits?.commits });
  return (
    <section className="carte-board-bloc" data-node="carte-board.chronologie">
      <h2 className="carte-board-bloc-titre">Chronologie</h2>
      <p className="carte-board-meta">
        {(['etape', 'obligation', 'fil'] as const).map((source) => (
          <label key={source}>
            <input
              type="checkbox"
              data-node={`carte-board.chronologie.filtre-${source}`}
              checked={filtres[source]}
              onChange={() => setFiltres((avant) => ({ ...avant, [source]: !avant[source] }))}
            />{' '}
            {{ etape: 'Étapes', obligation: 'Obligations', fil: 'Fil' }[source]}
          </label>
        ))}
        {commits && (
          <label>
            <input
              type="checkbox"
              data-node="carte-board.chronologie.filtre-commit"
              checked={filtres.commit}
              onChange={() => setFiltres((avant) => ({ ...avant, commit: !avant.commit }))}
            />{' '}
            Commits
          </label>
        )}
      </p>
      <ol className="carte-board-fil">
        {entrees
          .filter((entree) => filtres[entree.source])
          .map((entree, i) => (
            <li key={entree.cle} data-node={`carte-board.chronologie.entree-${i}`}>
              <p className="carte-board-fil-entete">
                <span className="texte-discret" title={entree.date ?? undefined}>
                  {date(entree.date)} · {age(entree.date)}
                </span>
                <span>
                  {
                    { etape: 'étape', obligation: 'obligation', fil: 'fil', commit: 'commit' }[
                      entree.source
                    ]
                  }
                </span>
                <span className="carte-board-auteur">{entree.auteur}</span>
              </p>
              <p className="carte-board-texte">
                {entree.texte}
                {entree.sha && ` · ${entree.sha.slice(0, 7)}`}
              </p>
            </li>
          ))}
      </ol>
      <div className="texte-discret" data-node="carte-board.chronologie.limites">
        {limites.map((limite, i) => (
          <p key={i}>
            {limite === 'fil-limite'
              ? 'Fil limité à 1000 messages : la chronologie peut être incomplète'
              : 'lignesAnterieures' in limite
                ? `${limite.lignesAnterieures} lignes antérieures, sans leurs événements`
                : {
                    etapes: 'Étapes non lues',
                    obligations: 'Obligations non lues',
                    fil: 'Fil non lu',
                  }[limite['non-lu']]}
          </p>
        ))}
      </div>
      {commits?.etat === 'non-lu' && <p>PR non lue : {commits.raison}</p>}
      {commits?.etat === 'ok' &&
        (commits.pr ? (
          <p>
            PR #{commits.pr.number} (
            {commits.pr.state === 'OPEN'
              ? 'ouverte'
              : commits.pr.state === 'MERGED'
                ? 'mergée'
                : commits.pr.state === 'CLOSED'
                  ? 'fermée'
                  : commits.pr.state}
            ){' '}
            {commits.pr.url?.startsWith('https://github.com/') && (
              <a href={commits.pr.url} target="_blank" rel="noreferrer noopener">
                {commits.pr.url}
              </a>
            )}
          </p>
        ) : (
          <p>Aucune PR ouverte.</p>
        ))}
    </section>
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

function Fiche({
  s,
  relire,
  commits,
}: {
  s: BoardCardSheet & { mesh: string };
  relire: () => void;
  commits: LecturePrSwairm | null;
}) {
  const c = s.card.ok ? s.card.data : null;
  const { state } = useAid();
  const objetMesh = instantaneMesh(state, s.mesh);
  const [ecriture, setEcriture] = useState(false);
  return (
    <>
      {c && (
        <p className="carte-board-meta" data-node="carte-board.meta">
          <span>{c.stage ?? '(sans étape)'}</span>
          <span>
            {c.assignee && <AvatarCell nom={c.assignee} cellLocale={objetMesh?.state.cell} />}
            {c.assignee ?? 'sans responsable'}
          </span>
          <span>{c.dueAt ? `échéance ${c.dueAt.slice(0, 10)}` : 'sans échéance'}</span>
          <span>créée par {c.author}</span>
        </p>
      )}
      <Bloc id="corps" titre="Corps" result={s.card} onRelire={relire}>
        {c && <Corps card={c} />}
      </Bloc>
      <Bloc id="graphe" titre="Graphe d’étapes" result={s.graph} onRelire={relire}>
        {s.graph.ok && <Graphe g={s.graph.data} cellLocale={objetMesh?.state.cell} />}
      </Bloc>
      {objetMesh?.state.proxyConfigure && !objetMesh.state.ecritures && (
        <p>Le proxy de ta cellule est en lecture seule.</p>
      )}
      <Bloc id="obligations" titre="Obligations" result={s.obligations} onRelire={relire}>
        {s.obligations.ok && <Obligations o={s.obligations.data} s={s} relire={relire} />}
      </Bloc>
      {objetMesh && c && (
        <>
          <button onClick={() => setEcriture(true)}>Écrire une note (à blanc)</button>
          {ecriture && (
            <EcrireAuMesh
              mesh={s.mesh}
              onRelire={relire}
              action="carte.note"
              valeurs={{ carte: c.id }}
              onClose={() => setEcriture(false)}
            />
          )}
        </>
      )}
      <Bloc id="fil" titre="Fil" result={s.thread} onRelire={relire}>
        {s.thread.ok && <Fil t={s.thread.data} />}
      </Bloc>
      <p>
        Déplacer : A-I-D le propose dans la Boîte quand le sujet lié change de phase, entre build,
        review et ready, jamais vers done.
      </p>
      <Chronologie s={s} commits={commits} />
      <Bloc id="github" titre="GitHub" result={s.card} onRelire={relire}>
        {c && <GitHub card={c} />}
      </Bloc>
    </>
  );
}

/** Chantier 31 (D180) : aussi monté par l'interface d'un appareil, sans la coque du Mac. */
export function Contenu({ cardId }: { cardId: number }) {
  const mesh = useMeshLecture();
  const commits = useSwairmCommits(mesh === 'principal' ? cardId : 0);
  const { result, enLecture, luA, erreur, relire, reussieA } = useBoardCard(cardId);
  const c = result?.card.ok ? result.card.data : null;
  return (
    <main className="page carte-board" data-node="carte-board">
      <nav className="carte-board-ariane" aria-label="Fil d’Ariane" data-node="carte-board.ariane">
        {/* retour au projet de la carte, pas au premier de la liste */}
        <Link
          to={cheminMesh(c?.projectId != null ? `/board?projet=${c.projectId}` : '/board', mesh)}
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
      <ErreursSwairm />
      <SwairmCarte carte={cardId} fiche />
      <ErreursAid />
      <AidCarte carte={cardId} fiche />
      {result?.card.ok && (
        <NouveauSujetCarte
          carte={cardId}
          titre={result.card.data.title ?? ''}
          corps={result.card.data.body ?? ''}
        />
      )}
      {result && <Fiche s={result} relire={() => void relire()} commits={commits} />}
      {result?.card.ok && <CartesReliees key={`${mesh}:${cardId}`} carte={cardId} />}
    </main>
  );
}

export function CarteBoard() {
  const { state } = useAid();
  const { cardId } = useParams();
  const id = cardId && /^\d+$/.test(cardId) ? Number(cardId) : NaN;
  if (state && !state.mesh && !Object.keys(state.meshes ?? {}).length)
    return <Navigate to="/" replace />;
  if (!Number.isSafeInteger(id) || id <= 0) return <Navigate to="/board" replace />;
  return (
    <Layout screen="board">
      {state?.mesh || Object.keys(state?.meshes ?? {}).length ? <Contenu cardId={id} /> : null}
    </Layout>
  );
}

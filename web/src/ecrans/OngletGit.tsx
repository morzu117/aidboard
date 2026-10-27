import { useEffect, useMemo, useRef, useState } from 'react';
import type { GitCommitDetail, GitLogCommit, GitLogResponse } from '../../../src/shared/git.js';
import { AidApiError } from '../data/api.js';
import { fetchCommitDetail, fetchGitLog } from '../data/git.js';
import { useAid } from '../data/useAidState.js';
import { depuis } from '../ui/depuis.js';
import { findRefTip, layoutGraph, LANE_X, type GraphRow } from '../ui/gitGraph.js';

type Portee = 'toutes' | 'base' | 'sujet';

const PORTEES: Array<{ valeur: Portee; label: string }> = [
  { valeur: 'toutes', label: 'Toutes' },
  { valeur: 'base', label: 'Sujet et main' },
  { valeur: 'sujet', label: 'Sujet seul' },
];

// re-dev 2/2 : la largeur « 64 » doit rester alignée sur --l-graphe (app.css, .panneau-contexte).
function CommitGraphe({ row }: { row: GraphRow }) {
  const cx = LANE_X[row.lane];
  const cy = row.nodeY;
  return (
    <svg
      className="graphe"
      viewBox={`0 0 64 ${row.rowHeight}`}
      aria-hidden="true"
      focusable="false"
    >
      {row.paths.map((p, i) => (
        <path
          key={i}
          className={`trait trait--voie-${p.lane}${p.dashed ? ' trait--pointille' : ''}`}
          d={p.d}
        />
      ))}
      {row.isHead && <circle className="anneau" cx={cx} cy={cy} r={8} />}
      <circle
        className={row.wip ? 'noeud noeud--wip' : `noeud noeud--voie-${row.lane}`}
        cx={cx}
        cy={cy}
        r={row.wip ? 5 : row.isHead ? 5.5 : 4.5}
      />
    </svg>
  );
}

function SituationBanniere({
  live,
  base,
  actionEnCours,
  erreur,
  onSynchroniser,
  onPousser,
}: {
  live: GitLogResponse['live'];
  base: string;
  actionEnCours: string | null;
  erreur: string | null;
  onSynchroniser: () => void;
  onPousser: () => void;
}) {
  const ahead = live.aheadBehind?.ahead ?? 0;
  const behind = live.aheadBehind?.behind ?? 0;
  return (
    <section className="situation" data-node="1-3.git.situation" aria-label="Où en es-tu">
      <div className="situation-texte">
        <div className="stats">
          {ahead > 0 && (
            <span className="stat stat--avance" data-node="1-3.git.situation.avance">
              <span className="stat-icone" aria-hidden="true">
                ↑
              </span>
              {ahead} d’avance sur origin/{base}
            </span>
          )}
          {behind > 0 && (
            <span className="stat stat--retard" data-node="1-3.git.situation.retard">
              <span className="stat-icone" aria-hidden="true">
                ↓
              </span>
              {behind} de retard
            </span>
          )}
          {ahead === 0 && behind === 0 && (
            <span className="stat" data-node="1-3.git.situation.a-jour">
              À jour avec origin
            </span>
          )}
        </div>
        {erreur && (
          <p className="message-erreur" role="alert">
            {erreur}
          </p>
        )}
      </div>
      <div className="actions">
        <button
          className="bouton bouton--plein"
          data-node="1-3.git.situation.synchroniser"
          data-action="topic.sync"
          type="button"
          onClick={onSynchroniser}
          disabled={actionEnCours !== null}
        >
          Synchroniser
        </button>
        <button
          className="bouton bouton--primaire"
          data-node="1-3.git.situation.pousser"
          data-action="git.pousser"
          type="button"
          onClick={onPousser}
          disabled={actionEnCours !== null || ahead === 0}
        >
          Pousser{ahead > 0 ? ` ${ahead} commit${ahead > 1 ? 's' : ''}` : ''}
        </button>
      </div>
    </section>
  );
}

// 11.3/11.4 (écran 3.2) : graphe + liste de commits, panneau de détail, et bannière de
// situation (avance/retard déjà connu par gitLiveInfo, même passage que le journal).
export function OngletGit({
  topicId,
  base,
  remote,
}: {
  topicId: string;
  base: string;
  remote: string | null;
}) {
  const { call } = useAid();
  const [log, setLog] = useState<GitLogResponse | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [portee, setPortee] = useState<Portee>('toutes');
  const [recherche, setRecherche] = useState('');
  const [selection, setSelection] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [detailErreur, setDetailErreur] = useState<string | null>(null);
  const [actionEnCours, setActionEnCours] = useState<string | null>(null);
  const [actionErreur, setActionErreur] = useState<string | null>(null);
  const listeRef = useRef<HTMLDivElement | null>(null);
  const defilementListe = useRef(0);
  const retourRef = useRef<HTMLButtonElement | null>(null);
  const rechercheRef = useRef<HTMLInputElement | null>(null);
  const commitButtonsRef = useRef(new Map<string, HTMLButtonElement>());
  // point 1 : hash de la sélection effectivement en vol — une réponse (succès ou erreur)
  // dont le hash n'y correspond plus a été périmée par un Retour ou une sélection suivante.
  const hashDemandeRef = useRef<string | null>(null);
  const monteRef = useRef(true);
  // point 2 : hash du commit qu'il faut refocaliser après un Retour ; posé par retour().
  const hashARefocaliserRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      monteRef.current = false;
    },
    [],
  );

  // point 4 : le détail remplace la liste — restaure le défilement au retour, rend le focus
  // au bouton Retour à l'ouverture (porte d'entrée de l'Échap = Retour).
  useEffect(() => {
    if (selection) {
      retourRef.current?.focus();
      return;
    }
    if (listeRef.current) listeRef.current.scrollTop = defilementListe.current;
    const hash = hashARefocaliserRef.current;
    hashARefocaliserRef.current = null;
    if (hash === null) return;
    const bouton = commitButtonsRef.current.get(hash);
    if (bouton) bouton.focus();
    else rechercheRef.current?.focus();
  }, [selection]);

  useEffect(() => {
    let cancelled = false;
    fetchGitLog(call, topicId)
      .then((r) => {
        if (cancelled) return;
        setLog(r);
        setErreur(null);
      })
      .catch((err) => {
        if (!cancelled) setErreur(err instanceof AidApiError ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId]);

  async function lancerAction(actionId: string) {
    setActionErreur(null);
    setActionEnCours(actionId);
    try {
      await call('POST', `/api/topics/${topicId}/actions/${actionId}`, {});
      setLog(await fetchGitLog(call, topicId));
    } catch (err) {
      setActionErreur(err instanceof AidApiError ? err.message : String(err));
    } finally {
      setActionEnCours(null);
    }
  }

  const baseRefs = useMemo(() => (remote ? [`${remote}/${base}`, base] : [base]), [remote, base]);

  const rows = useMemo(
    // rowHeight/nodeY alignés sur --h-ligne-commit (app.css, .panneau-contexte) : seul endroit
    // où ce composant s'affiche, donc pas besoin d'une valeur plein écran séparée.
    () =>
      log ? layoutGraph(log.commits, { baseRefs, dirty: log.dirty, rowHeight: 46, nodeY: 23 }) : [],
    [log, baseRefs],
  );
  const commitByHash = useMemo(
    () => new Map<string, GitLogCommit>((log?.commits ?? []).map((c) => [c.hash, c])),
    [log],
  );

  function selectionner(hash: string) {
    if (listeRef.current) defilementListe.current = listeRef.current.scrollTop;
    setSelection(hash);
    setDetail(null);
    setDetailErreur(null);
    hashDemandeRef.current = hash;
    fetchCommitDetail(call, topicId, hash)
      .then((d) => {
        if (monteRef.current && hashDemandeRef.current === hash) setDetail(d);
      })
      .catch((err) => {
        if (monteRef.current && hashDemandeRef.current === hash) {
          setDetailErreur(err instanceof AidApiError ? err.message : String(err));
        }
      });
  }

  function retour() {
    hashDemandeRef.current = null;
    hashARefocaliserRef.current = selection;
    setSelection(null);
  }

  if (erreur) {
    return (
      <div className="sujet-grille sujet-grille--seul">
        <section className="zone-erreur" data-node="1-3.git.erreur">
          <div className="bandeau-erreur" role="alert">
            <div className="bandeau-texte">
              <p className="bandeau-titre">Impossible de lire l’historique</p>
              <p className="texte-discret" data-bind="erreur.cause">
                {erreur}
              </p>
            </div>
          </div>
        </section>
      </div>
    );
  }
  if (!log) {
    return (
      <div className="sujet-grille sujet-grille--seul">
        <div className="squelette" data-node="1-3.git.chargement">
          <span className="sq sq--grand-bloc" />
        </div>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <>
        <SituationBanniere
          live={log.live}
          base={base}
          actionEnCours={actionEnCours}
          erreur={actionErreur}
          onSynchroniser={() => void lancerAction('topic.sync')}
          onPousser={() => void lancerAction('git.pousser')}
        />
        <div className="sujet-grille sujet-grille--seul">
          <section className="vide" data-node="1-3.git.vide">
            <p className="vide-message">Aucun commit depuis la base.</p>
          </section>
        </div>
      </>
    );
  }

  const baseTip = findRefTip(log.commits, baseRefs);
  const filtered = rows.filter((row) => {
    if (row.wip) return true;
    if (portee === 'sujet' && row.lane !== 1) return false;
    if (portee === 'base' && row.lane === 2) return false;
    if (recherche) {
      const c = commitByHash.get(row.hash);
      const needle = recherche.toLowerCase();
      const hay = `${c?.message ?? ''} ${c?.author ?? ''} ${row.hash}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  const banniere = (
    <SituationBanniere
      live={log.live}
      base={base}
      actionEnCours={actionEnCours}
      erreur={actionErreur}
      onSynchroniser={() => void lancerAction('topic.sync')}
      onPousser={() => void lancerAction('git.pousser')}
    />
  );

  // point 4 : le détail remplace la liste dans le panneau (~360 px), au lieu de la grille
  // liste + détail côte à côte de l'écran plein écran (3.2), qui écrasait le détail à droite.
  if (selection) {
    return (
      <>
        {banniere}
        <div
          className="sujet-grille sujet-grille--seul"
          data-node="1-3.git"
          onKeyDown={(e) => {
            if (e.key === 'Escape') retour();
          }}
        >
          <aside className="panneau" data-node="1-3.git.detail" aria-label="Détail du commit">
            <div className="detail-entete">
              <button
                ref={retourRef}
                className="bouton"
                data-node="1-3.git.detail.retour"
                data-action="git.retour"
                type="button"
                onClick={retour}
              >
                ← Retour
              </button>
            </div>
            {detailErreur ? (
              <p className="message-erreur" role="alert">
                {detailErreur}
              </p>
            ) : !detail ? (
              <div className="squelette" data-node="1-3.git.detail.chargement">
                <span className="sq sq--grand-bloc" />
              </div>
            ) : (
              <div className="detail" data-node="1-3.git.detail.corps">
                <div className="refs">
                  {detail.refs.map((r) => (
                    <span key={r} className="etiquette etiquette--ref" data-bind="commit.ref">
                      {r}
                    </span>
                  ))}
                </div>
                <h3
                  className="detail-titre"
                  data-node="1-3.git.detail.message"
                  data-bind="commit.message"
                >
                  {detail.message}
                </h3>
                {detail.body && (
                  <p
                    className="texte-discret"
                    data-node="1-3.git.detail.corps-texte"
                    data-bind="commit.corps"
                  >
                    {detail.body}
                  </p>
                )}
                <dl className="infos">
                  <dt>Auteur</dt>
                  <dd data-node="1-3.git.detail.auteur" data-bind="commit.auteur">
                    {detail.author}
                  </dd>
                  <dt>Date</dt>
                  <dd data-node="1-3.git.detail.date" data-bind="commit.date">
                    {new Date(detail.date).toLocaleString('fr-FR')}
                  </dd>
                  <dt>Parents</dt>
                  <dd
                    className="chiffres"
                    data-node="1-3.git.detail.parents"
                    data-bind="commit.parents"
                  >
                    {detail.parents.map((p) => p.slice(0, 7)).join(', ') || '—'}
                  </dd>
                  <dt>Dans ta branche</dt>
                  <dd data-node="1-3.git.detail.dans-branche" data-bind="commit.dans_head">
                    {detail.inHead ? 'oui' : 'non'}
                  </dd>
                </dl>
                <div className="separation">
                  <div className="separation-titre">
                    <span>Fichiers</span>
                    <span className="chiffres" data-node="1-3.git.detail.fichiers-total">
                      {detail.files.length} fichier{detail.files.length > 1 ? 's' : ''}
                    </span>
                  </div>
                  <div className="fichiers">
                    {detail.files.map((f) => (
                      <div key={f.path} className="fichier" data-node="1-3.git.detail.fichier">
                        <span
                          className={`fichier-etat fichier-etat--${f.status.toLowerCase()}`}
                          data-bind="fichier.etat"
                        >
                          {f.status}
                        </span>
                        <span className="fichier-chemin" data-bind="fichier.chemin">
                          {f.path}
                        </span>
                        <span className="ajouts" data-bind="fichier.ajouts">
                          {f.additions != null ? `+${f.additions}` : ''}
                        </span>
                        <span className="suppressions" data-bind="fichier.suppressions">
                          {f.deletions != null ? `−${f.deletions}` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="separation actions">
                  <button
                    className="bouton"
                    data-node="1-3.git.detail.copier-hash"
                    data-action="git.copier-hash"
                    type="button"
                    onClick={() => void navigator.clipboard?.writeText(detail.hash)}
                  >
                    Copier le hash
                  </button>
                </div>
              </div>
            )}
          </aside>
        </div>
      </>
    );
  }

  return (
    <>
      {banniere}
      <div className="sujet-grille sujet-grille--seul" data-node="1-3.git">
        <section
          className="panneau panneau--sombre"
          data-node="1-3.git.historique"
          aria-label="Historique"
        >
          <div className="outils outils-git">
            <div className="git-portees" role="group" aria-label="Branches affichées">
              {PORTEES.map(({ valeur, label }) => (
                <button
                  key={valeur}
                  className={`portee${portee === valeur ? ' est-actif' : ''}`}
                  data-node={`1-3.git.historique.portee-${valeur}`}
                  data-action="git.portee"
                  type="button"
                  aria-pressed={portee === valeur}
                  onClick={() => setPortee(valeur)}
                >
                  {label}
                </button>
              ))}
            </div>
            <input
              ref={rechercheRef}
              className="champ"
              data-node="1-3.git.historique.recherche"
              data-action="git.filtrer"
              type="text"
              placeholder="Message, auteur ou hash"
              aria-label="Filtrer les commits"
              value={recherche}
              onChange={(e) => setRecherche(e.target.value)}
            />
            <div className="git-actions-ligne">
              <button
                className="bouton"
                data-node="1-3.git.historique.voir-base"
                data-action="git.voir-base"
                type="button"
                onClick={() => baseTip && selectionner(baseTip)}
                disabled={!baseTip}
              >
                Voir la base
              </button>
              <button
                className="bouton"
                data-node="1-3.git.historique.fetch"
                data-action="git.fetch"
                type="button"
                onClick={() => void lancerAction('git.fetch')}
                disabled={actionEnCours !== null}
              >
                Fetch
              </button>
            </div>
          </div>
          {filtered.length === 0 ? (
            <p className="vide-message" data-node="1-3.git.historique.aucun-resultat">
              Aucun commit ne correspond au filtre.
            </p>
          ) : (
            <div className="commits" role="list" aria-label="Commits" ref={listeRef}>
              {filtered.map((row) => {
                const c = row.wip ? null : (commitByHash.get(row.hash) ?? null);
                return (
                  <button
                    key={row.hash || 'wip'}
                    ref={(el) => {
                      if (row.wip) return;
                      if (el) commitButtonsRef.current.set(row.hash, el);
                      else commitButtonsRef.current.delete(row.hash);
                    }}
                    className={`commit${row.absent ? ' commit--absent' : ''}`}
                    data-node={`1-3.git.historique.commit-${row.hash || 'wip'}`}
                    data-action="git.selectionner"
                    type="button"
                    role="listitem"
                    onClick={row.wip ? undefined : () => selectionner(row.hash)}
                    disabled={row.wip}
                  >
                    <CommitGraphe row={row} />
                    <span className="commit-corps">
                      <span className="commit-ligne1">
                        {row.wip ? (
                          <span className="message message--wip">Modifications non commitées</span>
                        ) : (
                          <>
                            {c?.refs.map((r) => (
                              <span key={r} className="etiquette etiquette--ref">
                                {r}
                              </span>
                            ))}
                            <span className="message">{c?.message}</span>
                          </>
                        )}
                      </span>
                      <span className="commit-ligne2">
                        <span className="commit-meta">
                          {row.wip ? 'maintenant' : `${c?.author} · ${c ? depuis(c.date) : ''}`}
                        </span>
                        {!row.wip && <span className="commit-hash">{row.hash.slice(0, 7)}</span>}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="panneau-pied legende" data-node="1-3.git.historique.legende">
            <span className="legende-element">
              <span className="point point--voie-1" /> ta branche
            </span>
            <span className="legende-element">
              <span className="point point--voie-0" /> main
            </span>
            <span className="legende-element">
              <span className="point point--voie-2" /> autres branches
            </span>
            <span className="legende-element">Atténués : commits absents de ta branche</span>
          </div>
        </section>
      </div>
    </>
  );
}

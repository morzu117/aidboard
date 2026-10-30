import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { StoredEvent } from '../../../src/shared/events.js';
import type { GitLogResponse } from '../../../src/shared/git.js';
import type { Agent, IndexState, Topic } from '../../../src/shared/model.js';
import { Conversation } from '../conversation/Conversation.js';
import { AidApiError } from '../data/api.js';
import { fetchGitLog } from '../data/git.js';
import { useAid } from '../data/useAidState.js';
import { ConfirmerNettoyage } from '../dialogues/ConfirmerNettoyage.js';
import { SelecteurBranche } from '../dialogues/SelecteurBranche.js';
import { Terminal } from '../terminal/Terminal.js';
import { Layout, useLayout } from '../ui/Layout.js';
import { Memoire } from '../ui/Memoire.js';
import { agentView, Point } from '../ui/Statut.js';
import { Volet } from '../ui/Volet.js';
import type { ArchivedTopic } from './useArchive.js';
import { useArchive } from './useArchive.js';
import { PanneauContexte } from './PanneauContexte.js';
import { useNettoyage } from './useNettoyage.js';
import { roleLabel } from '../ui/roles.js';

// 06.10 : libellé court d'un événement du journal pour la chronologie de l'écran archive.
function libelleEvenement(e: StoredEvent): string {
  const d = e.data as Record<string, unknown>;
  switch (e.type) {
    case 'topic.state':
      return `Sujet passé en « ${String(d.state ?? '?')} »`;
    case 'topic.pr':
      return d.prNumber ? `PR #${String(d.prNumber)} ouverte` : 'PR mise à jour';
    case 'topic.stash':
      return d.stashRef
        ? 'Modifications non commitées mises de côté (stash)'
        : 'Mention du stash retirée';
    case 'action.started':
      return `Action lancée : ${String(d.action ?? '?')}`;
    case 'action.finished':
      return `Action terminée : ${String(d.action ?? '?')} (${String(d.outcome ?? '?')})`;
    case 'agent.spawned':
      return 'Agent démarré';
    case 'agent.exited':
      return 'Agent arrêté';
    default:
      return e.type;
  }
}

const INDEX_LABEL: Record<IndexState, string> = {
  disabled: 'index absent : lecture directe',
  indexing: 'indexation en cours',
  ready: 'index prêt',
  failed: 'index en échec : lecture directe',
};

const LIVE = ['starting', 'working', 'needs_input', 'idle'];
type Kind = 'claude' | 'codex' | 'shell' | 'swarph-cell' | 'swairm-cell';
const KINDS: Array<{ kind: Kind; label: string }> = [
  { kind: 'claude', label: 'Lancer claude' },
  { kind: 'codex', label: 'Lancer codex' },
  { kind: 'shell', label: 'Ouvrir un shell' },
];
// 12.6 : la cell swarph ne se propose que si `mesh.cell` est configuré (le snapshot porte alors `mesh`)
const KIND_CELL = { kind: 'swarph-cell' as const, label: 'Ouvrir la cell swarph' };
const KIND_SWAIRM_CELL = { kind: 'swairm-cell' as const, label: 'Ouvrir la cell Swairm' };

// review D : seule fonction qui décide si l'écran affiche la vue complète (agents toujours
// visibles, grille trois colonnes) — partagée par Sujet() et Contenu pour qu'elles ne
// divergent plus sur les mêmes branches (sujet introuvable, brouillon, worktree manquant).
function vueComplete(topic: Topic | undefined): boolean {
  return !!topic && topic.state !== 'draft' && !topic.worktreeMissing;
}

function Contenu({
  topicId,
  selectedAgent,
  onSelectAgent,
}: {
  topicId: string;
  selectedAgent: string | null;
  onSelectAgent: (id: string) => void;
}) {
  const { state, outputs, daemon, retry, call } = useAid();
  const navigate = useNavigate();
  const [menu, setMenu] = useState<'aucun' | 'agent' | 'plus'>('aucun');
  const [selecteurBranche, setSelecteurBranche] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [ignoring, setIgnoring] = useState(false);
  // §5.3 : retour discret après la copie du chemin du worktree depuis le menu ⋯.
  const [worktreeCopie, setWorktreeCopie] = useState(false);
  // review db76a41 : porte le minuteur « copié » pour l'annuler à la fermeture du menu ou au démontage.
  const worktreeCopieTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // review db76a41 : au démontage, pas de setState sur un minuteur encore en attente.
  useEffect(
    () => () => {
      if (worktreeCopieTimer.current !== null) clearTimeout(worktreeCopieTimer.current);
    },
    [],
  );
  // correctif 3 (recette) : emplacement DOM fourni à la Conversation active pour y porter ses
  // propres contrôles (Repères, Tout déplier) dans la rangée d'onglets — l'état reste dans Conversation.
  const [ongletsActionsEl, setOngletsActionsEl] = useState<HTMLDivElement | null>(null);
  // Arrêter en deux temps (§5.3) : l'id de l'agent dont la confirmation est affichée, ou aucun.
  const [arretConfirm, setArretConfirm] = useState<string | null>(null);
  useEffect(() => {
    if (arretConfirm === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setArretConfirm(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [arretConfirm]);
  const nettoyage = useNettoyage(topicId);
  const present = !!state?.topics.some((t) => t.id === topicId);
  const archive = useArchive(topicId, present);
  const down = daemon === 'injoignable' || daemon === 'session-expiree';

  // 11.10 (écran 3.6, D28) : même requête que l'onglet Git (git/log), lue ici pour que le
  // bandeau de dérive reste visible quel que soit l'onglet actif — au-dessus des retours
  // anticipés ci-dessous, donc avant que `topic` existe (topicId suffit à la requête).
  const [live, setLive] = useState<GitLogResponse['live'] | null>(null);
  // review (re-dev 1/2, correctif 6) : point de vérité unique — seule la dernière lecture
  // lancée peut écrire `live`, qu'elle vienne du montage, d'une action ou d'une branche changée.
  const liveSeqRef = useRef(0);
  function relireLive(): Promise<void> {
    const seq = ++liveSeqRef.current;
    return fetchGitLog(call, topicId)
      .then((r) => {
        if (liveSeqRef.current === seq) setLive(r.live);
      })
      .catch(() => {
        if (liveSeqRef.current === seq) setLive(null);
      });
  }
  useEffect(() => {
    relireLive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId]);
  const [deriveActionId, setDeriveActionId] = useState<string | null>(null);
  const [deriveRequesting, setDeriveRequesting] = useState(false);
  const [deriveErreur, setDeriveErreur] = useState<string | null>(null);
  const [rattaching, setRattaching] = useState(false);
  const [rattachErreur, setRattachErreur] = useState<string | null>(null);
  const deriveAction = state?.actions.find((a) => a.id === deriveActionId);
  useEffect(() => {
    if (deriveAction?.state !== 'succeeded') return;
    relireLive().then(() => setDeriveActionId(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deriveAction?.state]);

  // correctif 6 (recette) : `live` n'était relu qu'après branche.revenir/sujet.rattacher-branche —
  // un changement de branche hors de ces deux actions (topic.branch-changer, sync…) laissait le
  // bandeau de dérive périmé jusqu'au rechargement de la page.
  const topicBranch = state?.topics.find((t) => t.id === topicId)?.branch;
  const actionsSucceededIds = (state?.actions ?? [])
    .filter((a) => a.topicId === topicId && a.state === 'succeeded')
    .map((a) => a.id);
  const actionsSucceeded = actionsSucceededIds.slice().sort().join(',');
  // review (re-dev 1/2) : relecture déclenchée par un id d'action succeeded jamais vu, pas par
  // l'ensemble courant — une action purgée de state.actions ne doit pas en déclencher une inutile.
  const brancheVueRef = useRef<string | undefined>(undefined);
  const actionsVuesRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const dejaMonte = actionsVuesRef.current !== null;
    const brancheChangee = dejaMonte && brancheVueRef.current !== topicBranch;
    const nouvelleAction =
      dejaMonte && actionsSucceededIds.some((id) => !actionsVuesRef.current!.has(id));
    brancheVueRef.current = topicBranch;
    actionsVuesRef.current = new Set([...(actionsVuesRef.current ?? []), ...actionsSucceededIds]);
    // au montage : seulement la référence de base, rien à relire.
    if (!dejaMonte || (!brancheChangee && !nouvelleAction)) return;
    relireLive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicBranch, actionsSucceeded]);

  async function revenirSurBranche(dirtyAction?: 'stash') {
    setDeriveErreur(null);
    setDeriveRequesting(true);
    setDeriveActionId(null);
    try {
      const r = await call<{ actionId: string }>(
        'POST',
        `/api/topics/${topicId}/actions/branche.revenir`,
        dirtyAction ? { dirtyAction } : {},
      );
      setDeriveActionId(r.actionId);
    } catch (err) {
      setDeriveErreur(err instanceof AidApiError ? err.message : String(err));
    } finally {
      setDeriveRequesting(false);
    }
  }

  async function rattacherBranche() {
    setRattachErreur(null);
    setRattaching(true);
    try {
      await call('POST', `/api/topics/${topicId}/actions/sujet.rattacher-branche`, {});
      await relireLive();
    } catch (err) {
      setRattachErreur(err instanceof AidApiError ? err.message : String(err));
    } finally {
      setRattaching(false);
    }
  }

  if (!state) {
    return (
      <main className="page sujet-contenu">
        {down ? (
          <section className="zone-erreur" data-node="1-3.erreur">
            <div className="bandeau-erreur" data-node="1-3.erreur.bandeau" role="alert">
              <div className="bandeau-texte">
                <p className="bandeau-titre" data-node="1-3.erreur.bandeau.titre">
                  Impossible de lire l’état du sujet
                </p>
                <p
                  className="texte-discret"
                  data-node="1-3.erreur.bandeau.cause"
                  data-bind="erreur.cause"
                >
                  {daemon === 'session-expiree'
                    ? 'Cause : la session a expiré (le daemon a redémarré).'
                    : `Cause : le daemon est injoignable sur ${window.location.host}.`}
                </p>
              </div>
              {daemon !== 'session-expiree' && (
                <button
                  className="bouton bouton--contour"
                  data-node="1-3.erreur.bandeau.reessayer"
                  data-action="daemon.reconnecter"
                  type="button"
                  onClick={retry}
                >
                  Réessayer
                </button>
              )}
            </div>
          </section>
        ) : (
          <>
            <div className="sujet-entete" data-node="1-3.entete">
              <span className="sq sq--ligne sq--court" />
              <span className="sq sq--titre" />
              <span className="sq sq--puce" />
            </div>
            <div className="sujet-grille sujet-grille--seul">
              <div className="squelette" data-node="1-3.terminaux">
                <span className="sq sq--puce" />
                <span className="sq sq--grand-bloc" />
              </div>
            </div>
          </>
        )}
      </main>
    );
  }

  const topic = state.topics.find((t) => t.id === topicId);
  if (!topic) {
    // 06.10 : /api/state exclut les sujets archivés par défaut, useArchive relit leur
    // journal à part dès qu'ils manquent à l'instantané vivant.
    if (archive.topic) {
      return <EcranArchive topic={archive.topic} events={archive.events} archive={archive} />;
    }
    if (!archive.loaded) {
      return (
        <main className="page sujet-contenu">
          <div className="squelette" data-node="1-3.archive.chargement">
            <span className="sq sq--puce" />
            <span className="sq sq--grand-bloc" />
          </div>
        </main>
      );
    }
    // Un brouillon abandonné par le script lui-même (06.1, afterFailure) : la ligne a
    // disparu, mais l'action (et sa sortie) restent lisibles pour expliquer pourquoi.
    const echec = state.actions.find(
      (a) =>
        a.topicId === topicId &&
        a.action === 'topic.create' &&
        a.state !== 'running' &&
        a.state !== 'succeeded',
    );
    return (
      <main className="page sujet-contenu">
        <section className="zone-erreur" data-node={echec ? '1-3.preparation-echec' : '1-3.vide'}>
          {echec ? (
            <div className="bandeau-erreur" data-node="1-3.preparation-echec.bandeau" role="alert">
              <p className="bandeau-titre" data-node="1-3.preparation-echec.bandeau.titre">
                La préparation du sujet a échoué
              </p>
              <p className="texte-discret" data-node="1-3.preparation-echec.bandeau.cause">
                {(outputs[echec.id] ?? []).at(-1)?.line ??
                  (echec.state === 'needs_human'
                    ? 'Action humaine requise.'
                    : 'La préparation a échoué.')}
              </p>
            </div>
          ) : (
            <p className="vide-message" data-node="1-3.vide.message">
              Sujet introuvable ou archivé.
            </p>
          )}
          <Link className="lien" to="/">
            ← Retour aux sujets
          </Link>
        </section>
      </main>
    );
  }
  const workspace = state.workspaces.find((w) => w.id === topic.workspaceId);
  const worktree = topic.worktree;
  const runIds = state.runs.filter((r) => r.topicId === topic.id).map((r) => r.id);
  const agents: Agent[] = state.agents.filter((a) => runIds.includes(a.runId));
  const active = agents.find((a) => a.id === selectedAgent) ?? agents.at(-1);
  const kinds = [
    ...KINDS,
    ...(state.mesh ? [KIND_CELL] : []),
    ...(state.swairm ? [KIND_SWAIRM_CELL] : []),
  ];

  async function launch(kind: Kind) {
    setErreur(null);
    setMenu('aucun');
    try {
      const a = await call<Agent>('POST', '/api/agents', { topicId, kind });
      onSelectAgent(a.id);
    } catch (err) {
      setErreur(err instanceof AidApiError ? err.message : String(err));
    }
  }

  async function stop(agentId: string) {
    setErreur(null);
    try {
      await call('DELETE', `/api/agents/${agentId}`);
    } catch (err) {
      setErreur(err instanceof AidApiError ? err.message : String(err));
    }
  }

  async function openEditor() {
    setErreur(null);
    try {
      await call('POST', `/api/topics/${topicId}/actions/editor.open`, {});
    } catch (err) {
      setErreur(err instanceof AidApiError ? err.message : String(err));
    }
  }

  // review db76a41 : remet « copié » à faux et annule le minuteur en attente à la fermeture du menu ⋯.
  function fermerMenuPlus() {
    setWorktreeCopie(false);
    if (worktreeCopieTimer.current !== null) {
      clearTimeout(worktreeCopieTimer.current);
      worktreeCopieTimer.current = null;
    }
  }

  // §5.3 : le chemin du worktree quitte les pastilles pour le menu ⋯, copié via le clipboard.
  async function copierWorktree() {
    try {
      await navigator.clipboard.writeText(worktree);
      setWorktreeCopie(true);
      worktreeCopieTimer.current = setTimeout(() => setWorktreeCopie(false), 2000);
    } catch {
      // clipboard indisponible (contexte non sécurisé, permission refusée) : pas de retour
    }
  }

  async function ignorer() {
    setErreur(null);
    setIgnoring(true);
    try {
      await call('POST', `/api/topics/${topicId}/actions/topic.setup-ignorer`, {});
      navigate('/');
    } catch (err) {
      setErreur(err instanceof AidApiError ? err.message : String(err));
      setIgnoring(false);
    }
  }

  // 11.10 (D27/D28) : même motif que le dialogue de changement de branche (besoinHumain,
  // repli du message d'échec sur la dernière ligne de sortie de l'action).
  const deriveEnCours =
    deriveRequesting ||
    (deriveActionId !== null && (!deriveAction || deriveAction.state === 'running'));
  const deriveEchoue =
    !deriveEnCours &&
    deriveActionId !== null &&
    deriveAction !== undefined &&
    deriveAction.state !== 'succeeded';
  const deriveBesoinHumain = deriveEchoue && deriveAction!.state === 'needs_human';
  const deriveMessage =
    deriveErreur ??
    (deriveEchoue
      ? (outputs[deriveActionId!]?.at(-1)?.line ??
        (deriveBesoinHumain
          ? 'Modifications non commitées : revenir sur la branche les écraserait.'
          : 'Le retour sur la branche a échoué.'))
      : null);

  return (
    <main className="page sujet-contenu">
      <div className="sujet-entete" data-node="1-3.entete">
        <div className="sujet-titre-ligne">
          <div className="entete-texte">
            <p className="fil-ariane" data-node="1-3.entete.fil-ariane">
              <Link
                data-node="1-3.entete.workspace"
                data-bind="workspace.nom"
                data-action="nav.accueil"
                to="/"
              >
                {workspace?.name ?? '?'}
              </Link>{' '}
              / sujet
            </p>
            <h1 className="titre-ecran" data-node="1-3.entete.titre" data-bind="sujet.titre">
              {topic.title}
            </h1>
          </div>
          <div className="sujet-actions" data-node="1-3.actions">
            <button
              className="bouton"
              data-node="1-3.actions.editeur"
              data-action="editeur.ouvrir"
              type="button"
              onClick={() => void openEditor()}
              disabled={topic.worktreeMissing}
            >
              Ouvrir dans l’éditeur
            </button>
            {(topic.state !== 'draft' || !topic.worktreeMissing) && (
              <button
                className="bouton-icone"
                data-node="1-3.actions.plus"
                data-action="actions.menu"
                type="button"
                aria-label="Plus d’actions"
                aria-expanded={menu === 'plus'}
                onClick={() => {
                  if (menu === 'plus') fermerMenuPlus();
                  setMenu(menu === 'plus' ? 'aucun' : 'plus');
                }}
              >
                ⋯
              </button>
            )}
            {menu === 'plus' && (topic.state !== 'draft' || !topic.worktreeMissing) && (
              <>
                {topic.state !== 'draft' && (
                  <button
                    className="bouton bouton--danger"
                    data-action="topic.cleanup"
                    type="button"
                    onClick={() => {
                      fermerMenuPlus();
                      setMenu('aucun');
                      void nettoyage.start();
                    }}
                    disabled={nettoyage.phase.phase === 'en-cours'}
                  >
                    Nettoyer le sujet
                  </button>
                )}
                {!topic.worktreeMissing && (
                  <button
                    className="bouton bouton--fantome"
                    data-action="sujet.copier-worktree"
                    type="button"
                    onClick={() => void copierWorktree()}
                  >
                    Copier le chemin du worktree{' '}
                    <span
                      className="chemin-worktree"
                      data-node="1-3.entete.worktree"
                      data-bind="sujet.worktree"
                    >
                      {topic.worktree}
                    </span>
                  </button>
                )}
                {worktreeCopie && (
                  <span className="texte-discret" data-node="1-3.actions.worktree-copie">
                    copié
                  </span>
                )}
              </>
            )}
          </div>
        </div>
        <div className="sujet-meta">
          <span
            className="pastille pastille--etat"
            data-node="1-3.entete.etat"
            data-bind="sujet.etat"
          >
            {topic.state}
          </span>
          <button
            className="pastille pastille--code"
            data-node="1-3.entete.branche"
            data-action="branche.ouvrir-selecteur"
            data-bind="sujet.branche"
            type="button"
            aria-haspopup="dialog"
            aria-expanded={selecteurBranche}
            onClick={() => setSelecteurBranche(true)}
          >
            {topic.branch}
          </button>
          <span className="pastille pastille--discret" data-node="1-3.entete.base">
            base{' '}
            <span data-node="1-3.entete.base.branche" data-bind="sujet.base">
              {workspace?.remote ? `${workspace.remote}/${topic.base}` : topic.base}
            </span>
          </span>
          {topic.indexState !== 'ready' && (
            <span
              className="pastille pastille--discret"
              data-node="1-3.entete.index"
              data-bind="sujet.index"
            >
              {INDEX_LABEL[topic.indexState]}
            </span>
          )}
        </div>
      </div>
      {live && !live.onTopicBranch && (
        <section className="derive" data-node="1-3.derive" role="status">
          <span className="derive-marque" aria-hidden="true">
            !
          </span>
          <p className="derive-texte" data-node="1-3.derive.texte">
            {live.headBranch ? (
              <>
                Le worktree est sur{' '}
                <strong data-node="1-3.derive.head" data-bind="sujet.head">
                  {live.headBranch}
                </strong>
                , pas sur la branche du sujet{' '}
                <strong data-node="1-3.derive.branche-sujet" data-bind="sujet.branche">
                  {topic.branch}
                </strong>
                .
              </>
            ) : (
              'Le worktree est en HEAD détachée : les nouveaux commits n’appartiendront à aucune branche.'
            )}
          </p>
          {deriveMessage && (
            <p className="message-erreur" role="alert">
              {deriveMessage}
            </p>
          )}
          {deriveBesoinHumain ? (
            <button
              className="bouton bouton--contour"
              data-node="1-3.derive.revenir"
              data-action="branche.revenir"
              type="button"
              disabled={deriveEnCours}
              onClick={() => void revenirSurBranche('stash')}
            >
              Mettre de côté et revenir
            </button>
          ) : (
            <button
              className="bouton bouton--contour"
              data-node="1-3.derive.revenir"
              data-action="branche.revenir"
              type="button"
              disabled={deriveEnCours}
              onClick={() => void revenirSurBranche()}
            >
              Revenir sur {topic.branch}
            </button>
          )}
          {live.headBranch && (
            <button
              className="bouton"
              data-node="1-3.derive.rattacher"
              data-action="sujet.rattacher-branche"
              type="button"
              disabled={rattaching}
              onClick={() => void rattacherBranche()}
            >
              Rattacher le sujet à {live.headBranch}
            </button>
          )}
          {rattachErreur && (
            <p className="message-erreur" role="alert">
              {rattachErreur}
            </p>
          )}
        </section>
      )}
      {(erreur || nettoyage.phase.phase === 'refuse') && (
        <p className="message-erreur" role="alert">
          {erreur ?? (nettoyage.phase.phase === 'refuse' ? nettoyage.phase.message : '')}
        </p>
      )}
      {nettoyage.phase.phase === 'confirmer' && (
        <ConfirmerNettoyage
          commits={nettoyage.phase.commits}
          onClose={nettoyage.reset}
          onConfirm={(n) => void nettoyage.start(n)}
        />
      )}
      {selecteurBranche && (
        <SelecteurBranche topicId={topic.id} onClose={() => setSelecteurBranche(false)} />
      )}
      {!vueComplete(topic) ? (
        <div className="sujet-grille sujet-grille--seul">
          <div className="colonne">
            {topic.state === 'draft' ? (
              <section className="zone-erreur" data-node="1-3.preparation">
                <div className="bandeau-erreur" data-node="1-3.preparation.bandeau">
                  <div className="bandeau-texte">
                    <p className="bandeau-titre" data-node="1-3.preparation.bandeau.titre">
                      Préparation du worktree…
                    </p>
                    <p
                      className="texte-discret"
                      data-node="1-3.preparation.bandeau.cause"
                      data-bind="sujet.preparation.cause"
                    >
                      {topic.branch} depuis origin/{topic.base}
                    </p>
                  </div>
                  <button
                    className="bouton bouton--fantome"
                    data-node="1-3.preparation.ignorer"
                    data-action="topic.setup-ignorer"
                    type="button"
                    onClick={() => void ignorer()}
                    disabled={ignoring}
                  >
                    Ignorer
                  </button>
                </div>
                {(() => {
                  const prepa = state.actions.find(
                    (a) => a.topicId === topic.id && a.action === 'topic.create',
                  );
                  const lines = prepa ? (outputs[prepa.id] ?? []) : [];
                  return lines.length > 0 ? (
                    <div
                      className="sortie-action"
                      role="log"
                      aria-label="Préparation du sujet"
                      data-node="1-3.preparation.journal"
                    >
                      {lines.map((l, i) => (
                        <div key={i}>{l.line}</div>
                      ))}
                    </div>
                  ) : null;
                })()}
              </section>
            ) : (
              <section className="zone-erreur" data-node="1-3.erreur">
                <div className="bandeau-erreur" data-node="1-3.erreur.bandeau" role="alert">
                  <p className="bandeau-titre" data-node="1-3.erreur.bandeau.titre">
                    Worktree introuvable
                  </p>
                  <p
                    className="texte-discret"
                    data-node="1-3.erreur.bandeau.cause"
                    data-bind="erreur.cause"
                  >
                    {topic.worktree} a été supprimé hors d’A-I-D : aucun agent ne peut y tourner.
                  </p>
                </div>
              </section>
            )}
            <Memoire
              namespace={workspace?.namespace ?? workspace?.name ?? ''}
              topicSlug={topic.slug}
            />
          </div>
        </div>
      ) : (
        // D.1/D.2 (chantier 15) : les agents sont toujours visibles, plus de barre d'onglets
        // exclusifs ; Git et Fichiers vivent désormais dans PanneauContexte (colonne de droite).
        <div className="sujet-grille sujet-grille--seul">
          <div className="colonne">
            {agents.length === 0 ? (
              <section className="vide" data-node="1-3.vide">
                <p className="vide-message" data-node="1-3.vide.message">
                  Aucun agent ne tourne sur ce sujet.
                </p>
                <p className="texte-discret" data-node="1-3.vide.aide">
                  Le premier lancement de claude ou de codex dans un worktree neuf affiche son
                  propre dialogue de confiance : c’est normal.
                </p>
                <div className="vide-actions">
                  {kinds.map(({ kind, label }) => (
                    <button
                      key={kind}
                      className={`bouton${kind === 'claude' ? ' bouton--primaire' : ''}`}
                      data-node={kind === 'shell' ? '1-3.vide.shell' : `1-3.vide.lancer-${kind}`}
                      data-action="agent.lancer"
                      data-agent={kind}
                      type="button"
                      onClick={() => void launch(kind)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </section>
            ) : (
              <section className="terminaux" data-node="1-3.terminaux" aria-label="Terminaux">
                <div
                  className="onglets"
                  data-node="1-3.terminaux.onglets"
                  role="tablist"
                  aria-label="Agents du sujet"
                >
                  {agents.map((a, i) => {
                    const v = agentView(a);
                    return (
                      <button
                        key={a.id}
                        className={`onglet${a.id === active?.id ? ' est-actif' : ''}`}
                        data-node={`1-3.terminaux.onglet-${i + 1}`}
                        data-action="onglet.choisir"
                        role="tab"
                        aria-selected={a.id === active?.id}
                        type="button"
                        onClick={() => {
                          setArretConfirm(null);
                          onSelectAgent(a.id);
                        }}
                      >
                        <Point tone={v.tone} label={v.label} estimated={v.estimated} />
                        <span
                          data-node={`1-3.terminaux.onglet-${i + 1}.type`}
                          data-bind="agent.type"
                        >
                          {a.kind}
                        </span>
                        <span
                          className="agent-role"
                          data-node={`1-3.terminaux.onglet-${i + 1}.role`}
                          data-bind="agent.role"
                        >
                          {/* « libre » est le rôle d'un agent lancé à la main : à côté de la pastille il se lisait comme son statut */}
                          {a.role === 'free' ? v.label : roleLabel(a.role)}
                        </span>
                      </button>
                    );
                  })}
                  <button
                    className="onglet"
                    data-node="1-3.terminaux.ajouter-agent"
                    data-action="agent.ajouter"
                    type="button"
                    aria-expanded={menu === 'agent'}
                    onClick={() => setMenu(menu === 'agent' ? 'aucun' : 'agent')}
                  >
                    + Agent
                  </button>
                  {menu === 'agent' &&
                    kinds.map(({ kind, label }) => (
                      <button
                        key={kind}
                        className="onglet"
                        data-action="agent.lancer"
                        data-agent={kind}
                        type="button"
                        onClick={() => void launch(kind)}
                      >
                        {label}
                      </button>
                    ))}
                  <div className="onglets-actions">
                    {/* Repères / Tout déplier : portés ici par la Conversation active (createPortal) */}
                    <div className="onglets-actions-portail" ref={setOngletsActionsEl} />
                    {active &&
                      (arretConfirm === active.id ? (
                        <>
                          <button
                            className="bouton bouton--danger"
                            data-node="1-3.terminaux.arreter"
                            data-action="agent.arreter.confirmer"
                            type="button"
                            onClick={() => {
                              setArretConfirm(null);
                              void stop(active.id);
                            }}
                          >
                            Confirmer l’arrêt
                          </button>
                          <button
                            className="bouton bouton--fantome"
                            data-node="1-3.terminaux.arreter.annuler"
                            data-action="agent.arreter.annuler"
                            type="button"
                            onClick={() => setArretConfirm(null)}
                          >
                            Annuler
                          </button>
                        </>
                      ) : (
                        <button
                          className="bouton bouton--fantome"
                          data-node="1-3.terminaux.arreter"
                          data-action={
                            LIVE.includes(active.status) ? 'agent.arreter' : 'agent.fermer'
                          }
                          type="button"
                          onClick={() =>
                            LIVE.includes(active.status)
                              ? setArretConfirm(active.id)
                              : void stop(active.id)
                          }
                        >
                          {LIVE.includes(active.status) ? 'Arrêter' : 'Fermer'}
                        </button>
                      ))}
                  </div>
                </div>
                {agents.map((a) =>
                  a.transport === 'stream' ? (
                    <Conversation
                      key={a.id}
                      agent={a}
                      visible={a.id === active?.id}
                      actionsHost={ongletsActionsEl}
                    />
                  ) : (
                    <Terminal key={a.id} agentId={a.id} visible={a.id === active?.id} />
                  ),
                )}
              </section>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

// 06.10 (écran 2.9) : chronologie en lecture seule + oubli du stash, sans nouvelle table.
function EcranArchive({
  topic,
  events,
  archive,
}: {
  topic: ArchivedTopic;
  events: StoredEvent[];
  archive: ReturnType<typeof useArchive>;
}) {
  return (
    <main className="page sujet-contenu">
      <div className="sujet-entete" data-node="1-3.archive.entete">
        <div className="entete-texte">
          <p className="fil-ariane" data-node="1-3.archive.fil-ariane">
            <Link data-action="nav.accueil" to="/">
              Sujets
            </Link>{' '}
            / archive
          </p>
          <h1 className="titre-ecran" data-node="1-3.archive.titre">
            {topic.title}
          </h1>
        </div>
        <div className="sujet-meta">
          <span className="pastille pastille--etat" data-node="1-3.archive.etat">
            {topic.state}
          </span>
          <span className="pastille pastille--code" data-node="1-3.archive.branche">
            {topic.branch}
          </span>
          <span className="pastille pastille--discret" data-node="1-3.archive.base">
            base origin/{topic.base}
          </span>
          <span className="pastille pastille--discret" data-node="1-3.archive.worktree">
            worktree supprimé
          </span>
        </div>
      </div>
      <section
        className="carte-panneau archive-panneau"
        data-node="1-3.archive.panneau"
        aria-label="Sujet archivé"
      >
        <h2 className="titre-panneau" data-node="1-3.archive.panneau.titre">
          Sujet archivé
        </h2>
        <ol
          className="chronologie"
          data-node="1-3.archive.chronologie"
          aria-label="Chronologie du sujet"
        >
          {events.map((e) => (
            <li className="chrono" key={e.seq}>
              <span className="chrono-heure">{new Date(e.ts).toLocaleTimeString('fr-FR')}</span>
              <span className="chrono-texte">{libelleEvenement(e)}</span>
            </li>
          ))}
        </ol>
        {topic.stashRef && (
          <div className="archive-stash" data-node="1-3.archive.stash">
            <p className="texte-faible" data-node="1-3.archive.stash.note">
              Stash récupérable manuellement : <code>git stash list</code>.
            </p>
            <button
              className="bouton bouton--fantome"
              type="button"
              data-node="1-3.archive.stash.oublier"
              data-action="archive.oublier-stash"
              onClick={() => void archive.oublierStash()}
              disabled={archive.oubli === 'en-cours'}
            >
              Retirer la mention du stash
            </button>
          </div>
        )}
        {archive.oubliMessage && (
          <p className="texte-discret" data-node="1-3.archive.stash.resultat">
            {archive.oubliMessage}
          </p>
        )}
      </section>
    </main>
  );
}

export function Sujet() {
  const { topicId = '' } = useParams();
  const { state } = useAid();
  const [params] = useSearchParams();
  // « Ouvrir le terminal → » de la boîte de réception arrive avec ?agent= : son onglet est choisi.
  const [selectedAgent, setSelectedAgent] = useState<string | null>(params.get('agent'));
  // D.2 : ?onglet=git|fichiers sélectionne l'onglet correspondant de PanneauContexte (déplacé
  // depuis la barre d'onglets exclusifs, retirée au profit des agents toujours visibles).
  const ongletParam = params.get('onglet');
  const initialOnglet =
    ongletParam === 'git' || ongletParam === 'fichiers' ? ongletParam : undefined;
  const topic = state?.topics.find((t) => t.id === topicId);

  // La grille trois colonnes et le volet panneau n'existent que pour la vue complète de Contenu
  // (agents/terminaux) : jamais pendant le chargement, une erreur, une archive ou la préparation
  // du worktree, qui restent à une colonne comme avant ce chantier. La navigation (ex-Cote) est
  // posée par Layout sur les deux branches, B.2.
  if (!topic || !vueComplete(topic)) {
    return (
      <Layout screen="1-3">
        <div className="sujet-corps">
          <Contenu
            topicId={topicId}
            selectedAgent={selectedAgent}
            onSelectAgent={setSelectedAgent}
          />
        </div>
      </Layout>
    );
  }

  const workspace = state?.workspaces.find((w) => w.id === topic.workspaceId);
  const runIds = state?.runs.filter((r) => r.topicId === topicId).map((r) => r.id) ?? [];
  const agents = state?.agents.filter((a) => runIds.includes(a.runId)) ?? [];
  const active = agents.find((a) => a.id === selectedAgent) ?? agents.at(-1);
  const namespace = workspace?.namespace ?? workspace?.name ?? '';

  return (
    <Layout screen="1-3">
      <SujetPanneau
        topic={topic}
        topicId={topicId}
        namespace={namespace}
        remote={workspace?.remote ?? null}
        activeAgentId={active?.id ?? null}
        initialOnglet={initialOnglet}
        selectedAgent={selectedAgent}
        onSelectAgent={setSelectedAgent}
      />
    </Layout>
  );
}

// Le panneau du sujet lit `overlay` depuis Layout (B.2) : il doit être rendu sous <Layout> pour
// atteindre son contexte, d'où cette extraction (ne peut pas rester inline dans Sujet()).
function SujetPanneau({
  topic,
  topicId,
  namespace,
  remote,
  activeAgentId,
  initialOnglet,
  selectedAgent,
  onSelectAgent,
}: {
  topic: Topic;
  topicId: string;
  namespace: string;
  remote: string | null;
  activeAgentId: string | null;
  initialOnglet: 'git' | 'fichiers' | undefined;
  selectedAgent: string | null;
  onSelectAgent: (id: string | null) => void;
}) {
  const { overlay, setOverlay } = useLayout();
  const boutonPanneauRef = useRef<HTMLButtonElement>(null);
  // review D (finding 2) : une pop-up ouverte rend inerte tout le reste — colonne centrale,
  // le bouton flottant — pour que Tab/aria-modal décrivent une vraie modale.
  const popupOuvert = overlay !== 'aucun';
  return (
    <div className="sujet-corps">
      <div style={{ display: 'contents' }} inert={popupOuvert || undefined}>
        <Contenu topicId={topicId} selectedAgent={selectedAgent} onSelectAgent={onSelectAgent} />
      </div>
      <Volet
        screen="1-3"
        nom="panneau"
        titre="Panneau du sujet"
        ouvert={overlay === 'panneau'}
        inert={popupOuvert && overlay !== 'panneau'}
        onFermer={() => setOverlay('aucun')}
        boutonRef={boutonPanneauRef}
      >
        <PanneauContexte
          namespace={namespace}
          topicSlug={topic.slug}
          topicId={topicId}
          base={topic.base}
          remote={remote}
          activeAgentId={activeAgentId}
          initialOnglet={initialOnglet}
        />
      </Volet>
      <button
        ref={boutonPanneauRef}
        className="bouton-icone bouton-volant bouton-volant--panneau"
        data-node="1-3.volet.ouvrir-panneau"
        type="button"
        aria-label="Ouvrir le panneau du sujet"
        aria-expanded={overlay === 'panneau'}
        inert={popupOuvert || undefined}
        onClick={() => setOverlay(overlay === 'panneau' ? 'aucun' : 'panneau')}
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16">
          <path d="M2 5h4l1.3 1.6H14V12H2z" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
      {overlay === 'panneau' && (
        // .voile : fond déjà utilisé par Dialogue.tsx (chantier 11), réutilisé ici tel quel.
        <div
          className="voile"
          data-node="1-3.volet.panneau.fond"
          aria-hidden="true"
          onClick={() => setOverlay('aucun')}
        />
      )}
    </div>
  );
}

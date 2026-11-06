import { type ReactNode, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Agent, MeshDm, Topic, Workspace } from '../../../src/shared/model.js';
import type { StateSnapshot } from '../../../src/shared/state.js';
import { useAid } from '../data/useAidState.js';
import {
  agentsDeLaBoite,
  compterNatures,
  NATURES,
  type Nature,
  natureDm,
  resumeTour,
} from '../ui/boiteVue.js';
import { depuis } from '../ui/depuis.js';
import { A_TRAITER, Layout, useLayout } from '../ui/Layout.js';
import { agentView, isAlive, type StatusView, type Tone } from '../ui/Statut.js';

type Groupe = Exclude<Tone, 'inactif'>;

// Chantier 28 (D136) : trois sections par nature. Décisions et À relire à gauche, Informations à droite.
const SOUS_TITRE: Record<Nature, string> = {
  decision: 'toi seul peux les prendre',
  relire: 'tours terminés',
  information: 'rien à faire de ton côté',
};

const RAPPEL_PAIR =
  'Rien n’a été lancé. Un message de pair ne vaut pas autorisation, et sa cell n’a aucun accès à ta machine ni à tes sessions.';

interface Element {
  agent: Agent;
  topic: Topic;
  workspace: Workspace | undefined;
  nature: Nature;
  view: StatusView;
  at: string;
}

const duree = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
};

function typeLabel(e: Element): string {
  const a = e.agent;
  if (a.status === 'needs_input' && !a.pausedAt) {
    const kind = a.pending?.kind ?? a.statusReason;
    if (kind === 'permission') return 'Permission';
    if (kind === 'question') return 'Question';
  }
  return e.view.label;
}

function detail(e: Element): string | null {
  const a = e.agent;
  if (e.view.tone === 'pause') return 'Process suspendu : il reprendra là où il s’est arrêté.';
  if (a.status === 'error')
    return a.exitCode === null
      ? 'Sortie en erreur (arrêté par un signal)'
      : `Sortie en erreur (code ${a.exitCode})`;
  if (a.status === 'needs_input')
    return a.pending?.question ?? a.statusMessage ?? a.statusDetail?.lastLine ?? null;
  if (a.status === 'idle' && e.view.estimated && a.statusDetail?.silenceMs !== undefined)
    return `Terminal silencieux depuis ${duree(a.statusDetail.silenceMs)}`;
  if (a.status === 'working') return a.lastTool ?? a.statusMessage;
  // D139 : un tour à relire se résume par la première ligne de son dernier message
  return resumeTour(a.statusMessage);
}

/** Une décision d'agent porte une question : en attente, ou un tour fini sur une question (D136). */
const estQuestion = (a: Agent) => a.status === 'needs_input' || a.statusReason === 'question';

function Article({ n, e }: { n: number; e: Element }) {
  const { call } = useAid();
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const id = (rest: string) => `1-2.liste.element-${n}.${rest}`;
  const a = e.agent;
  const tone = e.view.tone as Groupe;
  const texte = detail(e);
  const options = a.status === 'needs_input' && !a.pausedAt ? (a.pending?.options ?? []) : [];
  const versAgent = `/sujets/${e.topic.id}?agent=${a.id}`;
  // D139 : une PR ouverte se livre (D134), sinon le tour se relit
  const livrer = e.topic.prNumber !== null && e.topic.state !== 'merged';
  const agir = async (path: string, body?: unknown) => {
    setBusy(true);
    setErreur(null);
    try {
      await call('POST', `/api/agents/${a.id}/${path}`, body);
    } catch (err) {
      setErreur(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article
      className={`element element--${tone}`}
      data-node={`1-2.liste.element-${n}`}
      aria-label={`${a.kind} · ${e.topic.branch}`}
    >
      <div className="element-entete">
        <span
          className={`badge badge--${tone}${e.view.estimated ? ' badge--estime' : ''}`}
          data-node={id('type')}
          data-bind="agent.statut"
        >
          {typeLabel(e)}
          {e.view.estimated && (
            <>
              {' '}
              <span data-node={id('estime')} data-bind="agent.source">
                · estimé
              </span>
            </>
          )}
        </span>
        <span className="identifiant" data-node={id('agent')} data-bind="agent.type">
          {a.kind}
        </span>
        <span className="element-sujet">
          <span data-node={id('workspace')} data-bind="workspace.nom">
            {e.workspace?.name ?? '?'}
          </span>{' '}
          /{' '}
          <span data-node={id('branche')} data-bind="sujet.branche">
            {e.topic.branch}
          </span>
        </span>
        {e.nature === 'decision' && (
          <span className="boite-repere" data-node={id('repere')}>
            {e.topic.phase && (
              <span data-node={id('etape')} data-bind="sujet.phase">
                étape {e.topic.phase} ·{' '}
              </span>
            )}
            <span data-node={id('machine')}>Mac local</span>
          </span>
        )}
        <span className="element-moment" data-node={id('moment')} data-bind="evenement.moment">
          {depuis(e.at)}
        </span>
      </div>
      {texte &&
        (e.nature === 'decision' && estQuestion(a) ? (
          <p className="element-question" data-node={id('question')} data-bind="demande.question">
            {texte}
          </p>
        ) : (
          <p className="element-detail" data-node={id('detail')}>
            {texte}
          </p>
        ))}
      {tone === 'cours' && (
        <p className="texte-faible" data-node={id('rien')}>
          Rien à faire de ton côté.
        </p>
      )}
      {tone !== 'cours' && (
        <div className="element-actions">
          {options.map((o, i) => (
            <button
              key={o.answer}
              className={`bouton${i === 0 ? ' bouton--primaire' : ''}`}
              data-node={id(`option-${i + 1}`)}
              data-bind="demande.option"
              data-action="demande.repondre"
              type="button"
              disabled={busy}
              onClick={() => void agir('answer', { pendingId: a.pending!.id, answer: o.answer })}
            >
              {o.label}
            </button>
          ))}
          {tone === 'pause' ? (
            <button
              className="bouton"
              data-node={id('reprendre')}
              data-action="run.reprendre"
              type="button"
              disabled={busy}
              onClick={() => void agir('resume')}
            >
              Reprendre
            </button>
          ) : e.nature === 'decision' ? (
            <Link
              className="lien boite-contexte"
              data-node={id('contexte')}
              data-action="sujet.contexte"
              to={versAgent}
            >
              Voir le contexte
            </Link>
          ) : tone === 'erreur' ? (
            <Link
              className="lien"
              data-node={id('ouvrir')}
              data-action="terminal.ouvrir"
              to={versAgent}
            >
              Ouvrir le terminal →
            </Link>
          ) : livrer ? (
            <Link
              className="bouton"
              data-node={id('livrer')}
              data-action="sujet.livrer"
              to={`/sujets/${e.topic.id}/livraison`}
            >
              Livrer
            </Link>
          ) : (
            <Link
              className="bouton"
              data-node={id('relire')}
              data-action="tour.relire"
              to={versAgent}
            >
              Relire
            </Link>
          )}
        </div>
      )}
      {erreur && (
        <p className="message-erreur" role="alert" data-node={id('erreur')}>
          {erreur}
        </p>
      )}
    </article>
  );
}

const KIND_LABEL: Record<MeshDm['kind'], string> = {
  question: 'Question',
  unblock: 'Déblocage',
  fyi: 'Info',
  status: 'Statut',
  answer: 'Réponse',
};

/**
 * « Ouvrir la cell » (12.6) : la cell vit déjà ⇒ son terminal ; sinon choisir le sujet actif dans le worktree
 * duquel elle s'ouvre (une seule session par cell, le daemon refuse la seconde en 409).
 */
function OuvrirCell({ n, state }: { n: number; state: StateSnapshot }) {
  const { call } = useAid();
  const navigate = useNavigate();
  const [choix, setChoix] = useState(false);
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const id = (rest = '') => `1-2.mesh.dm-${n}.cell${rest ? `.${rest}` : ''}`;
  const cell = state.agents.find((a) => a.kind === 'swarph-cell' && isAlive(a));
  if (cell) {
    const topicId = state.runs.find((r) => r.id === cell.runId)?.topicId ?? '';
    return (
      <Link
        className="lien"
        data-node={id()}
        data-action="cell.ouvrir"
        to={`/sujets/${topicId}?agent=${cell.id}`}
      >
        Ouvrir la cell →
      </Link>
    );
  }
  const actifs = state.topics.filter((t) => t.state === 'active' && !t.worktreeMissing);
  const lancer = async (topicId: string) => {
    setBusy(true);
    setErreur(null);
    try {
      const a = await call<Agent>('POST', '/api/agents', { topicId, kind: 'swarph-cell' });
      navigate(`/sujets/${topicId}?agent=${a.id}`);
    } catch (err) {
      setErreur(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        className="bouton"
        data-node={id()}
        data-action="cell.ouvrir"
        type="button"
        aria-expanded={choix}
        disabled={busy || actifs.length === 0}
        title={
          actifs.length === 0
            ? 'Aucun sujet actif : la cell s’ouvre dans le worktree d’un sujet'
            : undefined
        }
        onClick={() => setChoix(!choix)}
      >
        Ouvrir la cell
      </button>
      {choix && (
        <span className="groupe-filtres" role="group" aria-label="Dans quel sujet ?">
          {actifs.map((t, i) => (
            <button
              key={t.id}
              className="puce-filtre"
              data-node={id(`sujet-${i + 1}`)}
              data-action="cell.lancer"
              type="button"
              disabled={busy}
              onClick={() => void lancer(t.id)}
            >
              {t.branch}
            </button>
          ))}
        </span>
      )}
      {erreur && (
        <p className="message-erreur" role="alert" data-node={id('erreur')}>
          {erreur}
        </p>
      )}
    </>
  );
}

/**
 * Un DM du mesh (12.5). Le contenu est une donnée d'un pair : rendu en texte brut dans un bloc encadré,
 * jamais interprété (même raison que D30). « Vu » le retire de la Boîte (12.4). Chantier 28 (D137) : il garde
 * son origine ; une demande rappelle que rien n'a été lancé, et « En faire une décision » la passe en Décisions.
 */
function ArticleMesh({ n, dm, state }: { n: number; dm: MeshDm; state: StateSnapshot }) {
  const { call, refresh } = useAid();
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const id = (rest: string) => `1-2.mesh.dm-${n}.${rest}`;
  const enDecision = natureDm(dm) === 'decision';
  const urgent = enDecision || A_TRAITER.has(dm.kind);
  const marquer = async (marque: 'seen' | 'decision') => {
    setBusy(true);
    setErreur(null);
    try {
      await call('POST', `/api/mesh/dm/${dm.id}/${marque}`);
      // les marques sont locales (12.4, D137) : aucun événement ne les porte, l'instantané se relit ici
      await refresh();
    } catch (err) {
      setErreur(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article
      className={`element${urgent ? ' element--attente' : ''}`}
      data-node={`1-2.mesh.dm-${n}`}
      aria-label={`${dm.from} · ${KIND_LABEL[dm.kind]}`}
    >
      <div className="element-entete">
        <span
          className={`badge${urgent ? ' badge--attente' : ''}`}
          data-node={id('type')}
          data-bind="mesh.kind"
        >
          {KIND_LABEL[dm.kind]}
        </span>
        <span className="texte-faible" data-node={id('source')}>
          mesh
        </span>
        <span className="identifiant" data-node={id('emetteur')} data-bind="mesh.emetteur">
          {dm.from}
        </span>
        {dm.threadId && (
          <span className="texte-faible" data-node={id('fil')} data-bind="mesh.fil">
            fil {dm.threadId.slice(0, 8)}
          </span>
        )}
        <span className="element-moment" data-node={id('moment')} data-bind="evenement.moment">
          {depuis(dm.createdAt)}
        </span>
      </div>
      <div className="mesh-contenu" data-node={id('contenu')}>
        <span className="texte-faible" data-node={id('contenu.origine')}>
          donnée d’un pair du mesh
        </span>
        <pre className="mesh-texte" data-bind="mesh.contenu">
          {dm.content}
        </pre>
      </div>
      {urgent && (
        <p className="boite-rappel" data-node={id('rappel')}>
          {RAPPEL_PAIR}
        </p>
      )}
      <div className="element-actions">
        {!enDecision && (
          <button
            className="bouton"
            data-node={id('decision')}
            data-action="mesh.decision"
            type="button"
            disabled={busy}
            onClick={() => void marquer('decision')}
          >
            En faire une décision
          </button>
        )}
        <button
          className="bouton"
          data-node={id('vu')}
          data-action="mesh.vu"
          type="button"
          disabled={busy}
          onClick={() => void marquer('seen')}
        >
          Vu
        </button>
        <OuvrirCell n={n} state={state} />
      </div>
      {erreur && (
        <p className="message-erreur" role="alert" data-node={id('erreur')}>
          {erreur}
        </p>
      )}
    </article>
  );
}

/** L'état du mesh, en tête des Informations : la cell, les DM non vus, la connexion. */
function EtatMesh({ state }: { state: StateSnapshot }) {
  const mesh = state.mesh!;
  const nonVus = mesh.inbox.filter((d) => !d.seenAt).length;
  return (
    <div
      className="groupe-entete boite-mesh"
      data-node="1-2.mesh"
      aria-label={`Mesh · ${mesh.state.cell}`}
    >
      <span className="titre-zone" data-node="1-2.mesh.titre">
        Mesh · {mesh.state.cell}
      </span>
      <span className="texte-faible" data-node="1-2.mesh.compte">
        {nonVus}
      </span>
      <span className="texte-faible" data-node="1-2.mesh.etat" data-bind="mesh.etat">
        {mesh.state.connected ? 'connecté' : 'hors mesh'}
      </span>
      {nonVus === 0 && (
        <span className="texte-discret" data-node="1-2.mesh.vide">
          Aucun message à lire.
        </span>
      )}
    </div>
  );
}

function Section({
  nature,
  compte,
  children,
}: {
  nature: Nature;
  compte: number;
  children: ReactNode;
}) {
  const titre = NATURES.find((x) => x.id === nature)!.titre;
  return (
    <section
      className={`groupe boite-section boite-section--${nature}`}
      data-node={`1-2.liste.groupe-${nature}`}
      aria-label={titre}
    >
      <div className="groupe-entete">
        <h2
          className="titre-zone boite-section-titre"
          data-node={`1-2.liste.groupe-${nature}.titre`}
        >
          {titre} · {SOUS_TITRE[nature]}
        </h2>
        <span className="texte-faible" data-node={`1-2.liste.groupe-${nature}.compte`}>
          {compte}
        </span>
      </div>
      {children}
    </section>
  );
}

const plusAncien = (x: Element, y: Element) => x.at.localeCompare(y.at);
const plusRecent = (x: Element, y: Element) => y.at.localeCompare(x.at);

function Contenu() {
  const { state, daemon, retry } = useAid();
  const { openNewTopic } = useLayout();
  const [filtre, setFiltre] = useState<string | null>(null);
  const [nature, setNature] = useState<Nature | 'tout'>('tout');
  const down = daemon === 'injoignable' || daemon === 'session-expiree';
  const entete = (resume: ReactNode, filtres?: ReactNode) => (
    <div className="entete" data-node="1-2.entete">
      <div className="entete-texte">
        <h1 className="titre-ecran" data-node="1-2.entete.titre">
          Boîte de réception
        </h1>
        <p className="resume" data-node="1-2.entete.resume">
          {resume}
        </p>
      </div>
      {filtres}
    </div>
  );

  if (!state) {
    return (
      <main className="page">
        {entete(
          down ? 'Boîte de réception indisponible' : <span className="sq sq--ligne sq--moyen" />,
        )}
        {down ? (
          <section className="zone-erreur" data-node="1-2.erreur">
            <div className="bandeau-erreur" data-node="1-2.erreur.bandeau" role="alert">
              <div className="bandeau-texte">
                <p className="bandeau-titre" data-node="1-2.erreur.bandeau.titre">
                  Impossible de lire la boîte de réception
                </p>
                <p
                  className="texte-discret"
                  data-node="1-2.erreur.bandeau.cause"
                  data-bind="erreur.cause"
                >
                  {daemon === 'session-expiree'
                    ? 'Cause : la session a expiré (le daemon a redémarré).'
                    : `Cause : le daemon est injoignable sur ${window.location.host} (connexion refusée).`}
                </p>
                <p className="texte-faible" data-node="1-2.erreur.bandeau.aide">
                  Les notifications reprendront dès que le daemon répond.
                </p>
              </div>
              {daemon !== 'session-expiree' && (
                <button
                  className="bouton bouton--contour"
                  data-node="1-2.erreur.bandeau.reessayer"
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
          <div className="boite-colonnes">
            <div className="liste" data-node="1-2.liste" aria-busy="true">
              {[1, 2, 3, 4].map((n) => (
                <div
                  key={n}
                  className="squelette"
                  data-node={`1-2.liste.squelette-${n}`}
                  aria-hidden="true"
                >
                  <span className="sq sq--puce" />
                  <span className="sq sq--ligne sq--moyen" />
                  <span className="sq sq--ligne sq--court" />
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    );
  }

  const elements: Element[] = agentsDeLaBoite(state, filtre).map(({ agent: a, topic, nature }) => ({
    agent: a,
    topic,
    workspace: state.workspaces.find((w) => w.id === topic.workspaceId),
    nature,
    view: agentView(a, 'boite'),
    at: (a.pausedAt && isAlive(a) ? a.pausedAt : a.statusAt) ?? a.updatedAt,
  }));
  // les DM ne sont rattachés à aucun projet : le filtre de projet ne les touche pas
  const dms = (state.mesh?.inbox ?? []).filter((d) => natureDm(d) !== null);
  const deNature = (n: Nature) => elements.filter((e) => e.nature === n);
  // D136 : l'attente la plus ancienne d'abord ; à relire, les erreurs puis les tours les plus récents ;
  // en information, le travail en cours puis les pauses
  const agentsPar: Record<Nature, Element[]> = {
    decision: deNature('decision').sort(plusAncien),
    relire: [
      ...deNature('relire')
        .filter((e) => e.view.tone === 'erreur')
        .sort(plusAncien),
      ...deNature('relire')
        .filter((e) => e.view.tone !== 'erreur')
        .sort(plusRecent),
    ],
    information: [
      ...deNature('information')
        .filter((e) => e.view.tone === 'cours')
        .sort(plusRecent),
      ...deNature('information')
        .filter((e) => e.view.tone === 'pause')
        .sort(plusRecent),
    ],
  };
  const dmsPar: Record<Nature, MeshDm[]> = {
    decision: dms.filter((d) => natureDm(d) === 'decision').sort((x, y) => x.id - y.id),
    relire: [],
    information: dms.filter((d) => natureDm(d) === 'information').sort((x, y) => y.id - x.id),
  };
  const comptes = compterNatures([
    ...elements.map((e) => e.nature),
    ...dms.map((d) => natureDm(d)!),
  ]);
  // numérotation continue d'une section à l'autre, comme dans la maquette
  const ordre: Nature[] = ['decision', 'relire', 'information'];
  const numero = new Map(ordre.flatMap((n) => agentsPar[n]).map((e, i) => [e.agent.id, i + 1]));
  const numeroDm = new Map(ordre.flatMap((n) => dmsPar[n]).map((d, i) => [d.id, i + 1]));
  const visible = (n: Nature) => nature === 'tout' || nature === n;

  const filtres = (
    <div className="filtres" data-node="1-2.filtres">
      <div className="groupe-filtres" role="group" aria-label="Filtrer par nature">
        {[{ id: 'tout' as const, titre: 'Tout' }, ...NATURES].map((x) => (
          <button
            key={x.id}
            className={`puce-filtre${nature === x.id ? ' est-actif' : ''}`}
            data-node={`1-2.filtres.nature-${x.id}`}
            data-action="filtre.nature"
            type="button"
            aria-pressed={nature === x.id}
            onClick={() => setNature(x.id)}
          >
            {x.titre}{' '}
            <span className="texte-faible" data-node={`1-2.filtres.nature-${x.id}.compte`}>
              {comptes[x.id]}
            </span>
          </button>
        ))}
      </div>
      {state.workspaces.length > 0 && (
        <div className="groupe-filtres" role="group" aria-label="Filtrer par workspace">
          <button
            className={`puce-filtre${filtre === null ? ' est-actif' : ''}`}
            data-node="1-2.filtres.workspace-tous"
            data-action="filtre.workspace"
            type="button"
            aria-pressed={filtre === null}
            onClick={() => setFiltre(null)}
          >
            Tous
          </button>
          {state.workspaces.map((w, i) => (
            <button
              key={w.id}
              className={`puce-filtre${filtre === w.id ? ' est-actif' : ''}`}
              data-node={`1-2.filtres.workspace-${i + 1}`}
              data-action="filtre.workspace"
              type="button"
              aria-pressed={filtre === w.id}
              onClick={() => setFiltre(w.id)}
            >
              <span data-node={`1-2.filtres.workspace-${i + 1}.nom`} data-bind="workspace.nom">
                {w.name}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
  const sousTitre = state.mesh ? 'Agents de ce Mac et messages du mesh' : 'Agents de ce Mac';

  if (comptes.tout === 0) {
    return (
      <main className="page">
        {entete(sousTitre, filtres)}
        <section className="vide" data-node="1-2.vide">
          <p className="vide-message" data-node="1-2.vide.message">
            Rien à traiter : aucun agent n’attend ta réponse.
          </p>
          <div className="vide-actions">
            <button
              className="bouton bouton--primaire"
              data-node="1-2.vide.creer"
              data-action="sujet.creer"
              type="button"
              onClick={() => openNewTopic(filtre ?? undefined)}
            >
              Nouveau sujet
            </button>
            <Link className="lien" data-node="1-2.vide.accueil" data-action="nav.accueil" to="/">
              Retour à l’accueil →
            </Link>
          </div>
        </section>
        {state.mesh && <EtatMesh state={state} />}
      </main>
    );
  }

  const section = (n: Nature) =>
    visible(n) && (
      <Section key={n} nature={n} compte={comptes[n]}>
        {n === 'information' && state.mesh && <EtatMesh state={state} />}
        {comptes[n] === 0 && (
          <p className="texte-discret" data-node={`1-2.liste.groupe-${n}.vide`}>
            Rien ici pour le moment.
          </p>
        )}
        {dmsPar[n].map((d) => (
          <ArticleMesh key={`dm-${d.id}`} n={numeroDm.get(d.id)!} dm={d} state={state} />
        ))}
        {agentsPar[n].map((e) => (
          <Article key={e.agent.id} n={numero.get(e.agent.id)!} e={e} />
        ))}
      </Section>
    );
  const gauche = visible('decision') || visible('relire');
  const droite = visible('information');
  return (
    <main className="page">
      {entete(sousTitre, filtres)}
      <div className={`boite-colonnes${gauche && droite ? '' : ' boite-colonnes--une'}`}>
        {gauche && (
          <div className="liste" data-node="1-2.liste">
            {section('decision')}
            {section('relire')}
          </div>
        )}
        {droite && (
          <div className="liste" data-node="1-2.infos">
            {section('information')}
          </div>
        )}
      </div>
    </main>
  );
}

export function Boite() {
  return (
    <Layout screen="1-2">
      <Contenu />
    </Layout>
  );
}

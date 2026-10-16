import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import type { Agent, Topic, Workspace } from '../../../src/shared/model.js';
import { useAid } from '../data/useAidState.js';
import { depuis } from '../ui/depuis.js';
import { Layout, useLayout } from '../ui/Layout.js';
import { agentView, isAlive, type StatusView, type Tone } from '../ui/Statut.js';

type Groupe = Exclude<Tone, 'inactif'>;
const GROUPES: { tone: Groupe; titre: string }[] = [
  { tone: 'attente', titre: 'Attend une réponse' },
  { tone: 'erreur', titre: 'Erreur' },
  { tone: 'relire', titre: 'À relire' },
  { tone: 'cours', titre: 'En cours' },
  { tone: 'pause', titre: 'En pause' },
];
// l'attente et les erreurs les plus anciennes d'abord : ce sont elles qui bloquent depuis le plus longtemps
const PLUS_ANCIEN_DABORD = new Set<Groupe>(['attente', 'erreur']);

interface Element {
  agent: Agent;
  topic: Topic;
  workspace: Workspace | undefined;
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
  return a.statusMessage;
}

function Article({ n, e }: { n: number; e: Element }) {
  const { call } = useAid();
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const id = (rest: string) => `1-2.liste.element-${n}.${rest}`;
  const a = e.agent;
  const tone = e.view.tone as Groupe;
  const texte = detail(e);
  const options = a.status === 'needs_input' && !a.pausedAt ? (a.pending?.options ?? []) : [];
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
        <span className="element-moment" data-node={id('moment')} data-bind="evenement.moment">
          {depuis(e.at)}
        </span>
      </div>
      {texte &&
        (a.status === 'needs_input' ? (
          <p className="element-question" data-node={id('question')} data-bind="demande.question">
            {texte}
          </p>
        ) : (
          <p className="element-detail" data-node={id('detail')}>
            {texte}
          </p>
        ))}
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
          ) : (
            <Link
              className="lien"
              data-node={id('ouvrir')}
              data-action="terminal.ouvrir"
              to={`/sujets/${e.topic.id}?agent=${a.id}`}
            >
              Ouvrir le terminal →
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

function Contenu() {
  const { state, daemon, retry } = useAid();
  const { openNewTopic } = useLayout();
  const [filtre, setFiltre] = useState<string | null>(null);
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

  const topicOfRun = new Map(state.runs.map((r) => [r.id, r.topicId]));
  const topics = new Map(state.topics.map((t) => [t.id, t]));
  const elements: Element[] = [];
  for (const a of state.agents) {
    const topic = topics.get(topicOfRun.get(a.runId) ?? '');
    if (!topic || (filtre && topic.workspaceId !== filtre)) continue;
    // un agent vivant, ou sorti en erreur d'un sujet encore ouvert : terminé ou arrêté, un agent est
    // « inactif », comme un shell vivant, et n'a rien à dire ici
    const view = agentView(a, 'boite');
    if (view.tone === 'inactif') continue;
    elements.push({
      agent: a,
      topic,
      workspace: state.workspaces.find((w) => w.id === topic.workspaceId),
      view,
      at: (a.pausedAt && isAlive(a) ? a.pausedAt : a.statusAt) ?? a.updatedAt,
    });
  }
  const groupes = GROUPES.map((g) => ({
    ...g,
    items: elements
      .filter((e) => e.view.tone === g.tone)
      .sort((x, y) => (PLUS_ANCIEN_DABORD.has(g.tone) ? 1 : -1) * x.at.localeCompare(y.at)),
  })).filter((g) => g.items.length > 0);
  // numérotation continue d'un groupe à l'autre, comme dans la maquette
  const numero = new Map(groupes.flatMap((g) => g.items).map((e, i) => [e.agent.id, i + 1]));
  const nSujets = new Set(elements.map((e) => e.topic.id)).size;
  const filtres = state.workspaces.length > 0 && (
    <div className="filtres" data-node="1-2.filtres">
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
    </div>
  );

  if (elements.length === 0) {
    return (
      <main className="page">
        {entete(
          <>
            <span data-node="1-2.entete.resume.elements" data-bind="resume.elements">
              0
            </span>{' '}
            élément
          </>,
          filtres,
        )}
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
      </main>
    );
  }

  return (
    <main className="page">
      {entete(
        <>
          <span data-node="1-2.entete.resume.elements" data-bind="resume.elements">
            {elements.length}
          </span>{' '}
          élément{elements.length > 1 ? 's' : ''} sur{' '}
          <span data-node="1-2.entete.resume.sujets" data-bind="resume.sujets">
            {nSujets}
          </span>{' '}
          sujet{nSujets > 1 ? 's' : ''} · triés par urgence
        </>,
        filtres,
      )}
      <div className="boite-colonnes">
        <div className="liste" data-node="1-2.liste">
          {groupes.map((g) => (
            <section
              key={g.tone}
              className="groupe"
              data-node={`1-2.liste.groupe-${g.tone}`}
              aria-label={g.titre}
            >
              <div className="groupe-entete">
                <h2
                  className={`titre-zone titre-zone--${g.tone}`}
                  data-node={`1-2.liste.groupe-${g.tone}.titre`}
                >
                  {g.titre}
                </h2>
                <span className="texte-faible" data-node={`1-2.liste.groupe-${g.tone}.compte`}>
                  {g.items.length}
                </span>
              </div>
              {g.items.map((e) => (
                <Article key={e.agent.id} n={numero.get(e.agent.id)!} e={e} />
              ))}
            </section>
          ))}
        </div>
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

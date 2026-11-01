import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { Agent, ServerStatus } from '../../../src/shared/model.js';
import { Conversation } from '../conversation/Conversation.js';
import { AgentRoutesContext, routesDistantes } from '../conversation/routes.js';
import {
  derniereDiscussion,
  ETAT_AGENT,
  type ServerAgentView,
  type ServerDiscussionView,
} from '../data/discussionsServeur.js';
import { AidApiError } from '../data/api.js';
import { ecrirePanneau, lirePanneau, type PanneauPref } from '../data/panneauServeur.js';
import { suivreOutils, type SuiviOutils } from '../data/panneauServeur.js';
import { statutInconnu, useServeurs } from '../data/serveurs.js';
import { useAidClient } from '../data/useAidState.js';
import { Layout } from '../ui/Layout.js';
import { ETAT_SERVEUR } from '../ui/Serveur.js';
import { PanneauServeur } from './PanneauServeur.js';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Relecture de l'agent hors événement du fil (statut après une relance, demande close par le daemon). */
const AGENT_RELECTURE_MS = 5_000;

/**
 * `Conversation` attend un agent de sujet : un agent distant en a la forme d'un agent `stream` libre, sans run ni
 * process local. Seuls l'id, le type, le statut, la demande en cours et les réglages y sont lus.
 */
const commeAgent = (a: ServerAgentView, cwd: string): Agent => ({
  id: a.id,
  runId: '',
  kind: a.kind,
  role: 'free',
  transport: 'stream',
  status: a.status,
  cwd,
  command: [],
  pid: null,
  sessionId: a.sessionId,
  exitCode: null,
  issue: null,
  statusReason: null,
  statusMessage: null,
  statusSource: null,
  statusAt: null,
  statusDetail: null,
  lastTool: null,
  pending: a.pending,
  pausedAt: null,
  permissionMode: a.permissionMode,
  model: a.model,
  effort: a.effort,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
});

/** Une relecture à la fois ; une demande arrivée pendant qu'elle court en relance une, une seule, à sa fin. */
function relecteur(lire: () => Promise<void>): () => void {
  let enVol = false;
  let encore = false;
  const tour = (): Promise<void> =>
    lire()
      .catch(() => {
        // relecture au mieux : la suivante corrigera
      })
      .then(() => {
        if (!encore) return;
        encore = false;
        return tour();
      });
  return () => {
    if (enVol) {
      encore = true;
      return;
    }
    enVol = true;
    void tour().finally(() => (enVol = false));
  };
}

const etatTexte = (s: ServerStatus) =>
  s.state === 'connected' && s.latencyMs !== null
    ? `${ETAT_SERVEUR[s.state]} · ${s.latencyMs} ms`
    : ETAT_SERVEUR[s.state];

function Contenu() {
  const { id = '', discussionId = '' } = useParams();
  const client = useAidClient();
  const navigate = useNavigate();
  const { servers, statuses, store } = useServeurs();
  const server = servers?.find((s) => s.id === id) ?? null;
  const status = statuses[id] ?? statutInconnu(id);
  const [discussion, setDiscussion] = useState<ServerDiscussionView | null>(null);
  const [agentVue, setAgentVue] = useState<ServerAgentView | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [introuvable, setIntrouvable] = useState(false);
  const [actionsHost, setActionsHost] = useState<HTMLDivElement | null>(null);
  const agentId = discussion?.agents[0]?.id ?? null;
  // F.3 : panneau Fichiers / Git, ouvert ou fermé et onglet mémorisés par serveur (§11.3.1)
  const [panneau, setPanneau] = useState<PanneauPref | null>(null);
  const basculeRef = useRef<HTMLButtonElement>(null);
  // F.4 : chaque fin de groupe d'outils relit le panneau ouvert, jamais en continu
  const [outils, setOutils] = useState<SuiviOutils>({ fins: 0, outilTermine: false, seq: -1 });

  useEffect(() => {
    // une autre discussion remonte l'écran (clé de `Contenu`) : rien à remettre à zéro ici
    let actif = true;
    client
      .request<ServerDiscussionView>('GET', `/api/servers/${id}/discussions/${discussionId}`)
      .then((d) => {
        if (!actif) return;
        setDiscussion(d);
        setAgentVue(d.agents[0] ?? null);
      })
      .catch((err: unknown) => {
        if (!actif) return;
        if (err instanceof AidApiError && err.status === 404) setIntrouvable(true);
        else setErreur(message(err));
      });
    return () => {
      actif = false;
    };
  }, [client, id, discussionId]);

  useEffect(() => {
    let actif = true;
    lirePanneau(client, id).then(
      (p) => actif && setPanneau(p),
      () => actif && setPanneau({ open: false, tab: 'files' }),
    );
    return () => {
      actif = false;
    };
  }, [client, id]);

  const changerPanneau = useCallback(
    (p: PanneauPref, avant: PanneauPref) => {
      setPanneau(p);
      ecrirePanneau(client, id, p).catch((err: unknown) => {
        setPanneau((courant) => (courant === p ? avant : courant));
        setErreur(message(err));
      });
    },
    [client, id],
  );

  const relireAgent = useMemo(
    () =>
      agentId
        ? relecteur(() =>
            client
              .request<ServerAgentView>('GET', `/api/server-agents/${agentId}`)
              .then(setAgentVue),
          )
        : () => {},
    [client, agentId],
  );

  useEffect(() => {
    const t = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      relireAgent();
    }, AGENT_RELECTURE_MS);
    return () => clearInterval(t);
  }, [relireAgent]);

  const reconnecter = useCallback(async () => {
    try {
      store.appliquer(await client.request<ServerStatus>('POST', `/api/servers/${id}/ping`));
      setErreur(null);
    } catch (err) {
      setErreur(message(err));
    }
  }, [client, id, store]);

  const serveurNom = server?.name ?? '…';
  const injoignable = status.state === 'unreachable' || status.state === 'error';
  const routes = useMemo(
    () =>
      routesDistantes({
        serveur: serveurNom,
        injoignable,
        raison: status.reason,
        onReconnecter: reconnecter,
        onEvent: relireAgent,
        onItem: (it) => setOutils((s) => suivreOutils(s, it)),
      }),
    [serveurNom, injoignable, status.reason, reconnecter, relireAgent],
  );
  const agent = useMemo(
    () => (agentVue && discussion ? commeAgent(agentVue, discussion.cwd) : null),
    [agentVue, discussion],
  );

  if (introuvable)
    return (
      <main className="page" data-node="discussion">
        <p className="message-erreur" role="alert" data-node="discussion.introuvable">
          Cette discussion n’existe plus sur ce serveur.
        </p>
        <Link to="/serveurs">Retour aux serveurs</Link>
      </main>
    );

  return (
    <main className="discussion" data-node="discussion">
      <div className="discussion-entete" data-node="discussion.entete">
        <div className="discussion-titres">
          <nav className="texte-faible" aria-label="Fil d’Ariane">
            <Link to="/serveurs">Serveurs</Link> /{' '}
            <span data-node="discussion.serveur">{serveurNom}</span>
          </nav>
          <h1 className="titre-ecran" data-node="discussion.titre">
            {discussion?.name ?? '…'}
          </h1>
        </div>
        <button
          ref={basculeRef}
          className={`bouton${panneau?.open ? ' est-actif' : ''}`}
          data-node="discussion.panneau.bascule"
          type="button"
          aria-pressed={panneau?.open ?? false}
          disabled={!panneau}
          onClick={() => panneau && changerPanneau({ ...panneau, open: !panneau.open }, panneau)}
        >
          Panneau
        </button>
        <button
          className="bouton"
          data-node="discussion.configurer"
          type="button"
          onClick={() => navigate(`/serveurs/${id}/configuration`)}
        >
          Configurer
        </button>
      </div>
      <div className="discussion-puces" data-node="discussion.puces">
        <span
          className={`discussion-puce discussion-puce--${status.state}`}
          data-node="discussion.etat"
          title={status.reason ?? undefined}
        >
          <span className="discussion-puce-point" aria-hidden="true" />
          {etatTexte(status)}
        </span>
        <span className="discussion-puce discussion-puce--mono" data-node="discussion.cible">
          {serveurNom}
        </span>
        {discussion && (
          <span
            className="discussion-puce discussion-puce--mono"
            data-node="discussion.repertoire"
            title={discussion.cwd}
          >
            {discussion.cwd}
          </span>
        )}
        {server?.keepSession && (
          <span className="discussion-puce" data-node="discussion.session">
            session persistante
          </span>
        )}
      </div>
      {erreur && (
        <p className="message-erreur" role="alert" data-node="discussion.erreur">
          {erreur}
        </p>
      )}
      {agentVue?.staleConfirm && (
        <p className="texte-discret" role="status" data-node="discussion.confirmation-perimee">
          Confirmation des commandes destructives modifiée sur ce serveur : cet agent garde l’ancien
          réglage jusqu’à sa prochaine relance.
        </p>
      )}
      <div className="discussion-colonne">
        {agent && (
          <div className="discussion-agent" data-node="discussion.agent">
            <span className="discussion-agent-nom" data-node="discussion.agent.nom">
              {agent.kind}
            </span>
            <span className="texte-faible" data-node="discussion.agent.etat">
              {ETAT_AGENT[agent.status]}
            </span>
            <div className="onglets-actions-portail" ref={setActionsHost} />
          </div>
        )}
        {discussion && !agent && (
          <p className="texte-discret" data-node="discussion.sans-agent">
            Aucun agent dans cette discussion.
          </p>
        )}
        {agent && (
          <AgentRoutesContext.Provider value={routes}>
            <Conversation key={agent.id} agent={agent} visible actionsHost={actionsHost} />
          </AgentRoutesContext.Provider>
        )}
      </div>
      {panneau?.open && discussion && (
        <PanneauServeur
          serverId={id}
          serveur={serveurNom}
          racine={discussion.cwd}
          onglet={panneau.tab}
          actualisation={outils.fins}
          injoignable={injoignable}
          onOnglet={(tab) => changerPanneau({ ...panneau, tab }, panneau)}
          onFermer={() => {
            changerPanneau({ ...panneau, open: false }, panneau);
            basculeRef.current?.focus();
          }}
        />
      )}
    </main>
  );
}

export function Discussion() {
  const { id = '', discussionId = '' } = useParams();
  return (
    <Layout screen="serveurs">
      <Contenu key={`${id}/${discussionId}`} />
    </Layout>
  );
}

/**
 * `/serveurs/:id/discussion` (ligne de serveur de la barre gauche, §5.2) : la discussion la plus récente du serveur,
 * ou l'écran Serveurs avec le dialogue de création ouvert s'il n'en a aucune.
 */
export function OuvrirDiscussion() {
  const { id = '' } = useParams();
  const client = useAidClient();
  const navigate = useNavigate();
  const [erreur, setErreur] = useState<string | null>(null);
  useEffect(() => {
    let actif = true;
    client
      .request<ServerDiscussionView[]>('GET', `/api/servers/${id}/discussions`)
      .then((liste) => {
        if (!actif) return;
        const d = derniereDiscussion(liste);
        if (d) navigate(`/serveurs/${id}/discussions/${d.id}`, { replace: true });
        else navigate('/serveurs', { replace: true, state: { creer: id } });
      })
      .catch((err: unknown) => actif && setErreur(message(err)));
    return () => {
      actif = false;
    };
  }, [client, id, navigate]);
  return (
    <Layout screen="serveurs">
      <main className="page" data-node="discussion.ouverture">
        {erreur ? (
          <p className="message-erreur" role="alert">
            {erreur}
          </p>
        ) : (
          <p className="texte-faible">Ouverture de la discussion…</p>
        )}
      </main>
    </Layout>
  );
}

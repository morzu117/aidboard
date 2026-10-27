import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { Agent, NavState, Topic, UpdateInfo } from '../../../src/shared/model.js';
import { DecisionCard } from '../conversation/DecisionCard.js';
import { AidApiError } from '../data/api.js';
import { useAid } from '../data/useAidState.js';
import { meshTexte } from '../ui/Barre.js';
import { depuis } from '../ui/depuis.js';
import { A_TRAITER, Layout, useLayout } from '../ui/Layout.js';
import { getNavCacheSnapshot } from '../ui/Nav.js';
import { compteVue, topicsForVue, VUES, type VueId } from '../ui/navVues.js';
import { isAlive, mostUrgent, Point, type Tone, topicView } from '../ui/Statut.js';
import { CasErreurWorktree } from './CasErreurWorktree.js';
import { FilActivite } from './FilActivite.js';

function Squelettes() {
  return (
    <div className="grille" data-node="1-1.grille" aria-label="Chargement des sujets">
      {[1, 2, 3, 4, 5, 6].map((n) => (
        <div key={n} className="squelette" data-node={`1-1.grille.squelette-${n}`}>
          <div className="entete-texte" data-node={`1-1.grille.squelette-${n}.entete`}>
            <span className="sq sq--titre" />
            <span className="sq sq--ligne sq--court" />
          </div>
          <span className="sq sq--puce" />
          <div className="entete-texte" data-node={`1-1.grille.squelette-${n}.terminal`}>
            <span className="sq sq--bloc" />
          </div>
          <div className="entete-texte" data-node={`1-1.grille.squelette-${n}.message`}>
            <span className="sq sq--champ" />
          </div>
        </div>
      ))}
    </div>
  );
}

// Pont de redémarrage de l'app native AID (app/src-tauri/src/daemon_bridge.rs) : port fixe,
// documenté des deux côtés. Absent si la page est ouverte dans un navigateur ordinaire plutôt
// que dans l'app — dans ce cas, rien ne peut démarrer le daemon depuis la page.
const PONT_REDEMARRAGE_URL = 'http://127.0.0.1:4871/restart';

function BandeauDaemon() {
  const { daemon, retry } = useAid();
  const expired = daemon === 'session-expiree';
  const [appIndisponible, setAppIndisponible] = useState(false);

  const demarrer = () => {
    // Le cookie de session survit déjà au redémarrage du daemon — cet onglet/cette fenêtre se
    // reconnecte tout seul une fois le daemon relancé (AidClient.retry), sans action
    // supplémentaire ici que déclencher le redémarrage.
    void fetch(PONT_REDEMARRAGE_URL, { method: 'POST', signal: AbortSignal.timeout(1500) }).catch(
      () => setAppIndisponible(true),
    );
  };

  return (
    <div className="bandeau-erreur" data-node="1-1.erreur.bandeau" role="alert">
      <div className="bandeau-texte">
        <p className="bandeau-titre" data-node="1-1.erreur.bandeau.titre">
          Impossible de lire l’état des sujets
        </p>
        <p className="texte-discret" data-node="1-1.erreur.bandeau.cause" data-bind="erreur.cause">
          {expired
            ? 'Cause : la session a expiré (le daemon a redémarré).'
            : `Cause : le daemon est injoignable sur ${window.location.host} (connexion refusée).`}
        </p>
        <p className="texte-faible" data-node="1-1.erreur.bandeau.aide">
          {expired
            ? 'Relance aid open pour obtenir un nouveau lien.'
            : 'Relance-le avec aid dans un terminal, puis réessaie.'}
        </p>
      </div>
      {!expired && (
        <>
          {appIndisponible ? (
            <p className="texte-faible" data-node="1-1.erreur.bandeau.demarrer-indisponible">
              Relance l’app AID pour redémarrer le daemon.
            </p>
          ) : (
            <button
              className="bouton bouton--contour"
              data-node="1-1.erreur.bandeau.demarrer"
              data-action="daemon.demarrer"
              type="button"
              onClick={demarrer}
            >
              Démarrer le daemon
            </button>
          )}
          <button
            className="bouton bouton--contour"
            data-node="1-1.erreur.bandeau.reessayer"
            data-action="daemon.reconnecter"
            type="button"
            onClick={retry}
          >
            Réessayer
          </button>
        </>
      )}
    </div>
  );
}

const MAJ_CHECK_MS = 30 * 60_000;
const MAJ_POLL_MS = 3_000;
const MAJ_TIMEOUT_MS = 5 * 60_000;

type EtatMaj = 'idle' | 'en-cours' | 'confirmer' | 'erreur';

/**
 * Ce que le daemon sait d'une mise à jour (13.2, DR5) : en mode repo, origin/main a avancé ;
 * en mode release, une version plus récente est publiée. Le bouton est le même, l'effet dépend du mode.
 */
function BandeauMaj() {
  const { call, daemon } = useAid();
  const [maj, setMaj] = useState<UpdateInfo | null>(null);
  const [etat, setEtat] = useState<EtatMaj>('idle');
  const [agentsVivants, setAgentsVivants] = useState(0);
  const [erreur, setErreur] = useState<string | null>(null);
  const dejaDeconnecte = useRef(false);
  useEffect(() => {
    let off = false;
    const load = () =>
      call<UpdateInfo>('GET', '/api/daemon/update').then(
        (r) => !off && setMaj(r.available ? r : null),
        () => {},
      );
    load();
    const timer = setInterval(load, MAJ_CHECK_MS);
    return () => {
      off = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Le pull+build tourne sur ce daemon pendant qu'il sert encore ; il ne sort (et ne relance) que
  // s'ils réussissent — un échec le laisse tourner. Le succès se voit donc à la connexion qui
  // tombe puis revient (session cookie survivant au redémarrage) : on recharge la page pour
  // prendre le nouveau build. Sans ce guet, le bouton restait bloqué sur « Mise à jour… » même
  // une fois le nouveau daemon prêt.
  useEffect(() => {
    if (etat !== 'en-cours') {
      dejaDeconnecte.current = false;
      return;
    }
    if (daemon !== 'connecte') {
      dejaDeconnecte.current = true;
      return;
    }
    if (dejaDeconnecte.current) window.location.reload();
  }, [etat, daemon]);
  // Un échec (pull refusé, build qui plante) ne fait pas sortir le daemon : on ne l'apprend qu'en
  // republiant l'état, qui porte `lastError` depuis la tentative en cours. Le garde-fou de temps
  // couvre le cas où ni l'erreur ni la reconnexion n'arrivent (constaté une fois : 10 min bloqué
  // sur un historique local divergent, invisible ailleurs que dans daemon.log).
  useEffect(() => {
    if (etat !== 'en-cours') return;
    let off = false;
    const deadline = Date.now() + MAJ_TIMEOUT_MS;
    const poll = () =>
      call<{ lastError?: string | null }>('GET', '/api/daemon/update').then(
        (r) => {
          if (off) return;
          if (r.lastError) {
            setEtat('erreur');
            setErreur(r.lastError);
          } else if (Date.now() > deadline) {
            setEtat('erreur');
            setErreur('la mise à jour prend trop de temps — vérifie le daemon directement.');
          }
        },
        () => {},
      );
    const timer = setInterval(poll, MAJ_POLL_MS);
    return () => {
      off = true;
      clearInterval(timer);
    };
  }, [etat, call]);
  if (maj === null) return null;

  const lancer = (force: boolean) => {
    setErreur(null);
    setEtat('en-cours');
    call<{ updating: boolean; agents: number }>(
      'POST',
      '/api/daemon/update',
      force ? { force: true } : {},
    ).catch((err: unknown) => {
      if (err instanceof AidApiError && err.status === 409) {
        setAgentsVivants((err.body.agents as unknown[] | undefined)?.length ?? 0);
        setEtat('confirmer');
        return;
      }
      setEtat('erreur');
      setErreur(err instanceof Error ? err.message : String(err));
    });
  };

  return (
    <div className="bandeau-maj" data-node="1-1.maj" role="status">
      <div className="bandeau-texte">
        <p className="bandeau-titre" data-node="1-1.maj.titre">
          {maj.mode === 'release'
            ? `AID Server ${maj.latest ?? ''} disponible`
            : 'Nouvelle version d’aidboard disponible'}
        </p>
        <p className="texte-discret" data-node="1-1.maj.aide">
          {maj.mode === 'release'
            ? `Version installée : ${maj.version}.`
            : `origin/main a avancé${maj.latest ? ` (${maj.latest.slice(0, 7)})` : ''}.`}
        </p>
        {etat === 'erreur' && erreur && (
          <p className="texte-discret" data-node="1-1.maj.erreur" role="alert">
            Mise à jour échouée : {erreur}
          </p>
        )}
      </div>
      {etat === 'confirmer' ? (
        <button
          className="bouton bouton--contour"
          data-node="1-1.maj.confirmer"
          data-action="daemon.maj.forcer"
          type="button"
          onClick={() => lancer(true)}
        >
          {agentsVivants} agent{agentsVivants > 1 ? 's' : ''} tourn
          {agentsVivants > 1 ? 'ent' : 'e'} — forcer et mettre à jour
        </button>
      ) : (
        <button
          className="bouton bouton--contour"
          data-node="1-1.maj.lancer"
          data-action="daemon.maj"
          type="button"
          disabled={etat === 'en-cours'}
          onClick={() => lancer(false)}
        >
          {etat === 'en-cours' ? 'Mise à jour…' : 'Mettre à jour'}
        </button>
      )}
    </div>
  );
}

const STATUTS: { tone: Exclude<Tone, 'inactif'>; label: string }[] = [
  { tone: 'attente', label: 'Attend une réponse' },
  { tone: 'erreur', label: 'Erreur' },
  { tone: 'relire', label: 'À relire' },
  { tone: 'cours', label: 'En cours' },
  { tone: 'pause', label: 'En pause' },
];

// E6 : seulement aux claude et codex vivants qui ont fini leur tour ; jamais à un shell, qui exécuterait le texte.
const recoitConsigne = (a: Agent) =>
  (a.kind === 'claude' || a.kind === 'codex') && isAlive(a) && !a.pausedAt && a.status === 'idle';

function Consigne({ agents }: { agents: Agent[] }) {
  const { call } = useAid();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [retour, setRetour] = useState<{ ok: number; erreurs: string[] } | null>(null);
  const cibles = agents.filter(recoitConsigne);
  const envoyer = async () => {
    setBusy(true);
    setRetour(null);
    const results = await Promise.allSettled(
      cibles.map((a) => call('POST', `/api/agents/${a.id}/input`, { text })),
    );
    const erreurs = results.flatMap((r, i) =>
      r.status === 'rejected' ? [`${cibles[i]!.kind} : ${(r.reason as Error).message}`] : [],
    );
    setRetour({ ok: results.length - erreurs.length, erreurs });
    if (erreurs.length === 0) setText('');
    setBusy(false);
  };
  return (
    <section className="consigne" data-node="1-1.consigne" aria-label="Consigne à tous les agents">
      <div className="consigne-entete">
        <h2 className="titre-zone" data-node="1-1.consigne.titre">
          Consigne à tous les agents
        </h2>
        <p className="texte-faible" data-node="1-1.consigne.aide">
          Envoyée maintenant aux agents inactifs.
        </p>
      </div>
      <div className="consigne-ligne">
        <input
          className="champ"
          data-node="1-1.consigne.champ"
          data-action="consigne.saisir"
          type="text"
          placeholder="Ex. : messages de commit en français, format Conventional Commits"
          aria-label="Consigne"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          className="bouton bouton--contour"
          data-node="1-1.consigne.envoyer"
          data-action="consigne.envoyer"
          type="button"
          disabled={busy || cibles.length === 0 || !text.trim()}
          onClick={() => void envoyer()}
        >
          <span>
            Envoyer aux agents inactifs (
            <span data-node="1-1.consigne.envoyer.nombre" data-bind="resume.agents_inactifs">
              {cibles.length}
            </span>
            )
          </span>
        </button>
      </div>
      {retour && retour.erreurs.length === 0 && (
        <p className="message-info" role="status" data-node="1-1.consigne.retour">
          Envoyée à {retour.ok} agent{retour.ok > 1 ? 's' : ''}.
        </p>
      )}
      {retour && retour.erreurs.length > 0 && (
        <p className="message-erreur" role="alert" data-node="1-1.consigne.erreur">
          {retour.erreurs.join(' · ')}
        </p>
      )}
    </section>
  );
}

function Legende() {
  return (
    <section className="legende" data-node="1-1.legende" aria-label="Légende">
      {STATUTS.map((s) => (
        <span key={s.tone} className="legende-element" data-node={`1-1.legende.statut-${s.tone}`}>
          <Point tone={s.tone} />
          {s.label}
        </span>
      ))}
      <span className="legende-element" data-node="1-1.legende.estime">
        <span className="badge badge--relire badge--estime">estimé</span>statut déduit du terminal,
        sans signal sûr
      </span>
    </section>
  );
}

type Tri = 'activite' | 'nom' | 'projet';

// DS7 côté board : le même champ relu en direct, jamais la lifecycle `indexState` du sujet.
function indexPastille(topic: Topic): string {
  const idx = topic.index;
  if (!idx) return 'index indisponible';
  if (idx.stale)
    return `${idx.engine} · ${idx.pending} fichier${idx.pending > 1 ? 's' : ''} en retard`;
  return `${idx.engine} · à jour`;
}

function activite(agent: Agent | undefined, topic: Topic): string {
  if (agent?.pausedAt && isAlive(agent)) {
    const d = depuis(agent.pausedAt);
    return d.startsWith('il y a ') ? `en pause depuis ${d.slice(7)}` : 'en pause à l’instant';
  }
  return depuis(agent?.statusAt ?? topic.updatedAt);
}

// Brief §6.2 : vocabulaire texte (« libre »/« au travail »/« arrêté »/« aucun agent »), distinct
// des tons plus fins de `agentView` — jamais codé uniquement par une couleur.
function etatAgent(agents: Agent[]): string {
  const a = mostUrgent(agents);
  if (!a) return 'aucun agent';
  if (!isAlive(a) || a.pausedAt) return 'arrêté';
  return a.status === 'idle' ? 'libre' : 'au travail';
}

const accentInsensible = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// « Trancher » (décision en attente) / « Reprendre » (agent existant) / « Lancer » (aucun agent) — brief §5.4.
function ActionLigne({
  topic,
  agents,
  dataNode,
  archive,
  onDesarchive,
}: {
  topic: Topic;
  agents: Agent[];
  dataNode: string;
  archive?: boolean;
  onDesarchive?: () => void;
}) {
  const { call } = useAid();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  // Même agent que la colonne Agent (mostUrgent) quand il est en attente, sinon on garde le find.
  const urgent = mostUrgent(agents);
  const decideur =
    urgent?.pending && urgent.status === 'needs_input'
      ? urgent
      : agents.find((a) => a.pending && a.status === 'needs_input');
  const neRemonte = (e: { stopPropagation: () => void }) => e.stopPropagation();

  if (archive) {
    const desarchiver = async () => {
      setBusy(true);
      setErreur(null);
      try {
        await call('PATCH', `/api/nav/placements/${topic.id}`, { archived: false });
        onDesarchive?.();
      } catch (err) {
        setErreur(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
    };
    return (
      <>
        <button
          className="bouton"
          data-node={dataNode}
          data-action="sujet.desarchiver"
          type="button"
          disabled={busy}
          onClick={(e) => {
            neRemonte(e);
            void desarchiver();
          }}
        >
          {busy ? 'Désarchivage…' : 'Désarchiver'}
        </button>
        {erreur && (
          <span className="texte-faible" role="alert" data-node={`${dataNode}.erreur`}>
            {erreur}
          </span>
        )}
      </>
    );
  }

  if (decideur) {
    return (
      <Link
        className="bouton bouton--primaire"
        data-node={dataNode}
        data-action="sujet.trancher"
        to={`/sujets/${topic.id}?agent=${decideur.id}`}
        onClick={neRemonte}
      >
        Trancher
      </Link>
    );
  }
  if (agents.length > 0) {
    return (
      <Link
        className="bouton"
        data-node={dataNode}
        data-action="sujet.reprendre"
        to={`/sujets/${topic.id}`}
        onClick={neRemonte}
      >
        Reprendre
      </Link>
    );
  }
  const lancer = async () => {
    setBusy(true);
    setErreur(null);
    try {
      const a = await call<Agent>('POST', '/api/agents', { topicId: topic.id, kind: 'claude' });
      navigate(`/sujets/${topic.id}?agent=${a.id}`);
    } catch (err) {
      setErreur(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <>
      <button
        className="bouton"
        data-node={dataNode}
        data-action="sujet.lancer"
        type="button"
        disabled={busy}
        onClick={(e) => {
          neRemonte(e);
          void lancer();
        }}
      >
        {busy ? 'Lancement…' : 'Lancer'}
      </button>
      {erreur && (
        <span className="texte-faible" role="alert" data-node={`${dataNode}.erreur`}>
          {erreur}
        </span>
      )}
    </>
  );
}

function Contenu() {
  const { state, daemon, call } = useAid();
  const { openNewTopic } = useLayout();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const vueParam = params.get('vue');
  const vue: VueId = VUES.some((v) => v.id === vueParam) ? (vueParam as VueId) : 'tous';
  const [filtreTexte, setFiltreTexte] = useState('');
  const [tri, setTri] = useState<Tri>('activite');
  const down = daemon === 'injoignable' || daemon === 'session-expiree';

  // Mêmes placements que Nav (D56, point 5) : lus depuis son cache de module au premier rendu
  // (évite un flash « aucun sujet » si Nav les a déjà chargés), puis rafraîchis indépendamment.
  const [nav, setNav] = useState<Partial<NavState>>(() => getNavCacheSnapshot() ?? {});
  const idsKey = useMemo(() => {
    const topicIds = (state?.topics ?? []).map((t) => t.id).sort();
    const workspaceIds = (state?.workspaces ?? []).map((w) => w.id).sort();
    return [...topicIds, ...workspaceIds].join(',');
  }, [state?.topics, state?.workspaces]);
  useEffect(() => {
    let annule = false;
    call<NavState>('GET', '/api/nav').then(
      (r) => !annule && setNav(r),
      () => {},
    );
    return () => {
      annule = true;
    };
    // `call` change d'identité à chaque rendu (useAid le reconstruit) : le suivre redéclencherait
    // la lecture à l'infini.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  if (!state) {
    return (
      <main className="page">
        <div className="entete" data-node="1-1.entete">
          <div className="entete-texte">
            <h1 className="titre-ecran" data-node="1-1.entete.titre">
              {down ? 'État indisponible' : 'Accueil'}
            </h1>
            {down ? (
              <p className="resume">État indisponible</p>
            ) : (
              <span className="sq sq--ligne sq--moyen" />
            )}
          </div>
        </div>
        {down ? (
          <section className="zone-erreur" data-node="1-1.erreur">
            <BandeauDaemon />
          </section>
        ) : (
          <Squelettes />
        )}
      </main>
    );
  }

  const wsOf = (id: string) => state.workspaces.find((w) => w.id === id);
  const agentsOf = (topicId: string) => {
    const runIds = state.runs.filter((r) => r.topicId === topicId).map((r) => r.id);
    return state.agents.filter((a) => runIds.includes(a.runId));
  };
  const topicOf = (a: Agent) => {
    const run = state.runs.find((r) => r.id === a.runId);
    return run ? state.topics.find((t) => t.id === run.topicId) : undefined;
  };
  const placementByTopic = new Map((nav.placements ?? []).map((p) => [p.topicId, p]));
  // Même « nom affiché » que la barre gauche (D55) : la branche, sauf renommage explicite du placement.
  const nomAffiche = (t: Topic) => placementByTopic.get(t.id)?.displayName ?? t.branch;

  const enAttente = compteVue('a-decider', state.topics, placementByTopic, agentsOf, state.agents);
  const titre =
    enAttente > 0
      ? `${enAttente} chose${enAttente > 1 ? 's' : ''} attend${enAttente > 1 ? 'ent' : ''} ta réponse`
      : 'Rien n’attend ta réponse';
  const date = new Date().toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  const decisions = state.agents.filter((a) => a.pending && a.status === 'needs_input');
  const decisionsVisibles = decisions.slice(0, 3);
  const decisionsRestantes = decisions.length - decisionsVisibles.length;

  // Un worktree manquant est une erreur à régler, pas un sujet à trier par vue (D56) : il sort
  // de la table et de son décompte, et s'affiche toujours dans sa propre section plus bas.
  const topicsSains = state.topics.filter((t) => !t.worktreeMissing);
  const casses = state.topics.filter((t) => t.worktreeMissing);
  const vueTopics = topicsForVue(vue, topicsSains, placementByTopic, agentsOf);
  const filtreNorm = accentInsensible(filtreTexte.trim());
  const visibles = vueTopics.filter((t) => {
    if (!filtreNorm) return true;
    const ws = wsOf(t.workspaceId);
    return accentInsensible(`${nomAffiche(t)} ${ws?.name ?? ''} ${t.phase ?? ''}`).includes(
      filtreNorm,
    );
  });
  const aDecider = (t: Topic) => agentsOf(t.id).some((a) => a.status === 'needs_input');
  const activiteAt = (t: Topic) => {
    const a = mostUrgent(agentsOf(t.id));
    return Date.parse(a?.statusAt ?? t.updatedAt);
  };
  const tries = [...visibles].sort((a, b) => {
    const da = aDecider(a);
    const db = aDecider(b);
    if (da !== db) return da ? -1 : 1;
    if (tri === 'nom') return nomAffiche(a).localeCompare(nomAffiche(b), 'fr');
    if (tri === 'projet')
      return (wsOf(a.workspaceId)?.name ?? '').localeCompare(wsOf(b.workspaceId)?.name ?? '', 'fr');
    return activiteAt(b) - activiteAt(a);
  });
  const sains = tries;

  const vueActuelle = VUES.find((v) => v.id === vue);
  const compteTable = compteVue(vue, topicsSains, placementByTopic, agentsOf, state.agents);
  const titreTable = vue === 'tous' ? 'Tous les sujets' : (vueActuelle?.label ?? 'Sujets');
  const mesh = state.mesh;

  return (
    <main className="page">
      <div className="entete" data-node="1-1.entete">
        <div className="entete-texte">
          <p className="texte-faible" data-node="1-1.entete.date">
            {date}
          </p>
          <h1 className="titre-ecran" data-node="1-1.entete.titre">
            {titre}
          </h1>
        </div>
      </div>
      {down && (
        <section className="zone-erreur" data-node="1-1.erreur">
          <BandeauDaemon />
        </section>
      )}
      {!down && <BandeauMaj />}
      {decisionsVisibles.length > 0 && (
        <section className="liste" aria-label="Décisions en attente" data-node="1-1.decisions">
          <h2 className="titre-zone" data-node="1-1.decisions.titre">
            Décisions en attente
          </h2>
          {decisionsVisibles.map((a, i) => {
            const topic = topicOf(a);
            if (!topic || !a.pending) return null;
            const ws = wsOf(topic.workspaceId);
            const id = `1-1.decisions.decision-${i + 1}`;
            return (
              <div key={a.id} className="groupe" data-node={id}>
                <p className="texte-faible" data-node={`${id}.contexte`}>
                  {ws?.name ?? '?'} · {topic.branch} · {depuis(topic.updatedAt)}
                </p>
                <DecisionCard
                  agentId={a.id}
                  request={a.pending}
                  resolved={false}
                  dataNode={`${id}.carte`}
                />
                <Link
                  className="lien"
                  data-node={`${id}.ouvrir`}
                  data-action="sujet.ouvrir"
                  to={`/sujets/${topic.id}`}
                >
                  Ouvrir le sujet →
                </Link>
              </div>
            );
          })}
          {decisionsRestantes > 0 && (
            <Link className="lien" data-node="1-1.decisions.autres" to="/boite">
              voir les {decisionsRestantes} autres →
            </Link>
          )}
        </section>
      )}
      <div className="accueil-disposition" data-node="1-1.disposition">
        <section className="accueil-table" aria-label="Tous les sujets" data-node="1-1.table">
          <div className="entete">
            <div className="entete-texte">
              <h2 className="titre-zone" data-node="1-1.table.titre">
                {titreTable} · {compteTable}
              </h2>
            </div>
            <div className="filtres" data-node="1-1.table.filtres">
              <input
                className="champ"
                data-node="1-1.table.filtre"
                data-action="filtre.texte"
                type="text"
                placeholder="Filtrer les sujets…"
                aria-label="Filtrer les sujets"
                value={filtreTexte}
                onChange={(e) => setFiltreTexte(e.target.value)}
              />
              <label className="texte-faible" htmlFor="accueil-tri">
                Tri
              </label>
              <select
                id="accueil-tri"
                className="selecteur"
                data-node="1-1.table.tri"
                data-action="tri.choisir"
                value={tri}
                onChange={(e) => setTri(e.target.value as Tri)}
              >
                <option value="activite">Activité récente</option>
                <option value="nom">Nom</option>
                <option value="projet">Projet</option>
              </select>
            </div>
          </div>
          {state.topics.length === 0 ? (
            <section className="vide" data-node="1-1.vide">
              <p className="vide-message" data-node="1-1.vide.message">
                {state.workspaces.length > 0
                  ? 'Aucun sujet ouvert : un projet peut attendre, crée un sujet quand tu en as un.'
                  : 'Aucun projet : ajoutes-en un, puis crée un sujet pour démarrer.'}
              </p>
              <div className="vide-actions">
                <button
                  className="bouton bouton--primaire"
                  data-node="1-1.vide.creer"
                  data-action="sujet.creer"
                  type="button"
                  onClick={() => openNewTopic()}
                >
                  Nouveau sujet
                </button>
              </div>
            </section>
          ) : sains.length === 0 ? (
            <p className="texte-discret" data-node="1-1.table.aucun">
              Aucun sujet ne correspond.
            </p>
          ) : (
            <table className="table-sujets" data-node="1-1.table.lignes">
              <thead>
                <tr>
                  <th scope="col" data-node="1-1.table.entete.sujet">
                    Sujet
                  </th>
                  <th scope="col" data-node="1-1.table.entete.projet">
                    Projet
                  </th>
                  <th scope="col" data-node="1-1.table.entete.agent">
                    Agent
                  </th>
                  <th
                    scope="col"
                    className="colonne-activite"
                    data-node="1-1.table.entete.activite"
                  >
                    Activité
                  </th>
                  <th scope="col" data-node="1-1.table.entete.action">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {sains.map((t, i) => {
                  const agents = agentsOf(t.id);
                  const view = topicView(agents);
                  const urgent = mostUrgent(agents);
                  const rowId = `1-1.table.ligne-${i + 1}`;
                  return (
                    <tr
                      key={t.id}
                      className="ligne-sujet"
                      data-node={rowId}
                      onClick={(e) => {
                        if ((e.target as Element).closest('a,button')) return;
                        navigate(`/sujets/${t.id}`);
                      }}
                    >
                      <td data-node={`${rowId}.sujet`}>
                        <Link
                          className="ligne-sujet-lien"
                          data-action="sujet.ouvrir"
                          to={`/sujets/${t.id}`}
                        >
                          <Point
                            tone={view.tone}
                            label={view.label}
                            estimated={view.estimated}
                            dataNode={`${rowId}.statut`}
                          />
                          <span data-node={`${rowId}.nom`} data-bind="sujet.nom_affiche">
                            {nomAffiche(t)}
                          </span>
                          {t.phase && <span className="md-code-ligne">{t.phase}</span>}
                        </Link>
                        <span className="texte-faible" data-node={`${rowId}.index`}>
                          {indexPastille(t)}
                        </span>
                      </td>
                      <td data-node={`${rowId}.projet`} data-bind="workspace.nom">
                        {wsOf(t.workspaceId)?.name ?? '?'}
                      </td>
                      <td data-node={`${rowId}.agent`}>
                        {urgent ? `${urgent.kind} · ${etatAgent(agents)}` : 'Aucun agent'}
                      </td>
                      <td className="colonne-activite" data-node={`${rowId}.activite`}>
                        {activite(urgent, t)}
                      </td>
                      <td data-node={`${rowId}.action`}>
                        <ActionLigne
                          topic={t}
                          agents={agents}
                          dataNode={`${rowId}.action.bouton`}
                          archive={vue === 'archives'}
                          onDesarchive={() =>
                            setNav((cur) => ({
                              ...cur,
                              placements: (cur.placements ?? []).map((p) =>
                                p.topicId === t.id ? { ...p, archived: false } : p,
                              ),
                            }))
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
        <aside className="accueil-aside" data-node="1-1.aside" aria-label="État">
          <FilActivite />
          <div className="panneau" data-node="1-1.aside.etat">
            <div className="panneau-entete">
              <h2 className="titre-zone" data-node="1-1.aside.etat.titre">
                État
              </h2>
            </div>
            <div className="panneau-corps">
              <p className="texte-discret" data-node="1-1.aside.etat.daemon">
                {daemon === 'connecte' ? 'daemon joignable' : 'daemon injoignable'}
              </p>
              {mesh && (
                <p className="texte-discret" data-node="1-1.aside.etat.mesh">
                  {meshTexte({
                    state: mesh.state,
                    aTraiter: mesh.inbox.filter((d) => !d.seenAt && A_TRAITER.has(d.kind)).length,
                    tailscaleManage: mesh.tailscaleManage,
                    enCours: false,
                    onToggle: () => {},
                  })}
                </p>
              )}
            </div>
          </div>
        </aside>
      </div>
      {casses.length > 0 && (
        <section
          className="liste"
          aria-label="Sujets avec worktree manquant"
          data-node="1-1.erreur"
        >
          {casses.map((t, i) => (
            <CasErreurWorktree key={t.id} n={i + 1} topic={t} workspace={wsOf(t.workspaceId)} />
          ))}
        </section>
      )}
      <Consigne agents={state.agents} />
      <Legende />
    </main>
  );
}

export function Accueil() {
  return (
    <Layout screen="1-1">
      <Contenu />
    </Layout>
  );
}

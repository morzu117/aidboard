import type { BoardAid } from '../data/aid-board.js';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { MODES, type PermissionMode } from '../../../src/shared/agentSettings.js';
import type { Agent, AgentsDisponibles, Topic, TopicType } from '../../../src/shared/model.js';
import { slugify } from '../../../src/shared/slug.js';
import { AidApiError } from '../data/api.js';
import { memorySlug } from '../data/memory.js';
import { useAid, useAidClient } from '../data/useAidState.js';
import { Layout, useLayout } from '../ui/Layout.js';
import {
  type AgentCree,
  messagePlan,
  phraseDonnees,
  verifications,
} from '../ui/nouveauSujetVue.js';

// Chantier 28 (D141, D142, D144, D145) : Nouveau sujet devient un écran, `/sujets/nouveau?projet=`. Le projet vit dans l'URL :
// « Ajouter un projet… » y revient avec le projet enregistré, sans état resté d'avant.

const TYPES: TopicType[] = ['feat', 'fix', 'chore', 'spike'];
const AGENTS: AgentCree[] = ['claude', 'codex'];
const GLYPHE = { ok: '✓', info: '!', ko: '✕' } as const;
const message = (err: unknown) => (err instanceof AidApiError ? err.message : String(err));

/** D144 : la lecture « Vérifié à l'instant » du projet choisi ; null tant qu'elle n'est pas revenue. */
function useDisponibles(workspaceId: string | undefined): AgentsDisponibles | null {
  const client = useAidClient();
  const [lu, setLu] = useState<{ pour: string; dispo: AgentsDisponibles } | null>(null);
  useEffect(() => {
    if (!workspaceId) return;
    let actif = true;
    client
      .request<AgentsDisponibles>(
        'GET',
        `/api/agents/disponibles?workspaceId=${encodeURIComponent(workspaceId)}`,
      )
      .then((dispo) => {
        if (actif && Array.isArray(dispo.agents)) setLu({ pour: workspaceId, dispo });
      })
      .catch(() => undefined);
    return () => {
      actif = false;
    };
  }, [client, workspaceId]);
  return lu && lu.pour === workspaceId ? lu.dispo : null;
}

/** D145 : où en est la création ; `worktree` attend que le sujet passe `active`, puis lance l'agent. */
type Phase =
  | { etape: 'saisie' }
  | { etape: 'creation' }
  | { etape: 'worktree'; topicId: string; actionId: string };

function Contenu() {
  const { state, call } = useAid();
  const { addWorkspaceThenTopic } = useLayout();
  const navigation = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const workspaces = state?.workspaces ?? [];
  // sans projet dans l'URL, le dernier enregistré : on vient en général de l'ajouter
  const latest = [...workspaces].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  const workspace = workspaces.find((w) => w.id === params.get('projet')) ?? latest;
  const [origine] = useState(() => {
    const valeur = location.state as { carte?: unknown; titre?: unknown } | null;
    return typeof valeur?.carte === 'number' &&
      Number.isSafeInteger(valeur.carte) &&
      valeur.carte > 0
      ? {
          carte: valeur.carte,
          titre: typeof valeur.titre === 'string' ? valeur.titre.slice(0, 200) : '',
        }
      : null;
  });
  const destination = (location.state as { destination?: { page: string; state?: unknown } } | null)
    ?.destination;
  const navigate = (page: string | number, options?: { replace?: boolean; state?: unknown }) => {
    if (
      origine &&
      typeof page === 'string' &&
      page.startsWith('/sujets/') &&
      page !== '/sujets/nouveau'
    ) {
      navigation('/sujets/nouveau', {
        replace: true,
        state: { ...origine, destination: { page, state: options?.state } },
      });
    } else if (typeof page === 'number') navigation(page);
    else navigation(page, options);
  };
  const [title, setTitle] = useState(origine?.titre ?? '');
  const [type, setType] = useState<TopicType>('feat');
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ etape: 'saisie' });
  const client = useAidClient();
  const dispo = useDisponibles(workspace?.id);
  // D144 : sans choix, le premier agent trouvé ; claude tant que la lecture n'est pas revenue
  const [choix, setChoix] = useState<AgentCree | 'aucun' | null>(null);
  const defaut = dispo
    ? (AGENTS.find((k) => dispo.agents.find((a) => a.kind === k)?.trouve) ?? 'aucun')
    : 'claude';
  const agent = choix ?? defaut;
  const disponible = agent === 'aucun' ? undefined : dispo?.agents.find((a) => a.kind === agent);
  const [model, setModel] = useState<string | null>(null);
  const [mode, setMode] = useState<PermissionMode>('default');
  const n = (rest: string) => `nouveau-sujet.${rest}`;

  const slug = useMemo(() => {
    try {
      return slugify(title);
    } catch {
      return null;
    }
  }, [title]);

  // D141 : Annuler revient d'où l'on vient ; arrivé directement sur l'URL, à l'accueil
  const annuler = () => (location.key !== 'default' ? navigate(-1) : navigate('/'));

  const choisirAgent = (k: AgentCree | 'aucun') => {
    setChoix(k);
    setModel(null);
    setMode('default');
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!workspace) return;
    setError(null);
    setPhase({ etape: 'creation' });
    try {
      // D15 : le sujet existe en draft dès cette requête ; l'écran Sujet suit topic.create
      const r = await call<{ topicId: string; actionId: string }>('POST', '/api/topics', {
        workspaceId: workspace.id,
        title: title.trim(),
        type,
      });
      if (agent === 'aucun') navigate(`/sujets/${r.topicId}`, { replace: true });
      else setPhase({ etape: 'worktree', topicId: r.topicId, actionId: r.actionId });
    } catch (err) {
      setError(message(err));
      setPhase({ etape: 'saisie' });
    }
  }

  // D145 : le worktree prêt (sujet `active`), l'agent part et reçoit la demande de plan. Un échec de
  // topic.create mène au sujet, qui le montre déjà ; un agent qui ne part pas, au sujet avec l'erreur.
  const lance = useRef(false);
  const topicAttendu =
    phase.etape === 'worktree' ? state?.topics.find((t) => t.id === phase.topicId) : undefined;
  const runAttendu =
    phase.etape === 'worktree' ? state?.actions.find((a) => a.id === phase.actionId) : undefined;
  const pret = topicAttendu?.state === 'active';
  const echoue =
    runAttendu !== undefined && runAttendu.state !== 'running' && runAttendu.state !== 'succeeded';

  async function demarrer(topic: Topic, kind: AgentCree, namespace: string) {
    const sujet = `/sujets/${topic.id}`;
    let a: Agent;
    try {
      a = await client.request<Agent>('POST', '/api/agents', { topicId: topic.id, kind });
    } catch (err) {
      navigate(sujet, { replace: true, state: { erreurAgent: message(err) } });
      return;
    }
    const page = `${sujet}?agent=${a.id}`;
    try {
      const reglages: { mode?: PermissionMode; model?: string } = {};
      if (mode !== 'default') reglages.mode = mode;
      if (model !== null) reglages.model = model;
      if (Object.keys(reglages).length > 0)
        await client.request('PATCH', `/api/agents/${a.id}/settings`, reglages);
      await client.request('POST', `/api/agents/${a.id}/input`, {
        text: messagePlan({ titre: topic.title, page: memorySlug(namespace, 'plan', topic.slug) }),
      });
      navigate(page, { replace: true });
    } catch (err) {
      navigate(page, { replace: true, state: { erreurAgent: message(err) } });
    }
  }

  useEffect(() => {
    if (phase.etape !== 'worktree' || lance.current) return;
    if (echoue) {
      lance.current = true;
      navigation(`/sujets/${phase.topicId}`, { replace: true });
      return;
    }
    if (!pret || !topicAttendu || agent === 'aucun' || !workspace) return;
    lance.current = true;
    void demarrer(topicAttendu, agent, workspace.namespace ?? workspace.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- un seul départ, au passage à `active`
  }, [phase, pret, echoue]);

  const running = phase.etape !== 'saisie';
  const etat =
    phase.etape !== 'worktree' ? null : pret ? 'Lancement de l’agent…' : 'Création du worktree…';
  const verifie = workspace
    ? verifications({
        agent: agent === 'aucun' ? null : agent,
        disponible,
        base: workspace.baseBranch,
        baseEnRetard: dispo?.baseEnRetard ?? null,
      })
    : [];
  const donnees = phraseDonnees(agent === 'aucun' ? null : agent);
  const modeles = disponible?.options.models ?? [];
  if (destination && origine) return <LigneCarte carte={origine.carte} destination={destination} />;
  return (
    <main className="page nouveau-sujet" data-node={n('page')}>
      <div className="entete" data-node={n('entete')}>
        <h1 className="titre-ecran" data-node={n('titre')}>
          Nouveau sujet
        </h1>
      </div>
      <form
        id="nouveau-sujet-formulaire"
        className="nouveau-sujet-colonnes"
        aria-label="Créer un sujet"
        onSubmit={submit}
      >
        <section className="nouveau-sujet-carte" data-node={n('besoin')} aria-label="Le besoin">
          <h2 className="titre-zone" data-node={n('besoin.titre')}>
            1 · Le besoin
          </h2>
          {state && workspaces.length === 0 ? (
            <div className="nouveau-sujet-sans-projet" data-node={n('besoin.sans-projet')}>
              <p className="texte-discret">Aucun projet : un sujet part d’un dépôt enregistré.</p>
              <button
                className="bouton bouton--primaire"
                data-node={n('besoin.ajouter-projet')}
                data-action="workspace.ajouter"
                type="button"
                onClick={() => addWorkspaceThenTopic?.()}
              >
                Ajouter un projet…
              </button>
            </div>
          ) : (
            <>
              <div className="nouveau-sujet-ligne">
                <label className="nouveau-sujet-champ">
                  Projet
                  <select
                    className="selecteur"
                    data-node={n('besoin.projet')}
                    value={workspace?.id ?? ''}
                    onChange={(e) => setParams({ projet: e.target.value }, { replace: true })}
                    disabled={running}
                  >
                    {workspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="nouveau-sujet-champ">
                  Type
                  <select
                    className="selecteur"
                    data-node={n('besoin.type')}
                    value={type}
                    onChange={(e) => setType(e.target.value as TopicType)}
                    disabled={running}
                  >
                    {TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <button
                className="bouton bouton--fantome nouveau-sujet-ajouter"
                data-node={n('besoin.ajouter-projet')}
                data-action="workspace.ajouter"
                type="button"
                onClick={() => addWorkspaceThenTopic?.()}
                disabled={running}
              >
                Ajouter un projet…
              </button>
              <label className="nouveau-sujet-champ">
                Titre
                <input
                  className="champ"
                  data-node={n('besoin.titre-sujet')}
                  value={title}
                  placeholder="Ce que tu veux explorer"
                  onChange={(e) => setTitle(e.target.value)}
                  disabled={running}
                  autoFocus
                />
              </label>
              <p className="nouveau-sujet-git">
                <span data-node={n('besoin.branche')} data-bind="apercu.branche">
                  Branche : <code>{slug ? `${type}/${slug}` : `${type}/(titre à saisir)`}</code>
                </span>
                {workspace && (
                  <span data-node={n('besoin.base')} data-bind="projet.base">
                    Base : <code>{workspace.baseBranch}</code>
                  </span>
                )}
              </p>
              <div className="nouveau-sujet-local" data-node={n('besoin.local')}>
                <span className="nouveau-sujet-local-badge">○ local</span>
                <p>
                  Ce sujet reste sur cette machine. Aucune autre machine ne le retrouvera tant que
                  tu ne l’auras pas publié.
                </p>
              </div>
            </>
          )}
        </section>
        <section
          className="nouveau-sujet-carte"
          data-node={n('travail')}
          aria-label="La façon de travailler"
        >
          <h2 className="titre-zone" data-node={n('travail.titre')}>
            2 · La façon de travailler
          </h2>
          <label className="nouveau-sujet-champ">
            Agent
            <select
              className="selecteur"
              data-node={n('travail.agent')}
              value={agent}
              onChange={(e) => choisirAgent(e.target.value as AgentCree | 'aucun')}
              disabled={running}
            >
              {AGENTS.map((k) => {
                const introuvable = dispo?.agents.find((a) => a.kind === k)?.trouve === false;
                return (
                  <option key={k} value={k} disabled={introuvable}>
                    {introuvable ? `${k} (introuvable)` : k}
                  </option>
                );
              })}
              <option value="aucun">aucun</option>
            </select>
          </label>
          {agent !== 'aucun' && (
            <div className="nouveau-sujet-ligne">
              <label className="nouveau-sujet-champ">
                Modèle
                <select
                  className="selecteur"
                  data-node={n('travail.modele')}
                  value={model ?? ''}
                  onChange={(e) => setModel(e.target.value || null)}
                  disabled={running}
                >
                  <option value="">Défaut de l’agent</option>
                  {modeles.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="nouveau-sujet-champ">
                Permissions
                <select
                  className="selecteur"
                  data-node={n('travail.permissions')}
                  value={mode}
                  onChange={(e) => setMode(e.target.value as PermissionMode)}
                  disabled={running}
                >
                  {MODES[agent].map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <dl className="nouveau-sujet-faits">
            <div data-node={n('travail.machine')}>
              <dt>Machine</dt>
              <dd>Mac local</dd>
            </div>
            <div data-node={n('travail.acces')}>
              <dt>Accès</dt>
              <dd>Abonnement · aucun repli payant</dd>
            </div>
          </dl>
          {verifie.length > 0 && (
            <div className="nouveau-sujet-verifie" data-node={n('travail.verifie')}>
              <h3 className="nouveau-sujet-verifie-titre">Vérifié à l’instant</h3>
              <ul>
                {verifie.map((v, i) => (
                  <li
                    key={v.texte}
                    className={`nouveau-sujet-verifie--${v.etat}`}
                    data-node={n(`travail.verifie.${i + 1}`)}
                  >
                    <span aria-hidden="true">{GLYPHE[v.etat]}</span> {v.texte}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {donnees && (
            <p className="texte-discret" data-node={n('travail.donnees')}>
              {donnees}
            </p>
          )}
        </section>
      </form>
      {error && (
        <p className="message-erreur" role="alert" data-node={n('erreur')}>
          {error}
        </p>
      )}
      <div className="nouveau-sujet-pied" data-node={n('pied')}>
        {etat && (
          <p className="nouveau-sujet-etat" role="status" data-node={n('pied.etat')}>
            {etat}
          </p>
        )}
        <p className="texte-discret" data-node={n('pied.effet')}>
          À la création : rien n’est publié. Tu pourras publier plus tard.
        </p>
        <button
          className="bouton"
          data-node={n('pied.annuler')}
          data-action="nav.retour"
          type="button"
          onClick={annuler}
        >
          Annuler
        </button>
        <button
          className="bouton bouton--primaire"
          data-node={n('pied.creer')}
          data-action="sujet.creer"
          type="submit"
          form="nouveau-sujet-formulaire"
          disabled={running || !slug || !workspace}
        >
          {etat ??
            (phase.etape === 'creation'
              ? 'Création…'
              : agent === 'aucun'
                ? 'Créer le sujet'
                : 'Créer et demander un plan')}
        </button>
      </div>
    </main>
  );
}

export function NouveauSujet() {
  return (
    <Layout screen="nouveau-sujet">
      <Contenu />
    </Layout>
  );
}

function LigneCarte({
  carte,
  destination,
}: {
  carte: number;
  destination: { page: string; state?: unknown };
}) {
  const client = useAidClient();
  const [resultat, setResultat] = useState<BoardAid | null>(null);
  const [erreur, setErreur] = useState('');
  const [copie, setCopie] = useState('');
  useEffect(() => {
    let actif = true;
    client
      .request<BoardAid>('GET', '/api/aid/board')
      .then((r) => {
        if (actif) setResultat(r);
      })
      .catch(() => {
        if (actif) setErreur("Le lien A-I-D n'a pas pu être lu.");
      });
    return () => {
      actif = false;
    };
  }, [client]);
  const id = destination.page.split('?')[0]!.split('/').at(-1);
  const sujet = resultat?.sujets.find((s) => s.sujetId === id);
  async function copier() {
    try {
      await navigator.clipboard.writeText(`AID: ${sujet!.lien}`);
      setCopie('Copié.');
    } catch {
      setCopie('Copie impossible : accès au presse-papiers refusé.');
    }
  }
  return (
    <main className="page nouveau-sujet">
      <h1>Sujet créé</h1>
      {sujet ? (
        sujet.lien ? (
          <>
            <p>Ajoute cette ligne à la carte #{carte} :</p>
            <pre>{`AID: ${sujet.lien}`}</pre>
            <button onClick={() => void copier()}>Copier la ligne</button>
          </>
        ) : (
          <p>Pas de remote GitHub : pas de lien possible</p>
        )
      ) : (
        <p role="status">
          {erreur || (resultat ? "Le lien A-I-D n'a pas pu être lu." : 'Lecture du lien A-I-D…')}
        </p>
      )}
      <p role="status">{copie}</p>
      <Link to={destination.page} state={destination.state}>
        Ouvrir le sujet
      </Link>
    </main>
  );
}

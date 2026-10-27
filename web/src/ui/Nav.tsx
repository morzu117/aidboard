import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import type { Agent, NavGroup, NavPlacement, NavState, Topic } from '../../../src/shared/model.js';
import { useAid } from '../data/useAidState.js';
import type { EcranId } from './Barre.js';
import { depuis } from './depuis.js';
import { useLayout } from './Layout.js';
import { Badge, isAlive, Point, topicView } from './Statut.js';

type VueId = 'tous' | 'a-decider' | 'agent-libre' | 'sans-agent' | 'epingles' | 'archives';

const VUES: readonly { id: VueId; label: string }[] = [
  { id: 'tous', label: 'Tous' },
  { id: 'a-decider', label: 'À décider' },
  { id: 'agent-libre', label: 'Agent libre' },
  { id: 'sans-agent', label: 'Sans agent' },
  { id: 'epingles', label: 'Épinglés' },
  { id: 'archives', label: 'Archivés' },
];

// Cache de module (§2.2) : affiché immédiatement au remontage de Nav (Layout la remonte à
// chaque écran), rafraîchi ensuite en tâche de fond pour éviter le clignotement.
let navCache: Partial<NavState> | null = null;

/** Groupe B (D55) : lecture seule — ni glisser-déposer, ni renommage, ni réordonnancement (B.3). */
export function Nav({ screen }: { screen: EcranId }) {
  const { state, daemon, call } = useAid();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const { openNewTopic } = useLayout();
  const currentTopicId = pathname.startsWith('/sujets/') ? pathname.slice('/sujets/'.length) : null;
  const n = (rest: string) => `${screen}.barre-gauche.${rest}`;

  const [nav, setNav] = useState<Partial<NavState>>(() => navCache ?? {});
  const updateNav = (updater: (cur: Partial<NavState>) => Partial<NavState>) => {
    setNav((cur) => {
      const next = updater(cur);
      navCache = next;
      return next;
    });
  };

  // Rafraîchit quand l'ENSEMBLE des ids de sujets/projets change, pas seulement leur nombre
  // (un sujet retiré et un autre ajouté au même instant garderait le même total).
  const idsKey = useMemo(() => {
    const topicIds = (state?.topics ?? []).map((t) => t.id).sort();
    const workspaceIds = (state?.workspaces ?? []).map((w) => w.id).sort();
    return [...topicIds, ...workspaceIds].join(',');
  }, [state?.topics, state?.workspaces]);

  useEffect(() => {
    let annule = false;
    call<NavState>('GET', '/api/nav')
      .then((reponse) => {
        if (annule) return;
        navCache = reponse;
        setNav(reponse);
      })
      .catch(() => {});
    return () => {
      annule = true;
    };
    // `call` change d'identité à chaque rendu (useAid le reconstruit à chaque fois) : le suivre
    // ici redéclencherait la lecture à l'infini (nouvel objet retourné à chaque fetch).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const vueCourante = params.get('vue');

  const topics = state?.topics ?? [];
  const groups = nav.groups ?? [];
  const placements = nav.placements ?? [];
  const placementByTopic = new Map(placements.map((p) => [p.topicId, p]));

  const agentsOf = (topicId: string): Agent[] => {
    if (!state) return [];
    const runIds = state.runs.filter((r) => r.topicId === topicId).map((r) => r.id);
    return state.agents.filter((a) => runIds.includes(a.runId));
  };

  const correspond = (t: Topic, p: NavPlacement, v: VueId): boolean => {
    if (v === 'archives') return p.archived;
    if (p.archived) return false;
    const agents = agentsOf(t.id);
    switch (v) {
      case 'tous':
        return true;
      case 'a-decider':
        return agents.some((a) => a.status === 'needs_input');
      case 'agent-libre':
        return agents.some((a) => isAlive(a) && a.role === 'free');
      case 'sans-agent':
        return agents.length === 0;
      case 'epingles':
        return p.pinned;
    }
  };

  const compte = (v: VueId): number => {
    // « À décider » reprend la définition de Layout (agents en attente), pas un compte de sujets.
    if (v === 'a-decider') {
      return state?.agents.filter((a) => a.status === 'needs_input').length ?? 0;
    }
    let total = 0;
    for (const t of topics) {
      const p = placementByTopic.get(t.id);
      if (p && correspond(t, p, v)) total += 1;
    }
    return total;
  };

  const toggleCollapse = (g: NavGroup) => {
    const suivant = !g.collapsed;
    updateNav((cur) => ({
      ...cur,
      groups: (cur.groups ?? []).map((x) => (x.id === g.id ? { ...x, collapsed: suivant } : x)),
    }));
    call('PATCH', `/api/nav/groups/${g.id}`, { collapsed: suivant }).catch(() => {
      updateNav((cur) => ({
        ...cur,
        groups: (cur.groups ?? []).map((x) =>
          x.id === g.id ? { ...x, collapsed: g.collapsed } : x,
        ),
      }));
    });
  };

  const mesh = state?.mesh;
  const meshTexte = mesh
    ? mesh.state.connected
      ? `mesh · cell ${mesh.state.cell}`
      : 'mesh hors ligne'
    : null;

  return (
    <nav className="barre-gauche" data-node={n('racine')} aria-label="Navigation des sujets">
      <button
        type="button"
        className="bouton bouton--primaire barre-gauche-nouveau"
        data-node="nav.nouveau-sujet"
        onClick={() => openNewTopic()}
      >
        Nouveau sujet
      </button>
      <ul className="barre-gauche-vues" data-node={n('vues')}>
        {VUES.map((v) => {
          const actif =
            pathname === '/' && (vueCourante === v.id || (v.id === 'tous' && vueCourante === null));
          return (
            <li key={v.id}>
              <Link
                to={`/?vue=${v.id}`}
                className={`barre-gauche-vue${actif ? ' est-active' : ''}`}
                data-node={n(`vue-${v.id}`)}
                aria-current={actif ? 'page' : undefined}
              >
                <span className="barre-gauche-vue-nom">{v.label}</span>
                {v.id !== 'archives' && (
                  <span className="compteur" data-node={n(`vue-${v.id}.compte`)}>
                    {compte(v.id)}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="barre-gauche-groupes" data-node={n('groupes')}>
        <h2 className="titre-zone">Groupes</h2>
        {groups
          .filter((g) => !g.hidden)
          .map((g) => {
            const sujetsGroupe = placements
              .filter((p) => p.groupId === g.id && !p.hidden && !p.archived)
              .sort((a, b) => a.ord - b.ord)
              .map((p) => ({ p, t: topics.find((t) => t.id === p.topicId) }))
              .filter((x): x is { p: NavPlacement; t: Topic } => !!x.t);
            return (
              <div key={g.id} className="barre-gauche-groupe" data-node={n(`groupe-${g.id}`)}>
                <button
                  type="button"
                  className="barre-gauche-groupe-entete"
                  data-node={n(`groupe-${g.id}.bascule`)}
                  aria-expanded={!g.collapsed}
                  onClick={() => toggleCollapse(g)}
                >
                  <span
                    className="barre-gauche-groupe-couleur"
                    style={{ background: g.color }}
                    aria-hidden="true"
                  />
                  <span className="barre-gauche-groupe-nom">{g.name}</span>
                  <span className="compteur">{sujetsGroupe.length}</span>
                </button>
                {!g.collapsed &&
                  sujetsGroupe.map(({ p, t }) => {
                    const vueStatut = topicView(agentsOf(t.id));
                    const actif = t.id === currentTopicId;
                    return (
                      <Link
                        key={t.id}
                        to={`/sujets/${t.id}`}
                        className={`barre-gauche-sujet${actif ? ' est-actif' : ''}`}
                        data-node={n(`sujet-${t.id}`)}
                        title={t.branch}
                        aria-current={actif ? 'page' : undefined}
                      >
                        <Point
                          tone={vueStatut.tone}
                          label={vueStatut.label}
                          estimated={vueStatut.estimated}
                        />
                        <span className="barre-gauche-sujet-nom" data-bind="sujet.nom">
                          {p.displayName ?? t.branch}
                        </span>
                        <Badge view={vueStatut} />
                        <span className="barre-gauche-sujet-temps" data-bind="sujet.depuis">
                          {depuis(t.updatedAt)}
                        </span>
                      </Link>
                    );
                  })}
              </div>
            );
          })}
      </div>
      <div className="barre-gauche-pied" data-node={n('pied')}>
        <span
          className={`point point--${daemon === 'connecte' ? 'ok' : 'erreur'}`}
          aria-hidden="true"
        />
        <span className="barre-gauche-pied-texte" data-node={n('pied.texte')}>
          {daemon === 'connecte' ? 'daemon local' : 'daemon injoignable'}
          {meshTexte ? ` · ${meshTexte}` : ''}
        </span>
      </div>
    </nav>
  );
}

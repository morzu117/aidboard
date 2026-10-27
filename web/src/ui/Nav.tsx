import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import type { Agent, NavGroup, NavPlacement, NavState, Topic } from '../../../src/shared/model.js';
import { useAid } from '../data/useAidState.js';
import type { EcranId } from './Barre.js';
import { depuis } from './depuis.js';
import { Badge, isAlive, Point, topicView } from './Statut.js';

type VueId = 'tous' | 'decider' | 'libre' | 'sans-agent' | 'epingles' | 'archives';

const VUES: readonly { id: VueId; label: string }[] = [
  { id: 'tous', label: 'Tous' },
  { id: 'decider', label: 'À décider' },
  { id: 'libre', label: 'Agent libre' },
  { id: 'sans-agent', label: 'Sans agent' },
  { id: 'epingles', label: 'Épinglés' },
  { id: 'archives', label: 'Archivés' },
];

/** Groupe B (D55) : lecture seule — ni glisser-déposer, ni renommage, ni réordonnancement (B.3). */
export function Nav({ screen }: { screen: EcranId }) {
  const { state, daemon, call } = useAid();
  const { pathname } = useLocation();
  const currentTopicId = pathname.startsWith('/sujets/') ? pathname.slice('/sujets/'.length) : null;
  const n = (rest: string) => `${screen}.barre-gauche.${rest}`;

  // Pas de cache module : Layout remonte Nav à chaque écran, ce qui refait l'appel — acceptable,
  // les groupes/placements ne bougent pas plus vite qu'une navigation d'écran.
  const [nav, setNav] = useState<Partial<NavState>>({});
  useEffect(() => {
    let annule = false;
    call<NavState>('GET', '/api/nav')
      .then((reponse) => {
        if (!annule) setNav(reponse);
      })
      .catch(() => {});
    return () => {
      annule = true;
    };
    // `call` change d'identité à chaque rendu (useAid le reconstruit à chaque fois) : le suivre
    // ici redéclencherait la lecture à l'infini (nouvel objet retourné à chaque fetch).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.topics.length, state?.workspaces.length]);

  const [vue, setVue] = useState<VueId>('tous');

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
      case 'decider':
        return agents.some((a) => a.status === 'needs_input');
      case 'libre':
        return agents.some((a) => isAlive(a) && a.role === 'free');
      case 'sans-agent':
        return agents.length === 0;
      case 'epingles':
        return p.pinned;
    }
  };

  const compte = (v: VueId): number => {
    // « À décider » reprend la définition de Layout (agents en attente), pas un compte de sujets.
    if (v === 'decider') {
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
    setNav((cur) => ({
      ...cur,
      groups: (cur.groups ?? []).map((x) => (x.id === g.id ? { ...x, collapsed: suivant } : x)),
    }));
    call('PATCH', `/api/nav/groups/${g.id}`, { collapsed: suivant }).catch(() => {
      setNav((cur) => ({
        ...cur,
        groups: (cur.groups ?? []).map((x) =>
          x.id === g.id ? { ...x, collapsed: g.collapsed } : x,
        ),
      }));
    });
  };

  const reduit = nav.prefs?.reduit ?? false;
  const toggleReduit = () => {
    const suivant = !reduit;
    setNav((cur) => ({ ...cur, prefs: { reduit: suivant } }));
    call('PATCH', '/api/nav/prefs', { reduit: suivant }).catch(() => {
      setNav((cur) => ({ ...cur, prefs: { reduit } }));
    });
  };

  const mesh = state?.mesh;
  const meshTexte = mesh
    ? mesh.state.connected
      ? `mesh · cell ${mesh.state.cell}`
      : 'mesh hors ligne'
    : null;

  return (
    <nav
      className={`barre-gauche${reduit ? ' barre-gauche--reduit' : ''}`}
      data-node={n('racine')}
      aria-label="Navigation des sujets"
    >
      <ul className="barre-gauche-vues" data-node={n('vues')}>
        {VUES.map((v) => (
          <li key={v.id}>
            <button
              type="button"
              className={`barre-gauche-vue${vue === v.id ? ' est-active' : ''}`}
              data-node={n(`vue-${v.id}`)}
              aria-pressed={vue === v.id}
              onClick={() => setVue(v.id)}
            >
              <span className="barre-gauche-vue-nom">{v.label}</span>
              {v.id !== 'archives' && (
                <span className="compteur" data-node={n(`vue-${v.id}.compte`)}>
                  {compte(v.id)}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      <div className="barre-gauche-groupes" data-node={n('groupes')}>
        <h2 className="titre-zone">Groupes</h2>
        {groups
          .filter((g) => !g.hidden)
          .map((g) => {
            const sujetsGroupe = placements
              .filter((p) => p.groupId === g.id)
              .sort((a, b) => a.ord - b.ord)
              .map((p) => ({ p, t: topics.find((t) => t.id === p.topicId) }))
              .filter(
                (x): x is { p: NavPlacement; t: Topic } => !!x.t && correspond(x.t, x.p, vue),
              );
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
        <button
          type="button"
          className="bouton-icone barre-gauche-reduire"
          data-node={n('reduire')}
          aria-label={reduit ? 'Déplier la navigation' : 'Réduire la navigation'}
          aria-pressed={reduit}
          onClick={toggleReduit}
        >
          {reduit ? '›' : '‹'}
        </button>
      </div>
    </nav>
  );
}

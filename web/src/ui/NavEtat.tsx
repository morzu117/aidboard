import { type Ref, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import type { Agent, NavPlacement, Topic } from '../../../src/shared/model.js';
import { useAid } from '../data/useAidState.js';
import { depuis, depuisCourt } from './depuis.js';
import { A_TRAITER, useLayout } from './Layout.js';
import { NavServeurs } from './NavServeurs.js';
import { etatMonitor } from './pastille.js';
import { SECTIONS, type SectionId, sectionDe, tuileProjet } from './rangement.js';
import { Point, ShellsEnArriere, topicView } from './Statut.js';

// Chantier 25 (D103-D105) : la barre gauche de la V4, qui range les sujets par ce qu'ils attendent de toi.
// Les groupes du chantier 15 restent intacts dans Nav, derrière la préférence `rangement: 'groupes'`.

// Comme le cache de Nav : Layout remonte la barre à chaque écran, le filtre et les replis survivent.
const REPLIS_DEFAUT: Partial<Record<SectionId, boolean>> = { 'en-pause': true };
const garde: { filtre: string | null; replis: Partial<Record<SectionId, boolean>> } = {
  filtre: null,
  replis: REPLIS_DEFAUT,
};

/** Réservé aux tests. */
export function resetNavEtatForTests(): void {
  garde.filtre = null;
  garde.replis = REPLIS_DEFAUT;
}

const LIENS_DISCRETS = [
  { id: 'tous', label: 'Tous' },
  { id: 'epingles', label: 'Épinglés' },
  { id: 'archives', label: 'Archivés' },
] as const;

export function NavEtat({
  n,
  couleurs,
  placements,
  agentsOf,
  erreur,
  onReduire,
  piedRef,
}: {
  n: (rest: string) => string;
  /** D105 : la palette des groupes, passée par Nav (pas d'export, pas d'import circulaire) */
  couleurs: readonly { valeur: string; ink: string }[];
  placements: NavPlacement[];
  agentsOf: (topicId: string) => Agent[];
  erreur: string | null;
  onReduire: () => void;
  piedRef: Ref<HTMLButtonElement>;
}) {
  const { state, daemon } = useAid();
  const { pathname } = useLocation();
  const { openNewTopic, meshBascule } = useLayout();
  const [filtre, setFiltre] = useState(garde.filtre);
  const [replis, setReplis] = useState(garde.replis);
  useEffect(() => {
    garde.filtre = filtre;
    garde.replis = replis;
  }, [filtre, replis]);
  const basculerSection = (id: SectionId) => setReplis((r) => ({ ...r, [id]: !r[id] }));

  const workspaces = state?.workspaces ?? [];
  const nomProjet = new Map(workspaces.map((w) => [w.id, w.name]));
  const placementDe = new Map(placements.map((p) => [p.topicId, p]));
  const currentTopicId = pathname.startsWith('/sujets/') ? pathname.slice('/sujets/'.length) : null;
  // archivés et masqués restent hors de la barre, comme dans les groupes ; un sujet pas encore placé s'affiche
  const visibles = (state?.topics ?? []).filter((t) => {
    const p = placementDe.get(t.id);
    return !p?.archived && !p?.hidden && (filtre === null || t.workspaceId === filtre);
  });
  const parSection = new Map<SectionId, Topic[]>(SECTIONS.map((s) => [s.id, []]));
  for (const t of visibles) parSection.get(sectionDe(agentsOf(t.id)))!.push(t);
  // épinglés d'abord, puis les plus récents
  const ordre = (a: Topic, b: Topic) =>
    Number(placementDe.get(b.id)?.pinned ?? false) -
      Number(placementDe.get(a.id)?.pinned ?? false) || b.updatedAt.localeCompare(a.updatedAt);

  const mesh = meshBascule?.mesh ?? state?.mesh;
  const aTraiter = mesh?.inbox.filter((d) => !d.seenAt && A_TRAITER.has(d.kind)).length ?? 0;

  return (
    <nav
      className="barre-gauche barre-gauche--etat"
      data-node={n('racine')}
      data-rangement="etat"
      aria-label="Navigation des sujets"
    >
      <button
        type="button"
        className="bouton bouton--primaire barre-gauche-nouveau"
        data-node="nav.nouveau-sujet"
        onClick={() => openNewTopic(filtre ?? undefined)}
      >
        Nouveau sujet
      </button>
      {workspaces.length > 1 && (
        <div
          className="nav-etat-projets"
          data-node={n('etat.projets')}
          role="group"
          aria-label="Filtrer par projet"
        >
          {workspaces.map((w) => {
            const tuile = tuileProjet(w.id, w.name, couleurs.length);
            const c = couleurs[tuile.couleur];
            const actif = filtre === w.id;
            return (
              <button
                key={w.id}
                type="button"
                className="nav-etat-tuile"
                data-node={n(`etat.projet-${w.id}`)}
                aria-pressed={actif}
                aria-label={w.name}
                title={w.name}
                style={{ background: c?.valeur, color: c?.ink }}
                onClick={() => setFiltre(actif ? null : w.id)}
              >
                {tuile.lettre}
              </button>
            );
          })}
        </div>
      )}
      <div className="nav-etat-sections" data-node={n('etat.sections')}>
        {visibles.length === 0 && (
          <p className="barre-gauche-serveurs-vide" data-node={n('etat.vide')}>
            {filtre ? 'Aucun sujet ouvert dans ce projet.' : 'Aucun sujet ouvert.'}
          </p>
        )}
        {SECTIONS.map((s) => {
          const sujets = parSection.get(s.id)!.sort(ordre);
          if (sujets.length === 0) return null;
          const replie = !!replis[s.id];
          return (
            <div key={s.id} className="nav-etat-section" data-node={n(`etat.section-${s.id}`)}>
              <button
                type="button"
                className="barre-gauche-groupe-entete"
                data-node={n(`etat.section-${s.id}.bascule`)}
                aria-expanded={!replie}
                onClick={() => basculerSection(s.id)}
              >
                <span className="barre-gauche-groupe-nom">{s.label}</span>
                <span className="barre-gauche-compte">{sujets.length}</span>
              </button>
              {!replie &&
                sujets.map((t) => {
                  const p = placementDe.get(t.id);
                  const agents = agentsOf(t.id);
                  const vue = topicView(agents);
                  const actif = t.id === currentTopicId;
                  return (
                    <Link
                      key={t.id}
                      to={`/sujets/${t.id}`}
                      className={`barre-gauche-sujet nav-etat-sujet nav-etat-sujet--${s.id}${actif ? ' est-actif' : ''}`}
                      data-node={n(`etat.sujet-${t.id}`)}
                      data-section={s.id}
                      title={t.branch}
                      aria-current={actif ? 'page' : undefined}
                    >
                      <Point tone={vue.tone} label={vue.label} estimated={vue.estimated} />
                      <span className="nav-etat-sujet-texte">
                        <span className="barre-gauche-sujet-nom" data-bind="sujet.nom">
                          {p?.displayName ?? t.branch}
                        </span>
                        <span className="nav-etat-sujet-projet" data-bind="sujet.projet">
                          {nomProjet.get(t.workspaceId) ?? ''}
                        </span>
                      </span>
                      <ShellsEnArriere agents={agents} />
                      <span
                        className="barre-gauche-sujet-temps"
                        data-bind="sujet.depuis"
                        title={depuis(t.updatedAt)}
                      >
                        {depuisCourt(t.updatedAt)}
                      </span>
                    </Link>
                  );
                })}
            </div>
          );
        })}
      </div>
      <div className="nav-etat-vues" data-node={n('etat.vues')}>
        {LIENS_DISCRETS.map((v) => (
          <Link key={v.id} to={`/?vue=${v.id}`} data-node={n(`etat.vue-${v.id}`)}>
            {v.label}
          </Link>
        ))}
      </div>
      <NavServeurs n={n} />
      <div className="nav-etat-meshes" data-node={n('etat.meshes')}>
        {mesh ? (
          <Link
            to="/reglages#mesh"
            className="barre-gauche-serveurs-lien"
            data-node={n('etat.meshes.mesh')}
            data-action="nav.reglages-mesh"
          >
            <span
              className={`point point--${mesh.state.connected ? 'ok' : 'inactif'}`}
              aria-hidden="true"
            />
            <span>Mesh · cell {mesh.state.cell}</span>
            <span className="nav-etat-sujet-projet" data-bind="mesh.etat">
              {etatMonitor(mesh.state, aTraiter, meshBascule?.enCours ?? false)}
            </span>
          </Link>
        ) : (
          state && (
            <Link
              to="/swarph"
              className="barre-gauche-serveurs-lien"
              data-node={n('etat.meshes.swarph')}
              data-action="nav.swarph"
            >
              Connecter à swarph
            </Link>
          )
        )}
      </div>
      {erreur && (
        <p className="barre-gauche-erreur" role="status" data-node={n('erreur')}>
          {erreur}
        </p>
      )}
      <div className="barre-gauche-pied" data-node={n('pied')}>
        <span
          className={`point point--${daemon === 'connecte' ? 'ok' : 'erreur'}`}
          aria-hidden="true"
        />
        <span className="barre-gauche-pied-texte" data-node={n('pied.texte')}>
          {daemon === 'connecte' ? 'daemon local' : 'daemon injoignable'}
        </span>
        <button
          ref={piedRef}
          type="button"
          className="barre-gauche-rail-bascule"
          data-node={n('reduire')}
          aria-label="Réduire la barre"
          title="Réduire la barre"
          onClick={onReduire}
        >
          ‹
        </button>
      </div>
    </nav>
  );
}

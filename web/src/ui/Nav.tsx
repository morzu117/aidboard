import { type DragEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import type { Agent, NavGroup, NavPlacement, NavState, Topic } from '../../../src/shared/model.js';
import { useAid } from '../data/useAidState.js';
import type { EcranId } from './Barre.js';
import { ContextMenu, type MenuItem } from './ContextMenu.js';
import { depuis } from './depuis.js';
import { useLayout } from './Layout.js';
import { Badge, isAlive, Point, topicView } from './Statut.js';

type VueId = 'tous' | 'a-decider' | 'agent-libre' | 'sans-agent' | 'epingles' | 'archives';

const VUES: readonly { id: VueId; label: string; railColor?: string }[] = [
  { id: 'tous', label: 'Tous', railColor: '#5de0a1' },
  { id: 'a-decider', label: 'À décider', railColor: '#f2b84b' },
  { id: 'agent-libre', label: 'Agent libre', railColor: '#6ea8ff' },
  { id: 'sans-agent', label: 'Sans agent' },
  { id: 'epingles', label: 'Épinglés' },
  { id: 'archives', label: 'Archivés' },
];
// Les trois vues principales du rail réduit (brief §5.2.3) : les trois premières de VUES.
const VUES_RAIL = VUES.slice(0, 3);

/** Deux initiales d'un nom de groupe pour le carré du rail réduit : deux mots → une lettre chacun, sinon les deux premières lettres. */
function initialesGroupe(nom: string): string {
  const mots = nom.trim().split(/\s+/).filter(Boolean);
  if (mots.length >= 2) return (mots[0]![0]! + mots[1]![0]!).toUpperCase();
  return nom.trim().slice(0, 2).toUpperCase();
}

// Palette de couleurs de groupe (BRIEF §5.2.1, même ordre que src/daemon/routes/nav.ts).
// `ink` : couleur de texte lisible sur `valeur`, reprise de la maquette Sidebar (carrés du rail).
const COULEURS_GROUPE: readonly { nom: string; valeur: string; ink: string }[] = [
  { nom: 'Menthe', valeur: '#5de0a1', ink: '#06251a' },
  { nom: 'Violet', valeur: '#a78bfa', ink: '#1b1238' },
  { nom: 'Orange', valeur: '#f59e6b', ink: '#3a1a06' },
  { nom: 'Bleu', valeur: '#6ea8ff', ink: '#0b2347' },
  { nom: 'Rose', valeur: '#f07ab0', ink: '#3d0f26' },
  { nom: 'Ambre', valeur: '#f2b84b', ink: '#2a1d00' },
  { nom: 'Turquoise', valeur: '#4fd1d9', ink: '#062f33' },
  { nom: 'Gris', valeur: '#8d94a0', ink: '#14161a' },
];

type Renommage = { kind: 'groupe' | 'sujet'; id: string; valeur: string };
type MenuOuvert = { kind: 'groupe' | 'sujet'; id: string };
type Glisse = { kind: 'groupe' | 'sujet'; id: string };
type Depot = { kind: 'groupe'; index: number } | { kind: 'sujet'; groupeId: string; index: number };

// Cache de module (§2.2) : affiché immédiatement au remontage de Nav (Layout la remonte à
// chaque écran), rafraîchi ensuite en tâche de fond pour éviter le clignotement.
let navCache: Partial<NavState> | null = null;

/** Réservé aux tests : vide le cache de module entre deux cas, sinon un cas hérite du nav du précédent. */
export function resetNavCacheForTests(): void {
  navCache = null;
}

/** Groupe B (D55) : barre gauche, lecture (B.2) et mode édition (B.3) — glisser-déposer, menu, renommage. */
export function Nav({ screen }: { screen: EcranId }) {
  const { state, daemon, call } = useAid();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const { openNewTopic } = useLayout();
  const currentTopicId = pathname.startsWith('/sujets/') ? pathname.slice('/sujets/'.length) : null;
  const n = (rest: string) => `${screen}.barre-gauche.${rest}`;

  // Le rail (B.4) n'applique qu'à partir de 1280 px : en dessous, le volet montre toujours la
  // barre complète quel que soit `prefs.reduit` (D58, point 13 du brief).
  const [large, setLarge] = useState(
    () => window.matchMedia?.('(min-width: 1280px)')?.matches ?? true,
  );
  useEffect(() => {
    const mq = window.matchMedia?.('(min-width: 1280px)');
    if (!mq) return;
    const onChange = () => setLarge(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  const [nav, setNav] = useState<Partial<NavState>>(() => navCache ?? {});
  const updateNav = (updater: (cur: Partial<NavState>) => Partial<NavState>) => {
    setNav((cur) => {
      const next = updater(cur);
      navCache = next;
      return next;
    });
  };

  const [edit, setEdit] = useState(false);
  const [renommage, setRenommage] = useState<Renommage | null>(null);
  const [menuOuvert, setMenuOuvert] = useState<MenuOuvert | null>(null);
  const [glisse, setGlisse] = useState<Glisse | null>(null);
  const [depot, setDepot] = useState<Depot | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const renommageRef = useRef<HTMLInputElement>(null);
  // posé par Échap, lu par validerRenommage : un blur émis par le démontage du champ (certains
  // navigateurs) ne doit jamais enregistrer ce qu'Échap vient d'annuler.
  const annulationRenommageRef = useRef(false);
  const actionsRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  // Un déplacement entre groupes remonte le bouton « ··· » ailleurs dans l'arbre React (clé
  // présente dans un autre tableau d'enfants) : le focus ne peut se reposer qu'après ce rendu,
  // jamais de façon synchrone dans le gestionnaire qui déclenche le déplacement (§2.4, point 8).
  const focusApresRef = useRef<string | null>(null);
  useEffect(() => {
    const id = focusApresRef.current;
    if (!id) return;
    actionsRefs.current.get(id)?.focus();
    focusApresRef.current = null;
  }, [nav, menuOuvert]);

  const toggleEdit = () => {
    setEdit((e) => !e);
    setRenommage(null);
    setMenuOuvert(null);
    setGlisse(null);
    setDepot(null);
  };

  useEffect(() => {
    if (renommage) {
      renommageRef.current?.focus();
      renommageRef.current?.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renommage?.kind, renommage?.id]);

  useEffect(() => {
    if (!erreur) return;
    const t = setTimeout(() => setErreur(null), 4000);
    return () => clearTimeout(t);
  }, [erreur]);

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
  const rail = large && (nav.prefs?.reduit ?? false);

  const toggleReduit = () => {
    const suivant = !(nav.prefs?.reduit ?? false);
    updateNav((cur) => ({
      ...cur,
      prefs: { ...(cur.prefs ?? { reduit: false }), reduit: suivant },
    }));
    call('PATCH', '/api/nav/prefs', { reduit: suivant }).catch(() => {
      updateNav((cur) => ({
        ...cur,
        prefs: { ...(cur.prefs ?? { reduit: false }), reduit: !suivant },
      }));
      setErreur('Impossible d’enregistrer le mode réduit.');
    });
  };

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

  // Sujets d'un groupe (archivés exclus partout — B.3 ne désarchive pas, groupe C) : épinglés en
  // tête (§5.2.2), puis par ordre manuel. Référence commune au rendu et aux calculs de déplacement.
  const ordreSujets = (groupId: string): NavPlacement[] =>
    placements
      .filter((p) => p.groupId === groupId && !p.archived)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.ord - b.ord);

  const patchPlacement = async (
    topicId: string,
    patch: Partial<Pick<NavPlacement, 'pinned' | 'archived' | 'hidden' | 'displayName'>>,
    messageErreur: string,
  ) => {
    const avant = placementByTopic.get(topicId);
    updateNav((cur) => ({
      ...cur,
      placements: (cur.placements ?? []).map((p) =>
        p.topicId === topicId ? { ...p, ...patch } : p,
      ),
    }));
    try {
      await call('PATCH', `/api/nav/placements/${topicId}`, patch);
    } catch {
      if (avant) {
        updateNav((cur) => ({
          ...cur,
          placements: (cur.placements ?? []).map((p) => (p.topicId === topicId ? avant : p)),
        }));
      }
      setErreur(messageErreur);
    }
  };

  const patchGroupe = async (
    groupId: string,
    patch: Partial<Pick<NavGroup, 'name' | 'color' | 'hidden'>>,
    messageErreur: string,
  ) => {
    const avant = groups.find((g) => g.id === groupId);
    updateNav((cur) => ({
      ...cur,
      groups: (cur.groups ?? []).map((g) => (g.id === groupId ? { ...g, ...patch } : g)),
    }));
    try {
      await call('PATCH', `/api/nav/groups/${groupId}`, patch);
    } catch {
      if (avant) {
        updateNav((cur) => ({
          ...cur,
          groups: (cur.groups ?? []).map((g) => (g.id === groupId ? avant : g)),
        }));
      }
      setErreur(messageErreur);
    }
  };

  const rafraichirApresEchec = () => {
    call<NavState>('GET', '/api/nav')
      .then((r) => {
        navCache = r;
        setNav(r);
      })
      .catch(() => {});
  };

  const reordonnerGroupe = async (groupId: string, topicIds: string[]) => {
    updateNav((cur) => ({
      ...cur,
      placements: (cur.placements ?? []).map((p) => {
        if (p.groupId !== groupId) return p;
        const i = topicIds.indexOf(p.topicId);
        return i === -1 ? p : { ...p, ord: i };
      }),
    }));
    try {
      await call('PUT', `/api/nav/groups/${groupId}/topics`, { topicIds });
    } catch {
      setErreur('Impossible de réordonner les sujets.');
      rafraichirApresEchec();
    }
  };

  const reordonnerGroupes = async (ids: string[]) => {
    updateNav((cur) => {
      const map = new Map((cur.groups ?? []).map((g) => [g.id, g] as const));
      return {
        ...cur,
        groups: ids.map((id, i) => ({
          ...(map.get(id) ?? groups.find((g) => g.id === id))!,
          ord: i,
        })),
      };
    });
    try {
      await call('PUT', '/api/nav/groups/order', { ids });
    } catch {
      setErreur('Impossible de réordonner les groupes.');
      rafraichirApresEchec();
    }
  };

  const creerGroupe = async () => {
    try {
      const g = await call<NavGroup>('POST', '/api/nav/groups', { name: 'Nouveau groupe' });
      updateNav((cur) => ({ ...cur, groups: [...(cur.groups ?? []), g] }));
      setRenommage({ kind: 'groupe', id: g.id, valeur: g.name });
    } catch {
      setErreur('Impossible de créer le groupe.');
    }
  };

  const commencerRenommage = (kind: 'groupe' | 'sujet', id: string, valeurActuelle: string) => {
    if (!edit) return;
    annulationRenommageRef.current = false;
    setRenommage({ kind, id, valeur: valeurActuelle });
  };
  const annulerRenommage = () => {
    annulationRenommageRef.current = true;
    setRenommage(null);
  };
  const validerRenommage = () => {
    if (annulationRenommageRef.current) {
      annulationRenommageRef.current = false;
      return;
    }
    if (!renommage) return;
    const { kind, id, valeur } = renommage;
    const texte = valeur.trim();
    setRenommage(null);
    if (kind === 'groupe') {
      // pour un groupe, vide = annulation (BRIEF §5.2.1, point 6) : aucune écriture.
      if (texte.length === 0) return;
      void patchGroupe(id, { name: texte }, 'Impossible de renommer le groupe.');
    } else {
      void patchPlacement(
        id,
        { displayName: texte.length === 0 ? null : texte },
        'Impossible de renommer le sujet.',
      );
    }
  };

  const deplacerVersGroupe = async (topicId: string, groupId: string) => {
    const avant = placementByTopic.get(topicId);
    if (!avant || avant.groupId === groupId) return;
    const ord = placements.filter((p) => p.groupId === groupId && !p.archived).length;
    updateNav((cur) => ({
      ...cur,
      placements: (cur.placements ?? []).map((p) =>
        p.topicId === topicId ? { ...p, groupId, ord } : p,
      ),
    }));
    try {
      await call('PATCH', `/api/nav/placements/${topicId}`, { groupId });
    } catch {
      updateNav((cur) => ({
        ...cur,
        placements: (cur.placements ?? []).map((p) => (p.topicId === topicId ? avant : p)),
      }));
      setErreur('Impossible de déplacer le sujet.');
    }
  };

  const monterSujet = (topicId: string) => {
    const p = placementByTopic.get(topicId);
    if (!p) return;
    const liste = ordreSujets(p.groupId).map((x) => x.topicId);
    const i = liste.indexOf(topicId);
    if (i <= 0) return;
    const tmp = liste[i - 1]!;
    liste[i - 1] = liste[i]!;
    liste[i] = tmp;
    void reordonnerGroupe(p.groupId, liste);
  };
  const descendreSujet = (topicId: string) => {
    const p = placementByTopic.get(topicId);
    if (!p) return;
    const liste = ordreSujets(p.groupId).map((x) => x.topicId);
    const i = liste.indexOf(topicId);
    if (i === -1 || i >= liste.length - 1) return;
    const tmp = liste[i + 1]!;
    liste[i + 1] = liste[i]!;
    liste[i] = tmp;
    void reordonnerGroupe(p.groupId, liste);
  };

  const deplacerSujetVersPosition = async (topicId: string, groupId: string, index: number) => {
    const avant = placementByTopic.get(topicId);
    const memeGroupe = avant?.groupId === groupId;
    const ordreAvant = ordreSujets(groupId).map((p) => p.topicId);
    const indexAvant = memeGroupe ? ordreAvant.indexOf(topicId) : -1;
    // `index` vise la liste COMPLÈTE (élément glissé compris) : le retirer avant de la retrouver
    // décale toute position qui le suivait, d'où le décalage d'une place à décrémenter ici.
    const indexCible = indexAvant !== -1 && indexAvant < index ? index - 1 : index;
    const autres = ordreAvant.filter((id) => id !== topicId);
    autres.splice(indexCible, 0, topicId);
    if (memeGroupe && autres.join() === ordreAvant.join()) return;
    updateNav((cur) => ({
      ...cur,
      placements: (cur.placements ?? []).map((p) => {
        if (p.topicId === topicId) return { ...p, groupId, ord: autres.indexOf(topicId) };
        const i = autres.indexOf(p.topicId);
        return i === -1 ? p : { ...p, ord: i };
      }),
    }));
    try {
      if (!memeGroupe) await call('PATCH', `/api/nav/placements/${topicId}`, { groupId });
      await call('PUT', `/api/nav/groups/${groupId}/topics`, { topicIds: autres });
    } catch {
      setErreur('Impossible de déplacer le sujet.');
      rafraichirApresEchec();
    }
  };

  const monterGroupe = (groupId: string) => {
    const ids = groups.map((g) => g.id);
    const i = ids.indexOf(groupId);
    if (i <= 0) return;
    const tmp = ids[i - 1]!;
    ids[i - 1] = ids[i]!;
    ids[i] = tmp;
    void reordonnerGroupes(ids);
  };
  const descendreGroupe = (groupId: string) => {
    const ids = groups.map((g) => g.id);
    const i = ids.indexOf(groupId);
    if (i === -1 || i >= ids.length - 1) return;
    const tmp = ids[i + 1]!;
    ids[i + 1] = ids[i]!;
    ids[i] = tmp;
    void reordonnerGroupes(ids);
  };
  const enHautGroupe = (groupId: string) => {
    const ids = [groupId, ...groups.map((g) => g.id).filter((id) => id !== groupId)];
    void reordonnerGroupes(ids);
  };
  const enBasGroupe = (groupId: string) => {
    const ids = [...groups.map((g) => g.id).filter((id) => id !== groupId), groupId];
    void reordonnerGroupes(ids);
  };
  const deplacerGroupeVersPosition = (groupId: string, index: number) => {
    const idsAvant = groups.map((g) => g.id);
    const indexAvant = idsAvant.indexOf(groupId);
    // même décalage que pour les sujets (voir deplacerSujetVersPosition) : décrémenter quand le
    // groupe glissé était avant la position visée.
    const indexCible = indexAvant !== -1 && indexAvant < index ? index - 1 : index;
    const autres = idsAvant.filter((id) => id !== groupId);
    autres.splice(indexCible, 0, groupId);
    if (autres.join() === idsAvant.join()) return;
    void reordonnerGroupes(autres);
  };

  const onDragStartSujet = (e: DragEvent, topicId: string) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', topicId);
    setGlisse({ kind: 'sujet', id: topicId });
  };
  const onDragStartGroupe = (e: DragEvent, groupId: string) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', groupId);
    setGlisse({ kind: 'groupe', id: groupId });
  };
  const onDragEnd = () => {
    setGlisse(null);
    setDepot(null);
  };
  const onDragOverSujetRow = (e: DragEvent, groupId: string, index: number) => {
    if (glisse?.kind !== 'sujet') return;
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const avant = e.clientY < rect.top + rect.height / 2;
    setDepot({ kind: 'sujet', groupeId: groupId, index: avant ? index : index + 1 });
  };
  const onDragOverGroupeBloc = (e: DragEvent, index: number, groupId: string, nbSujets: number) => {
    if (glisse?.kind === 'groupe') {
      e.preventDefault();
      e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      const avant = e.clientY < rect.top + rect.height / 2;
      setDepot({ kind: 'groupe', index: avant ? index : index + 1 });
    } else if (glisse?.kind === 'sujet') {
      e.preventDefault();
      e.stopPropagation();
      setDepot({ kind: 'sujet', groupeId: groupId, index: nbSujets });
    }
  };
  const onDropGroupeBloc = (e: DragEvent, groupId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (glisse?.kind === 'groupe' && depot?.kind === 'groupe') {
      deplacerGroupeVersPosition(glisse.id, depot.index);
    } else if (glisse?.kind === 'sujet' && depot?.kind === 'sujet' && depot.groupeId === groupId) {
      void deplacerSujetVersPosition(glisse.id, groupId, depot.index);
    }
    setGlisse(null);
    setDepot(null);
  };
  const onDragOverGroupesFin = (e: DragEvent) => {
    if (glisse?.kind !== 'groupe') return;
    e.preventDefault();
    setDepot({ kind: 'groupe', index: groups.length });
  };
  const onDropGroupesFin = (e: DragEvent) => {
    e.preventDefault();
    if (glisse?.kind === 'groupe' && depot?.kind === 'groupe') {
      deplacerGroupeVersPosition(glisse.id, depot.index);
    }
    setGlisse(null);
    setDepot(null);
  };

  const menuSujet = (t: Topic, p: NavPlacement): MenuItem[] => [
    {
      id: 'renommer',
      label: 'Renommer',
      onSelect: () => commencerRenommage('sujet', t.id, p.displayName ?? t.branch),
    },
    {
      id: 'deplacer',
      label: 'Déplacer vers…',
      submenu: [
        ...groups.map((g) => ({
          id: `groupe-${g.id}`,
          label: g.name,
          disabled: g.id === p.groupId,
          onSelect: () => void deplacerVersGroupe(t.id, g.id),
        })),
        { id: 'monter', label: 'Monter', onSelect: () => monterSujet(t.id) },
        { id: 'descendre', label: 'Descendre', onSelect: () => descendreSujet(t.id) },
      ],
    },
    {
      id: 'epingler',
      label: p.pinned ? 'Désépingler' : 'Épingler en haut',
      onSelect: () =>
        void patchPlacement(t.id, { pinned: !p.pinned }, 'Impossible d’épingler le sujet.'),
    },
    {
      id: 'masquer',
      label: p.hidden ? 'Afficher dans la barre' : 'Masquer de la barre',
      onSelect: () =>
        void patchPlacement(t.id, { hidden: !p.hidden }, 'Impossible de masquer le sujet.'),
    },
    {
      id: 'archiver',
      label: 'Archiver',
      separatorBefore: true,
      onSelect: () =>
        void patchPlacement(t.id, { archived: true }, 'Impossible d’archiver le sujet.'),
    },
  ];

  const menuGroupe = (g: NavGroup): MenuItem[] => [
    {
      id: 'renommer',
      label: 'Renommer',
      onSelect: () => commencerRenommage('groupe', g.id, g.name),
    },
    {
      id: 'couleur',
      label: 'Couleur',
      submenu: COULEURS_GROUPE.map((c) => ({
        id: `couleur-${c.valeur}`,
        label: c.nom,
        swatch: c.valeur,
        onSelect: () =>
          void patchGroupe(g.id, { color: c.valeur }, 'Impossible de changer la couleur.'),
      })),
    },
    {
      id: 'deplacer',
      label: 'Déplacer vers…',
      submenu: [
        { id: 'monter', label: 'Monter', onSelect: () => monterGroupe(g.id) },
        { id: 'descendre', label: 'Descendre', onSelect: () => descendreGroupe(g.id) },
        { id: 'haut', label: 'En haut', onSelect: () => enHautGroupe(g.id) },
        { id: 'bas', label: 'En bas', onSelect: () => enBasGroupe(g.id) },
      ],
    },
    {
      id: 'masquer',
      label: g.hidden ? 'Afficher dans la barre' : 'Masquer de la barre',
      onSelect: () =>
        void patchGroupe(g.id, { hidden: !g.hidden }, 'Impossible de masquer le groupe.'),
    },
  ];

  const mesh = state?.mesh;
  const meshTexte = mesh
    ? mesh.state.connected
      ? `mesh · cell ${mesh.state.cell}`
      : 'mesh hors ligne'
    : null;

  return (
    <nav
      className={`barre-gauche${rail ? ' barre-gauche--rail' : ''}`}
      data-node={n('racine')}
      aria-label="Navigation des sujets"
    >
      {rail ? (
        <div className="barre-gauche-rail" data-node={n('rail')}>
          <button
            type="button"
            className="barre-gauche-rail-case barre-gauche-rail-nouveau"
            data-node={n('rail.nouveau-sujet')}
            title="Nouveau sujet"
            aria-label="Nouveau sujet"
            onClick={() => openNewTopic()}
          >
            +
          </button>
          <ul className="barre-gauche-rail-vues" data-node={n('rail.vues')}>
            {VUES_RAIL.map((v) => {
              const c = compte(v.id);
              return (
                <li key={v.id}>
                  <Link
                    to={`/?vue=${v.id}`}
                    className="barre-gauche-rail-case barre-gauche-rail-vue"
                    data-node={n(`rail.vue-${v.id}`)}
                    title={v.label}
                    aria-label={c > 0 ? `${v.label} (${c})` : v.label}
                  >
                    <span
                      className="barre-gauche-rail-pastille"
                      style={{ background: v.railColor }}
                      aria-hidden="true"
                    />
                    {c > 0 && (
                      <span
                        className={`barre-gauche-rail-compte${
                          v.id === 'a-decider' ? ' barre-gauche-rail-compte--ambre' : ''
                        }`}
                        aria-hidden="true"
                      >
                        {c}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="barre-gauche-rail-separateur" aria-hidden="true" />
          <ul className="barre-gauche-rail-groupes" data-node={n('rail.groupes')}>
            {groups
              .filter((g) => !g.hidden)
              .map((g) => (
                <li key={g.id}>
                  <span
                    className="barre-gauche-rail-case barre-gauche-rail-groupe"
                    style={{
                      background: g.color,
                      color: COULEURS_GROUPE.find((c) => c.valeur === g.color)?.ink,
                    }}
                    role="img"
                    aria-label={g.name}
                    title={g.name}
                    data-node={n(`rail.groupe-${g.id}`)}
                  >
                    {initialesGroupe(g.name)}
                  </span>
                </li>
              ))}
          </ul>
          <button
            type="button"
            className="barre-gauche-rail-case barre-gauche-rail-bascule"
            data-node={n('rail.deployer')}
            aria-label="Déployer la barre"
            title="Déployer la barre"
            onClick={toggleReduit}
          >
            ›
          </button>
        </div>
      ) : (
        <>
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
                pathname === '/' &&
                (vueCourante === v.id || (v.id === 'tous' && vueCourante === null));
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
          <div
            className="barre-gauche-groupes"
            data-node={n('groupes')}
            onDragOver={onDragOverGroupesFin}
            onDrop={onDropGroupesFin}
          >
            <div className="barre-gauche-groupes-entete">
              <h2 className="titre-zone">Groupes</h2>
              <button
                type="button"
                className={`bouton-modifier${edit ? ' bouton-modifier--actif' : ''}`}
                data-node={n('groupes.modifier')}
                aria-pressed={edit}
                onClick={toggleEdit}
              >
                {edit ? 'Terminer' : 'Modifier'}
              </button>
              <button
                type="button"
                className="barre-gauche-actions"
                data-node={n('groupes.nouveau')}
                aria-label="Nouveau groupe"
                onClick={() => void creerGroupe()}
              >
                +
              </button>
            </div>
            {groups
              .filter((g) => !g.hidden || edit)
              .map((g, i) => {
                const sujetsGroupe = ordreSujets(g.id)
                  .filter((p) => !p.hidden || edit)
                  .map((p) => ({ p, t: topics.find((t) => t.id === p.topicId) }))
                  .filter((x): x is { p: NavPlacement; t: Topic } => !!x.t);
                const renommeGroupe = renommage?.kind === 'groupe' && renommage.id === g.id;
                return (
                  <div
                    key={g.id}
                    className={`barre-gauche-groupe${edit && g.hidden ? ' barre-gauche-groupe--masque' : ''}`}
                    data-node={n(`groupe-${g.id}`)}
                    onDragOver={(e) => onDragOverGroupeBloc(e, i, g.id, sujetsGroupe.length)}
                    onDrop={(e) => onDropGroupeBloc(e, g.id)}
                  >
                    {depot?.kind === 'groupe' && depot.index === i && (
                      <div className="barre-gauche-repere-depot" aria-hidden="true" />
                    )}
                    <div
                      className={`barre-gauche-groupe-ligne${
                        glisse?.kind === 'groupe' && glisse.id === g.id
                          ? ' barre-gauche-groupe-ligne--glisse'
                          : ''
                      }`}
                      draggable={edit}
                      onDragStart={(e) => onDragStartGroupe(e, g.id)}
                      onDragEnd={onDragEnd}
                    >
                      {edit && (
                        <span className="barre-gauche-poignee" aria-hidden="true">
                          ⋮⋮
                        </span>
                      )}
                      {renommeGroupe ? (
                        <input
                          ref={renommageRef}
                          className="barre-gauche-renommage"
                          data-node={n(`groupe-${g.id}.renommer`)}
                          placeholder="Nom du groupe"
                          value={renommage!.valeur}
                          onChange={(e) =>
                            setRenommage({ kind: 'groupe', id: g.id, valeur: e.target.value })
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              validerRenommage();
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              annulerRenommage();
                            }
                          }}
                          onBlur={validerRenommage}
                        />
                      ) : (
                        <button
                          type="button"
                          className="barre-gauche-groupe-entete"
                          data-node={n(`groupe-${g.id}.bascule`)}
                          aria-expanded={!g.collapsed}
                          onClick={() => toggleCollapse(g)}
                          onDoubleClick={() => commencerRenommage('groupe', g.id, g.name)}
                        >
                          <span
                            className="barre-gauche-groupe-couleur"
                            style={{ background: g.color }}
                            aria-hidden="true"
                          />
                          <span className="barre-gauche-groupe-nom">{g.name}</span>
                          <span className="compteur">{sujetsGroupe.length}</span>
                        </button>
                      )}
                      {edit && (
                        <button
                          type="button"
                          className="barre-gauche-actions"
                          data-node={n(`groupe-${g.id}.actions`)}
                          aria-label={`Actions pour ${g.name}`}
                          ref={(el) => {
                            if (el) actionsRefs.current.set(g.id, el);
                            else actionsRefs.current.delete(g.id);
                          }}
                          onClick={() => setMenuOuvert({ kind: 'groupe', id: g.id })}
                        >
                          ···
                        </button>
                      )}
                      {menuOuvert?.kind === 'groupe' && menuOuvert.id === g.id && (
                        <ContextMenu
                          items={menuGroupe(g)}
                          label={`Actions pour ${g.name}`}
                          onClose={() => {
                            setMenuOuvert(null);
                            focusApresRef.current = g.id;
                          }}
                        />
                      )}
                    </div>
                    {!g.collapsed &&
                      sujetsGroupe.map(({ p, t }, idx) => {
                        const vueStatut = topicView(agentsOf(t.id));
                        const actif = t.id === currentTopicId;
                        const renommeSujet = renommage?.kind === 'sujet' && renommage.id === t.id;
                        return (
                          <div
                            key={t.id}
                            draggable={edit}
                            onDragStart={(e) => onDragStartSujet(e, t.id)}
                            onDragOver={(e) => onDragOverSujetRow(e, g.id, idx)}
                            onDragEnd={onDragEnd}
                          >
                            {depot?.kind === 'sujet' &&
                              depot.groupeId === g.id &&
                              depot.index === idx && (
                                <div className="barre-gauche-repere-depot" aria-hidden="true" />
                              )}
                            <div
                              className={`barre-gauche-sujet-ligne${
                                glisse?.kind === 'sujet' && glisse.id === t.id
                                  ? ' barre-gauche-sujet-ligne--glisse'
                                  : ''
                              }${edit && p.hidden ? ' barre-gauche-sujet-ligne--masque' : ''}`}
                            >
                              {edit && (
                                <span className="barre-gauche-poignee" aria-hidden="true">
                                  ⋮⋮
                                </span>
                              )}
                              {renommeSujet ? (
                                <div className="barre-gauche-renommage-bloc">
                                  <input
                                    ref={renommageRef}
                                    className="barre-gauche-renommage"
                                    data-node={n(`sujet-${t.id}.renommer`)}
                                    value={renommage!.valeur}
                                    onChange={(e) =>
                                      setRenommage({
                                        kind: 'sujet',
                                        id: t.id,
                                        valeur: e.target.value,
                                      })
                                    }
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        e.preventDefault();
                                        validerRenommage();
                                      } else if (e.key === 'Escape') {
                                        e.preventDefault();
                                        annulerRenommage();
                                      }
                                    }}
                                    onBlur={validerRenommage}
                                  />
                                  <span className="barre-gauche-renommage-indice">
                                    branche inchangée : {t.branch}
                                  </span>
                                </div>
                              ) : (
                                <Link
                                  to={`/sujets/${t.id}`}
                                  className={`barre-gauche-sujet${actif ? ' est-actif' : ''}`}
                                  data-node={n(`sujet-${t.id}`)}
                                  title={t.branch}
                                  aria-current={actif ? 'page' : undefined}
                                  onDoubleClick={(e) => {
                                    if (!edit) return;
                                    e.preventDefault();
                                    commencerRenommage('sujet', t.id, p.displayName ?? t.branch);
                                  }}
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
                                  <span
                                    className="barre-gauche-sujet-temps"
                                    data-bind="sujet.depuis"
                                  >
                                    {depuis(t.updatedAt)}
                                  </span>
                                </Link>
                              )}
                              {edit && (
                                <button
                                  type="button"
                                  className="barre-gauche-actions"
                                  data-node={n(`sujet-${t.id}.actions`)}
                                  aria-label={`Actions pour ${p.displayName ?? t.branch}`}
                                  ref={(el) => {
                                    if (el) actionsRefs.current.set(t.id, el);
                                    else actionsRefs.current.delete(t.id);
                                  }}
                                  onClick={() => setMenuOuvert({ kind: 'sujet', id: t.id })}
                                >
                                  ···
                                </button>
                              )}
                              {menuOuvert?.kind === 'sujet' && menuOuvert.id === t.id && (
                                <ContextMenu
                                  items={menuSujet(t, p)}
                                  label={`Actions pour ${p.displayName ?? t.branch}`}
                                  onClose={() => {
                                    setMenuOuvert(null);
                                    focusApresRef.current = t.id;
                                  }}
                                />
                              )}
                            </div>
                          </div>
                        );
                      })}
                  </div>
                );
              })}
            {edit && (
              <button
                type="button"
                className="barre-gauche-groupe-ajouter"
                data-node={n('groupes.nouveau-fin')}
                onClick={() => void creerGroupe()}
              >
                + Nouveau groupe
              </button>
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
              {meshTexte ? ` · ${meshTexte}` : ''}
            </span>
            <button
              type="button"
              className="barre-gauche-rail-bascule"
              data-node={n('reduire')}
              aria-label="Réduire la barre"
              title="Réduire la barre"
              onClick={toggleReduit}
            >
              ‹
            </button>
          </div>
        </>
      )}
    </nav>
  );
}

import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { MeshDmKind } from '../../../src/shared/model.js';
import { useBoardLuA } from '../data/board.js';
import { useAid } from '../data/useAidState.js';
import { type MeshBascule, useMeshBascule } from '../data/useMeshBascule.js';
import { NouveauWorkspace } from '../dialogues/NouveauWorkspace.js';
import { Barre, type EcranId } from './Barre.js';
import { decisionsEnAttente } from './boiteVue.js';
import { Nav } from './Nav.js';
import { isPaletteShortcut, Palette, type PaletteItem } from './Palette.js';
import { Shell } from './Shell.js';
import { Volet } from './Volet.js';

type Dialog = 'none' | 'workspace';
/** les kinds de DM qui demandent quelque chose (12.5) : partagé avec la Boîte et le Notifieur */
export const A_TRAITER = new Set<MeshDmKind>(['question', 'unblock']);
/** B.2 (chantier 15, D55) : un seul popup à la fois sur l'écran — « panneau » appartient à l'écran qui le rend (Sujet, puis Accueil). */
type Overlay = 'aucun' | 'nav' | 'panneau';
export const LayoutCtx = createContext<{
  openNewTopic: (workspaceId?: string) => void;
  openNewWorkspace: () => void;
  /** chantier 28 (D141) : « Ajouter un projet… » de l'écran Nouveau sujet, qui y revient */
  addWorkspaceThenTopic?: () => void;
  overlay: Overlay;
  setOverlay: (o: Overlay) => void;
  /** chantier 25 (D100) */
  meshBascule?: MeshBascule;
} | null>(null);

export function useLayout() {
  const c = useContext(LayoutCtx);
  if (!c) throw new Error('useLayout doit être appelé sous <Layout>');
  return c;
}

export function Layout({ screen, children }: { screen: EcranId; children: ReactNode }) {
  const { daemon, state } = useAid();
  const navigate = useNavigate();
  const location = useLocation();
  const [dialog, setDialog] = useState<Dialog>('none');
  const [palette, setPalette] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>('aucun');
  const boutonNavRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // comme Sujet.tsx : un volet resté ouvert en repassant ≥ 1280 px (où il devient une colonne) se referme.
    const mq = window.matchMedia?.('(min-width: 1280px)');
    const fermerSiLarge = () => mq?.matches && setOverlay('aucun');
    fermerSiLarge();
    mq?.addEventListener('change', fermerSiLarge);
    return () => mq?.removeEventListener('change', fermerSiLarge);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPaletteShortcut(e)) return;
      e.preventDefault();
      setPalette(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Un projet existe sans sujet : l'enregistrer ne force pas la création d'un sujet. Seul « Nouveau sujet » sans aucun
  // projet enchaîne les deux (ou « Ajouter un projet… » depuis l'écran Nouveau sujet, qui y revient).
  const [thenTopic, setThenTopic] = useState(false);
  // chantier 28 (D141) : Nouveau sujet est un écran, le projet présélectionné passe par l'URL
  const openNewTopic = (workspaceId?: string) => {
    if (state && state.workspaces.length === 0) {
      setThenTopic(true);
      setDialog('workspace');
    } else
      navigate(`/sujets/nouveau${workspaceId ? `?projet=${encodeURIComponent(workspaceId)}` : ''}`);
  };
  const openNewWorkspace = () => {
    setThenTopic(false);
    setDialog('workspace');
  };
  const addWorkspaceThenTopic = () => {
    setThenTopic(true);
    setDialog('workspace');
  };
  // sans `?projet`, l'écran prend le dernier projet enregistré : celui qu'on vient d'ajouter
  const projetEnregistre = () => {
    setDialog('none');
    if (thenTopic)
      navigate('/sujets/nouveau', { replace: location.pathname === '/sujets/nouveau' });
  };
  // chantier 28 (D140) : la même définition que la section Décisions de la Boîte
  const waiting = state ? decisionsEnAttente(state) : 0;
  // Pastille mesh (12.5) : la bascule vit dans useMeshBascule (D100), partagée avec Réglages par le contexte.
  const meshBascule = useMeshBascule();
  // D101 : l'âge du board, lu par les écrans du board eux-mêmes
  const boardLuA = useBoardLuA();
  const { mesh, enCours } = meshBascule;
  const barreMesh = mesh
    ? {
        state: mesh.state,
        aTraiter: mesh.inbox.filter((d) => !d.seenAt && A_TRAITER.has(d.kind)).length,
        tailscaleManage: mesh.tailscaleManage,
        enCours,
        checkedAt: meshBascule.checkedAt,
      }
    : null;
  const names = new Map(state?.workspaces.map((w) => [w.id, w.name]));
  const items: PaletteItem[] = [
    ...(state?.topics ?? []).map((t) => ({
      id: `sujet-${t.id}`,
      label: t.title,
      hint: `${names.get(t.workspaceId) ?? ''} · ${t.branch}`,
      run: () => navigate(`/sujets/${t.id}`),
    })),
    { id: 'nouveau-sujet', label: 'Nouveau sujet', run: () => openNewTopic() },
    { id: 'ajouter-projet', label: 'Ajouter un projet', run: openNewWorkspace },
    { id: 'ecran-accueil', label: 'Accueil', hint: 'écran', run: () => navigate('/') },
    {
      id: 'ecran-boite',
      label: 'Boîte de réception',
      hint: 'écran',
      run: () => navigate('/boite'),
    },
    { id: 'ecran-consignes', label: 'Consignes', hint: 'écran', run: () => navigate('/consignes') },
    { id: 'ecran-machines', label: 'Machines', hint: 'écran', run: () => navigate('/machines') },
    { id: 'ecran-serveurs', label: 'Serveurs', hint: 'écran', run: () => navigate('/serveurs') },
    { id: 'ecran-reglages', label: 'Réglages', hint: 'écran', run: () => navigate('/reglages') },
  ];
  return (
    <LayoutCtx.Provider
      value={{
        openNewTopic,
        openNewWorkspace,
        addWorkspaceThenTopic,
        overlay,
        setOverlay,
        meshBascule,
      }}
    >
      <Shell>
        <Barre
          screen={screen}
          daemon={daemon}
          waiting={waiting}
          onNewTopic={() => openNewTopic()}
          onPalette={() => setPalette(true)}
          mesh={barreMesh}
          boardLuA={screen === 'board' ? boardLuA : null}
          sansSwarph={!!state && !state.mesh}
        />
        <div
          className={`corps-ecran${screen === '1-3' ? ' corps-ecran--sujet' : ''}`}
          data-node={`${screen}.corps`}
        >
          <button
            ref={boutonNavRef}
            className="bouton-icone bouton-volant bouton-volant--nav"
            data-node={`${screen}.volet.ouvrir-nav`}
            type="button"
            aria-label="Ouvrir la navigation"
            aria-expanded={overlay === 'nav'}
            inert={overlay !== 'aucun' || undefined}
            onClick={() => setOverlay(overlay === 'nav' ? 'aucun' : 'nav')}
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16">
              <path
                d="M2 4h12M2 8h12M2 12h12"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <Volet
            screen={screen}
            nom="nav"
            titre="Navigation"
            ouvert={overlay === 'nav'}
            inert={overlay !== 'aucun' && overlay !== 'nav'}
            onFermer={() => setOverlay('aucun')}
            boutonRef={boutonNavRef}
          >
            <Nav screen={screen} />
          </Volet>
          <div style={{ display: 'contents' }} inert={overlay === 'nav' || undefined}>
            {children}
          </div>
          {overlay === 'nav' && (
            <div
              className="voile"
              data-node={`${screen}.volet.nav.fond`}
              aria-hidden="true"
              onClick={() => setOverlay('aucun')}
            />
          )}
        </div>
        {palette && <Palette items={items} onClose={() => setPalette(false)} />}
        {dialog === 'workspace' && (
          <NouveauWorkspace onClose={() => setDialog('none')} onDone={projetEnregistre} />
        )}
      </Shell>
    </LayoutCtx.Provider>
  );
}

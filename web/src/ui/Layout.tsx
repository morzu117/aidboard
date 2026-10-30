import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { MeshDmKind } from '../../../src/shared/model.js';
import { useAid } from '../data/useAidState.js';
import { NouveauSujet } from '../dialogues/NouveauSujet.js';
import { NouveauWorkspace } from '../dialogues/NouveauWorkspace.js';
import { Barre, type EcranId } from './Barre.js';
import { Nav } from './Nav.js';
import { isPaletteShortcut, Palette, type PaletteItem } from './Palette.js';
import { Shell } from './Shell.js';
import { Volet } from './Volet.js';

type Dialog = 'none' | 'workspace' | 'sujet';
/** les kinds de DM qui demandent quelque chose (12.5) : partagé avec la Boîte et le Notifieur */
export const A_TRAITER = new Set<MeshDmKind>(['question', 'unblock']);
/** B.2 (chantier 15, D55) : un seul popup à la fois sur l'écran — « panneau » appartient à l'écran qui le rend (Sujet, puis Accueil). */
type Overlay = 'aucun' | 'nav' | 'panneau';
export const LayoutCtx = createContext<{
  openNewTopic: (workspaceId?: string) => void;
  openNewWorkspace: () => void;
  overlay: Overlay;
  setOverlay: (o: Overlay) => void;
} | null>(null);

export function useLayout() {
  const c = useContext(LayoutCtx);
  if (!c) throw new Error('useLayout doit être appelé sous <Layout>');
  return c;
}

export function Layout({ screen, children }: { screen: EcranId; children: ReactNode }) {
  const { daemon, state, call } = useAid();
  const navigate = useNavigate();
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
  // projet enchaîne les deux (ou « Ajouter un projet… » depuis le dialogue de sujet, qui y revient).
  const [thenTopic, setThenTopic] = useState(false);
  const [preselected, setPreselected] = useState<string | undefined>();
  const openNewTopic = (workspaceId?: string) => {
    setPreselected(workspaceId);
    if (state && state.workspaces.length === 0) {
      setThenTopic(true);
      setDialog('workspace');
    } else setDialog('sujet');
  };
  const openNewWorkspace = () => {
    setThenTopic(false);
    setDialog('workspace');
  };
  const waiting = state?.agents.filter((a) => a.status === 'needs_input').length ?? 0;
  // Pastille mesh (12.5) : connect/disconnect répondent 202, le résultat arrive par `mesh.state`. En attendant,
  // « connexion… » ; si rien n'arrive (échec silencieux), la pastille se relâche au bout de 30 s.
  const mesh = state?.mesh;
  const [cible, setCible] = useState<{ vers: boolean } | null>(null);
  const enCours = cible !== null && mesh?.state.connected !== cible.vers;
  useEffect(() => {
    if (cible === null) return;
    const t = setTimeout(() => setCible(null), 30_000);
    return () => clearTimeout(t);
  }, [cible]);
  const basculerMesh = async () => {
    if (!mesh) return;
    const vers = !mesh.state.connected;
    setCible({ vers });
    try {
      await call('POST', vers ? '/api/mesh/connect' : '/api/mesh/disconnect');
    } catch {
      setCible(null);
    }
  };
  const barreMesh = mesh
    ? {
        state: mesh.state,
        aTraiter: mesh.inbox.filter((d) => !d.seenAt && A_TRAITER.has(d.kind)).length,
        tailscaleManage: mesh.tailscaleManage,
        enCours,
        onToggle: () => void basculerMesh(),
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
    { id: 'ecran-serveurs', label: 'Serveurs', hint: 'écran', run: () => navigate('/serveurs') },
    { id: 'ecran-reglages', label: 'Réglages', hint: 'écran', run: () => navigate('/reglages') },
  ];
  return (
    <LayoutCtx.Provider value={{ openNewTopic, openNewWorkspace, overlay, setOverlay }}>
      <Shell>
        <Barre
          screen={screen}
          daemon={daemon}
          waiting={waiting}
          onNewTopic={() => openNewTopic()}
          onPalette={() => setPalette(true)}
          mesh={barreMesh}
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
          <NouveauWorkspace
            onClose={() => setDialog('none')}
            onDone={() => setDialog(thenTopic ? 'sujet' : 'none')}
          />
        )}
        {dialog === 'sujet' && (
          <NouveauSujet
            initialWorkspaceId={preselected}
            onClose={() => setDialog('none')}
            onAddWorkspace={() => {
              setPreselected(undefined);
              setThenTopic(true);
              setDialog('workspace');
            }}
          />
        )}
      </Shell>
    </LayoutCtx.Provider>
  );
}

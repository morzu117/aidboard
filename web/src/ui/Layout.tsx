import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useAid } from '../data/useAidState.js';
import { NouveauSujet } from '../dialogues/NouveauSujet.js';
import { NouveauWorkspace } from '../dialogues/NouveauWorkspace.js';
import { Barre, type EcranId } from './Barre.js';
import { isPaletteShortcut, Palette, type PaletteItem } from './Palette.js';
import { Shell } from './Shell.js';

type Dialog = 'none' | 'workspace' | 'sujet';
const LayoutCtx = createContext<{
  openNewTopic: (workspaceId?: string) => void;
  openNewWorkspace: () => void;
} | null>(null);

export function useLayout() {
  const c = useContext(LayoutCtx);
  if (!c) throw new Error('useLayout doit être appelé sous <Layout>');
  return c;
}

export function Layout({ screen, children }: { screen: EcranId; children: ReactNode }) {
  const { daemon, state } = useAid();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<Dialog>('none');
  const [palette, setPalette] = useState(false);
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
    { id: 'ecran-reglages', label: 'Réglages', hint: 'écran', run: () => navigate('/reglages') },
  ];
  return (
    <LayoutCtx.Provider value={{ openNewTopic, openNewWorkspace }}>
      <Shell>
        <Barre
          screen={screen}
          daemon={daemon}
          waiting={waiting}
          onNewTopic={() => openNewTopic()}
          onPalette={() => setPalette(true)}
        />
        {children}
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

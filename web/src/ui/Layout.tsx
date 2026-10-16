import { createContext, type ReactNode, useContext, useState } from 'react';
import { useAid } from '../data/useAidState.js';
import { NouveauSujet } from '../dialogues/NouveauSujet.js';
import { NouveauWorkspace } from '../dialogues/NouveauWorkspace.js';
import { Barre } from './Barre.js';
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

export function Layout({ screen, children }: { screen: '1-1' | '1-3'; children: ReactNode }) {
  const { daemon, state } = useAid();
  const [dialog, setDialog] = useState<Dialog>('none');
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
  return (
    <LayoutCtx.Provider value={{ openNewTopic, openNewWorkspace }}>
      <Shell>
        <Barre screen={screen} daemon={daemon} onNewTopic={() => openNewTopic()} />
        {children}
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

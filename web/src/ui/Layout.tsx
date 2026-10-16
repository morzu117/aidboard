import { createContext, type ReactNode, useContext, useState } from 'react';
import { useAid } from '../data/useAidState.js';
import { NouveauSujet } from '../dialogues/NouveauSujet.js';
import { NouveauWorkspace } from '../dialogues/NouveauWorkspace.js';
import { Barre } from './Barre.js';
import { Shell } from './Shell.js';

type Dialog = 'none' | 'workspace' | 'sujet';
const LayoutCtx = createContext<{ openNewTopic: () => void; openNewWorkspace: () => void } | null>(
  null,
);

export function useLayout() {
  const c = useContext(LayoutCtx);
  if (!c) throw new Error('useLayout doit être appelé sous <Layout>');
  return c;
}

export function Layout({ screen, children }: { screen: '1-1' | '1-3'; children: ReactNode }) {
  const { daemon, state } = useAid();
  const [dialog, setDialog] = useState<Dialog>('none');
  // sans workspace, « Nouveau sujet » commence par enregistrer un dépôt
  const openNewTopic = () =>
    setDialog(state && state.workspaces.length === 0 ? 'workspace' : 'sujet');
  return (
    <LayoutCtx.Provider value={{ openNewTopic, openNewWorkspace: () => setDialog('workspace') }}>
      <Shell>
        <Barre screen={screen} daemon={daemon} onNewTopic={openNewTopic} />
        {children}
        {dialog === 'workspace' && (
          <NouveauWorkspace onClose={() => setDialog('none')} onDone={() => setDialog('sujet')} />
        )}
        {dialog === 'sujet' && <NouveauSujet onClose={() => setDialog('none')} />}
      </Shell>
    </LayoutCtx.Provider>
  );
}

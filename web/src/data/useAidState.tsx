import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import { AidClient, type ClientSnapshot } from './client.js';

const Ctx = createContext<AidClient | null>(null);

export function AidProvider({ client, children }: { client?: AidClient; children: ReactNode }) {
  const c = useMemo(() => client ?? new AidClient(), [client]);
  useEffect(() => {
    c.start();
    return () => c.stop();
  }, [c]);
  return <Ctx.Provider value={c}>{children}</Ctx.Provider>;
}

export interface AidApi {
  retry: () => void;
  refresh: () => Promise<void>;
  call: <T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) => Promise<T>;
}

export function useAid(): ClientSnapshot & AidApi {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAid doit être appelé sous <AidProvider>');
  const snap = useSyncExternalStore(c.subscribe, c.getSnapshot);
  return {
    ...snap,
    retry: () => c.retry(),
    refresh: () => c.refresh(),
    call: (m, p, b) => c.request(m, p, b),
  };
}

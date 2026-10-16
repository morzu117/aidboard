import type { ReactNode } from 'react';
import { useViewport } from './useViewport.js';

export function Shell({ children }: { children: ReactNode }) {
  const viewport = useViewport();
  return (
    <div className="cadre" data-viewport={viewport}>
      {children}
    </div>
  );
}

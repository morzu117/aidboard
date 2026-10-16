import { useEffect, useState } from 'react';

export type Viewport = 'phone' | 'tablet' | 'desktop' | 'wide';

// Seuils : on réutilise les règles [data-viewport] des maquettes plutôt que de les réécrire en media queries.
export function viewportFor(width: number): Viewport {
  if (width < 640) return 'phone';
  if (width < 1180) return 'tablet';
  if (width < 1720) return 'desktop';
  return 'wide';
}

export function useViewport(): Viewport {
  const [viewport, setViewport] = useState(() => viewportFor(window.innerWidth));
  useEffect(() => {
    const onResize = () => setViewport(viewportFor(window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return viewport;
}

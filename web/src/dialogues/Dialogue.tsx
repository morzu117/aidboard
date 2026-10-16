import { type ReactNode, useEffect } from 'react';

export function Dialogue({
  titre,
  onClose,
  children,
}: {
  titre: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="voile" data-layer="overlay">
      <div className="dialogue" role="dialog" aria-modal="true" aria-label={titre}>
        <h2>{titre}</h2>
        {children}
      </div>
    </div>
  );
}

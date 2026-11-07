import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

// Chantier 31 (D181) : le QR, rendu ici, en SVG, par qrcode-generator. Aucune requête vers un
// service de QR, aucun HTML injecté : les modules sombres deviennent un seul chemin SVG.

const MARGE = 4;

export function cheminQr(texte: string): { taille: number; d: string } {
  const qr = qrcode(0, 'M');
  qr.addData(texte, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const morceaux: string[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.isDark(y, x)) morceaux.push(`M${x + MARGE} ${y + MARGE}h1v1h-1z`);
    }
  }
  return { taille: n + 2 * MARGE, d: morceaux.join('') };
}

export function Qr({ texte, titre }: { texte: string; titre: string }) {
  const { taille, d } = useMemo(() => cheminQr(texte), [texte]);
  return (
    <svg
      className="qr"
      data-node="host.qr"
      role="img"
      aria-label={titre}
      viewBox={`0 0 ${taille} ${taille}`}
      shapeRendering="crispEdges"
    >
      <rect width={taille} height={taille} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

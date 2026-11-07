import type { AccesFini } from '../data/client.js';

// Chantier 31 (D177, D180) : l'écran plein d'un appareil sans accès. Aucun lien vers le Mac :
// on ne revient que par un nouveau QR, affiché sur le Mac.

export type FinAcces = AccesFini | 'deconnecte';

export const TEXTES_FIN: Record<FinAcces, { titre: string; phrase: string }> = {
  expire: { titre: 'Accès expiré', phrase: 'Accès expiré. Nouveau QR requis pour revenir.' },
  revoque: { titre: 'Accès coupé', phrase: 'Accès coupé. Nouveau QR requis pour revenir.' },
  deconnecte: {
    titre: 'Appareil déconnecté',
    phrase: 'Appareil déconnecté. Nouveau QR requis pour revenir.',
  },
  inconnu: {
    titre: 'Pas d’accès',
    phrase:
      'Cet appareil n’a pas accès à ce cockpit. Sur le Mac, ouvre Machines › Ton cockpit, puis Ajouter un appareil, et scanne le QR.',
  },
};

export function HorsAcces({ fin }: { fin: FinAcces }) {
  const t = TEXTES_FIN[fin];
  return (
    <main className="appareil-plein" data-node="appareil.hors-acces" data-fin={fin}>
      <h1 className="titre-ecran">{t.titre}</h1>
      <p data-node="appareil.hors-acces.phrase">{t.phrase}</p>
    </main>
  );
}

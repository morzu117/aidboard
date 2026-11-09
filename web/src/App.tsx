import { Navigate, Route, Routes } from 'react-router';
import { AidProvider } from './data/useAidState.js';
import { Accueil } from './ecrans/Accueil.js';
import { Board } from './ecrans/Board.js';
import { CarteBoard } from './ecrans/CarteBoard.js';
import { Boite } from './ecrans/Boite.js';
import { Consignes } from './ecrans/Consignes.js';
import { Discussion, OuvrirDiscussion } from './ecrans/Discussion.js';
import { Livraison } from './ecrans/Livraison.js';
import { Machines } from './ecrans/Machines.js';
import { NouveauSujet } from './ecrans/NouveauSujet.js';
import { Reglages } from './ecrans/Reglages.js';
import { ServeurConfig } from './ecrans/ServeurConfig.js';
import { Serveurs } from './ecrans/Serveurs.js';
import { Sujet } from './ecrans/Sujet.js';
import { Swarph } from './ecrans/Swarph.js';
import { EcranSwarphProvisoire, ONGLETS_SWARPH } from './ui/OngletsSwarph.js';
import { Notifieur } from './ui/Notifieur.js';

export function App() {
  return (
    <AidProvider>
      <Notifieur />
      <Routes>
        <Route path="/" element={<Accueil />} />
        <Route path="/boite" element={<Boite />} />
        <Route path="/consignes" element={<Consignes />} />
        <Route path="/reglages" element={<Reglages />} />
        {/* chantier 25 (D102) */}
        <Route path="/swarph" element={<Swarph />} />
        {ONGLETS_SWARPH.slice(1).map(([id, chemin, titre]) => (
          <Route key={id} path={chemin} element={<EcranSwarphProvisoire titre={titre} />} />
        ))}
        <Route path="/board" element={<Board />} />
        <Route path="/board/cartes/:cardId" element={<CarteBoard />} />
        {/* chantier 29 (D151) */}
        <Route path="/machines" element={<Machines />} />
        <Route path="/serveurs" element={<Serveurs />} />
        <Route path="/serveurs/nouveau" element={<ServeurConfig />} />
        <Route path="/serveurs/:id/configuration" element={<ServeurConfig />} />
        <Route path="/serveurs/:id/discussion" element={<OuvrirDiscussion />} />
        <Route path="/serveurs/:id/discussions/:discussionId" element={<Discussion />} />
        {/* chantier 28 (D141) : avant /sujets/:topicId, qui prendrait « nouveau » pour un id */}
        <Route path="/sujets/nouveau" element={<NouveauSujet />} />
        <Route path="/sujets/:topicId" element={<Sujet />} />
        {/* chantier 27 (D121) */}
        <Route path="/sujets/:topicId/livraison" element={<Livraison />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AidProvider>
  );
}

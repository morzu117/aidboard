import { Navigate, Route, Routes } from 'react-router';
import { AidProvider } from './data/useAidState.js';
import { Accueil } from './ecrans/Accueil.js';
import { Boite } from './ecrans/Boite.js';
import { Consignes } from './ecrans/Consignes.js';
import { Reglages } from './ecrans/Reglages.js';
import { Sujet } from './ecrans/Sujet.js';
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
        <Route path="/sujets/:topicId" element={<Sujet />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AidProvider>
  );
}

import { Navigate, Route, Routes } from 'react-router';
import { AidProvider } from './data/useAidState.js';
import { Accueil } from './ecrans/Accueil.js';
import { Sujet } from './ecrans/Sujet.js';

export function App() {
  return (
    <AidProvider>
      <Routes>
        <Route path="/" element={<Accueil />} />
        <Route path="/sujets/:topicId" element={<Sujet />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AidProvider>
  );
}

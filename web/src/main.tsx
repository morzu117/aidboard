import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App.js';
import './styles/maquette.css';
import './styles/app.css';

// Coquille hors-ligne : permet à l'app de s'afficher (bandeau + CTA « Démarrer le daemon »)
// même quand le daemon est totalement injoignable — sinon c'est lui qui sert ce fichier.
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js');

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);

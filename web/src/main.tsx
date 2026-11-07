import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App.js';
import { AppAppareil } from './AppAppareil.js';
import { detecterMode } from './data/appareil.js';
import './styles/maquette.css';
import './styles/app.css';
import './styles/coque.css';
import './styles/sujet.css';
import './styles/livraison.css';
import './styles/artefacts.css';
import './styles/boite.css';
import './styles/nouveau-sujet.css';
import './styles/reprendre.css';
import './styles/machines.css';
import './styles/host.css';
import './styles/appareil.css';

// Coquille hors-ligne : permet à l'app de s'afficher (bandeau + CTA « Démarrer le daemon »)
// même quand le daemon est totalement injoignable — sinon c'est lui qui sert ce fichier.
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js');

// chantier 31 (D180) : le port des appareils répond à /api/appareils/moi ; le Mac, non
void detecterMode().then((mode) =>
  createRoot(document.getElementById('root')!).render(
    <BrowserRouter>{mode.kind === 'mac' ? <App /> : <AppAppareil mode={mode} />}</BrowserRouter>,
  ),
);

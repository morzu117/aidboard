import { useState } from 'react';

const CLE = 'aid.installation-fermee';

function proposer(): boolean {
  if (!/iPhone|iPad/.test(navigator.userAgent) || !/Safari/.test(navigator.userAgent)) return false;
  if (/CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent)) return false;
  if ((navigator as Navigator & { standalone?: boolean }).standalone === true) return false;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return false;
  try {
    return localStorage.getItem(CLE) !== 'oui';
  } catch {
    return true;
  }
}

export function RappelInstallation() {
  const [visible, setVisible] = useState(proposer);
  if (!visible) return null;
  return (
    <aside className="appareil-bandeau" aria-label="Installer A-I-D">
      <p>
        {
          "Pour les notifications et l'écran plein, ajoute A-I-D à l'écran d'accueil : Partager, puis Sur l'écran d'accueil."
        }
      </p>
      <button
        type="button"
        onClick={() => {
          try {
            localStorage.setItem(CLE, 'oui');
          } catch {
            // Le stockage peut être interdit.
          }
          setVisible(false);
        }}
      >
        Fermer le rappel
      </button>
    </aside>
  );
}

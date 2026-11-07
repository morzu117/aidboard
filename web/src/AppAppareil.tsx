import { useEffect, useMemo, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation, useParams } from 'react-router';
import { AidClient, type AccesFini } from './data/client.js';
import { SessionExpired } from './data/api.js';
import type { Moi, ModeInterface } from './data/appareil.js';
import { AidProvider, useAid, useAidClient } from './data/useAidState.js';
import { AccueilAppareil } from './ecrans/AccueilAppareil.js';
import { AppareilsConnectes } from './ecrans/AppareilsConnectes.js';
import { Appairer } from './ecrans/Appairer.js';
import { Contenu as BoardContenu } from './ecrans/Board.js';
import { Contenu as CarteContenu } from './ecrans/CarteBoard.js';
import { HorsAcces } from './ui/HorsAcces.js';
import { RappelInstallation } from './ui/RappelInstallation.js';

// Chantier 31 (D180) : l'interface sur un appareil, servie par le port des appareils. Une barre
// réduite (Accueil, Board, Appareils connectés), aucun bouton d'écriture, et le flux de
// `/ws/signal`. Les écrans du Mac n'y sont pas montés : une adresse inconnue revient à l'accueil.

const heure = (iso: string) =>
  new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

function Barre({ moi, board }: { moi: Moi; board: boolean }) {
  const lien = ({ isActive }: { isActive: boolean }) =>
    `appareil-lien${isActive ? ' est-actif' : ''}`;
  return (
    <header className="appareil-barre" data-node="appareil.barre">
      <nav aria-label="Cockpit">
        <NavLink to="/" end className={lien} data-node="appareil.barre.accueil">
          Accueil
        </NavLink>
        {board && (
          <NavLink to="/board" className={lien} data-node="appareil.barre.board">
            Board
          </NavLink>
        )}
        <NavLink to="/appareils" className={lien} data-node="appareil.barre.appareils">
          Appareils connectés
        </NavLink>
      </nav>
      <span className="texte-discret" data-node="appareil.barre.moi">
        {moi.nom} · lecture seule, jusqu’à {heure(moi.expireA)}
      </span>
    </header>
  );
}

function Carte() {
  const id = Number(useParams().cardId);
  if (!Number.isInteger(id) || id <= 0) return <Navigate to="/board" replace />;
  return <CarteContenu key={id} cardId={id} />;
}

function Coque({ moi }: { moi: Moi | null }) {
  const { appareil, daemon, acces, horsLigne, dernierEtatLu } = useAid();
  const client = useAidClient();
  const [identite, setIdentite] = useState(moi);
  const [fin, setFin] = useState<AccesFini | null>(null);
  useEffect(() => {
    if (identite || daemon !== 'connecte') return;
    let actif = true;
    void client.request<Moi>('GET', '/api/appareils/moi').then(
      (lu) => {
        if (actif) setIdentite(lu);
      },
      (err: unknown) => {
        if (!actif || !(err instanceof SessionExpired)) return;
        try {
          localStorage.removeItem('aid.mode');
        } catch {
          // Le stockage peut être interdit.
        }
        client.stop();
        setFin(err.raison === 'expire' || err.raison === 'revoque' ? err.raison : 'inconnu');
      },
    );
    return () => {
      actif = false;
    };
  }, [client, daemon, identite]);
  if (acces || fin) return <HorsAcces fin={acces ?? fin!} />;
  if (horsLigne && appareil) {
    return (
      <div className="appareil-coque" data-node="appareil">
        <RappelInstallation />
        <div className="appareil-bandeau" role="status">
          <p>Mac injoignable</p>
          {dernierEtatLu && <p>Dernier état connu il y a {ageDernierEtat(dernierEtatLu)}</p>}
          <p>{"A-I-D n'a pas pu te prévenir de ce qui s'est passé depuis."}</p>
        </div>
        <AccueilAppareil />
      </div>
    );
  }
  const cell = appareil?.mesh?.state.cell ?? null;
  return (
    <div className="appareil-coque" data-node="appareil">
      <RappelInstallation />
      {identite && <Barre moi={identite} board={cell !== null} />}
      {(daemon === 'injoignable' || daemon === 'reconnexion') && (
        <p className="appareil-bandeau" role="status" data-node="appareil.bandeau">
          {daemon === 'injoignable' ? 'Mac injoignable. Nouvel essai…' : 'Reconnexion…'}
        </p>
      )}
      <Routes>
        <Route path="/" element={<AccueilAppareil />} />
        <Route
          path="/board"
          element={
            cell !== null ? (
              <BoardContenu cell={cell} />
            ) : appareil ? (
              <Navigate to="/" replace />
            ) : null
          }
        />
        <Route
          path="/board/cartes/:cardId"
          element={cell !== null ? <Carte /> : appareil ? <Navigate to="/" replace /> : null}
        />
        <Route path="/appareils" element={<AppareilsConnectes />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}

function ageDernierEtat(lu: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(lu)) / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`;
}

export function AppAppareil({
  mode,
  client,
}: {
  mode: Exclude<ModeInterface, { kind: 'mac' }>;
  client?: AidClient;
}) {
  const { pathname } = useLocation();
  const c = useMemo(() => client ?? new AidClient({ flux: 'signal' }), [client]);
  // la page de l'appairage n'a besoin d'aucun accès
  if (pathname === '/appairer') return <Appairer />;
  if (mode.kind === 'hors-acces') return <HorsAcces fin={mode.raison} />;
  return (
    <AidProvider client={c}>
      <Coque moi={mode.moi} />
    </AidProvider>
  );
}

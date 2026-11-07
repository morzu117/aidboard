import { useEffect, useState } from 'react';
import { AidApiError, api } from '../data/api.js';

// Chantier 31 (D176, D180) : la page /appairer, ouverte par le QR du Mac. Elle lit le code dans le
// fragment (jamais envoyé au serveur par le navigateur), le retire de l'adresse, puis réclame sur
// un geste de l'utilisateur : un aperçu de lien qui ouvrirait la page ne réclame rien. Elle montre
// le code court à comparer sur le Mac, attend l'approbation, puis recharge.

export const NOM_MAX = 40;
export const ATTENTE_MS = 1000;

export function nomParDefaut(ua: string): string {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  return 'Appareil';
}

type Etape =
  | { kind: 'saisie' }
  | { kind: 'envoi' }
  | { kind: 'attente'; demandeId: string; codeCourt: string }
  | { kind: 'approuve' }
  | { kind: 'erreur'; texte: string };

const RECHARGER = () => window.location.replace('/');
const INCONNU = 'Code inconnu, expiré ou déjà utilisé. Demande un nouveau code sur le Mac.';

export function Appairer({
  fetchImpl = fetch,
  recharger = RECHARGER,
}: {
  fetchImpl?: typeof fetch;
  recharger?: () => void;
}) {
  const [code] = useState(() => decodeURIComponent(window.location.hash.replace(/^#/, '')));
  const [nom, setNom] = useState(() => nomParDefaut(navigator.userAgent));
  const [etape, setEtape] = useState<Etape>({ kind: 'saisie' });

  // le code ne reste ni dans l'adresse ni dans l'historique
  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  const demandeId = etape.kind === 'attente' ? etape.demandeId : null;
  useEffect(() => {
    if (demandeId === null) return;
    const t = setInterval(() => {
      api<{ etat: 'attente' | 'approuve' | 'consomme' }>(
        'GET',
        `/appairage/${encodeURIComponent(demandeId)}`,
        undefined,
        fetchImpl,
      ).then(
        (r) => {
          if (r.etat === 'attente') return;
          setEtape({ kind: 'approuve' });
          recharger();
        },
        (err: unknown) => {
          // refusée, annulée ou expirée ; un échec réseau, lui, se réessaie au tour suivant
          if (err instanceof AidApiError && err.status === 404) {
            setEtape({
              kind: 'erreur',
              texte: 'Demande refusée, annulée ou expirée. Demande un nouveau code sur le Mac.',
            });
          }
        },
      );
    }, ATTENTE_MS);
    return () => clearInterval(t);
  }, [demandeId, fetchImpl, recharger]);

  const reclamer = () => {
    setEtape({ kind: 'envoi' });
    api<{ demandeId: string; codeCourt: string }>(
      'POST',
      '/appairage/reclamer',
      { code, nom },
      fetchImpl,
    ).then(
      (r) => setEtape({ kind: 'attente', demandeId: r.demandeId, codeCourt: r.codeCourt }),
      (err: unknown) =>
        setEtape({
          kind: 'erreur',
          texte:
            err instanceof AidApiError && err.status === 429
              ? 'Trop d’essais : réessaie dans une minute.'
              : err instanceof AidApiError && err.status === 404
                ? INCONNU
                : 'Le cockpit ne répond pas. Réessaie.',
        }),
    );
  };

  return (
    <main className="appareil-plein" data-node="appairer">
      <h1 className="titre-ecran">Ajouter ce téléphone</h1>
      <p>Connecter ce téléphone à ton cockpit</p>
      <p>
        Ce code vient du QR affiché dans Machines › Ajouter un appareil. Il sert une seule fois.
      </p>
      <p>Sur iPhone, l’app installée peut demander un nouvel appairage après Safari.</p>
      {code === '' ? (
        <p data-node="appairer.sans-code">
          Ouvre cette page depuis le QR affiché sur le Mac, dans Machines › Ton cockpit.
        </p>
      ) : etape.kind === 'saisie' || etape.kind === 'envoi' ? (
        <form
          className="appairer-form"
          onSubmit={(e) => {
            e.preventDefault();
            reclamer();
          }}
        >
          <label>
            Nom de cet appareil
            <input
              data-node="appairer.nom"
              value={nom}
              maxLength={NOM_MAX}
              onChange={(e) => setNom(e.target.value)}
            />
          </label>
          <button
            className="bouton bouton--primaire"
            type="submit"
            data-node="appairer.demander"
            disabled={etape.kind === 'envoi'}
          >
            Demander l’accès
          </button>
          <p className="texte-discret">Décider, relire, suivre · 8 heures, sans prolongation.</p>
        </form>
      ) : etape.kind === 'attente' ? (
        <div data-node="appairer.attente">
          <p>Vérifie que le Mac affiche le même code, puis approuve sur le Mac :</p>
          <p className="host-code-court" data-node="appairer.code-court">
            {etape.codeCourt}
          </p>
          <p className="texte-discret">En attente de l’approbation…</p>
        </div>
      ) : etape.kind === 'approuve' ? (
        <p data-node="appairer.approuve">Approuvé. Ouverture du cockpit…</p>
      ) : (
        <p className="message-erreur" role="alert" data-node="appairer.erreur">
          {etape.texte}
        </p>
      )}
    </main>
  );
}

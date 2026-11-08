import { useConfirmation } from './AttenteConfirmation.js';
import { useEffect, useState } from 'react';
import type { EtatModeHostDaemon } from '../../../src/shared/host.js';
import { useAidClient } from '../data/useAidState.js';

interface AppareilPda {
  id: string;
  nom: string;
  etat: 'attente' | 'actif' | 'revoque';
  empreinte: string;
  cree_a: string;
  active_a: string | null;
  revoque_a: string | null;
}

export function PanneauPda({ etat }: { etat: EtatModeHostDaemon['pda'] }) {
  const client = useAidClient();
  const [pda, setPda] = useState(etat);
  const [relais, setRelais] = useState(etat?.relais ?? '');
  const [appareils, setAppareils] = useState<AppareilPda[]>([]);
  const [cle, setCle] = useState('');
  const [sujet, setSujet] = useState('Essai');
  const [demande, setDemande] = useState<string | null>(null);
  const [resultat, setResultat] = useState('');
  const [erreur, setErreur] = useState('');
  const [activation, setActivation] = useState('');
  const confirmation = useConfirmation(async () => {
    setAppareils(await client.request<AppareilPda[]>('GET', '/api/host/pda/appareils'));
  }, true);
  const [occupe, setOccupe] = useState(false);
  useEffect(() => {
    let monte = true;
    void Promise.all([
      client.request<AppareilPda[]>('GET', '/api/host/pda/appareils'),
      client.request<{ clePublique: string }>('GET', '/api/host/pda/cle'),
    ])
      .then(([liste, publique]) => {
        if (monte) {
          setAppareils(liste);
          setCle(publique.clePublique);
        }
      })
      .catch((e: unknown) => {
        if (monte) setErreur(e instanceof Error ? e.message : String(e));
      });
    return () => {
      monte = false;
    };
  }, [client]);
  useEffect(() => {
    if (!demande) return;
    let monte = true;
    const timer = setInterval(() => {
      void client
        .request<{ etat: string }>('GET', `/api/host/pda/demandes/${demande}`)
        .then((r) => {
          if (!monte) return;
          const fin = { confirmee: 'Confirmée', refusee: 'Refusée', expiree: 'Expirée' }[r.etat];
          if (fin) {
            setResultat(fin);
            setDemande(null);
          }
        })
        .catch((e: unknown) => {
          if (monte) setErreur(e instanceof Error ? e.message : String(e));
        });
    }, 3000);
    return () => {
      monte = false;
      clearInterval(timer);
    };
  }, [client, demande]);
  async function agir(action: () => Promise<void>) {
    setOccupe(true);
    setErreur('');
    try {
      await action();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    } finally {
      setOccupe(false);
    }
  }
  async function appareil(id: string, action: string, empreinte?: string) {
    const r = await client.request('POST', `/api/host/pda/appareils/${id}/${action}`, {
      empreinte,
    });
    if (action === 'activer' && confirmation.recevoir(r)) {
      setActivation(id);
      return;
    }
    setAppareils(await client.request<AppareilPda[]>('GET', '/api/host/pda/appareils'));
  }
  return (
    <div>
      <label>
        <input
          type="checkbox"
          role="switch"
          checked={pda?.actif ?? false}
          disabled={occupe}
          onChange={() => {
            const actif = !pda?.actif;
            if (
              !window.confirm(
                actif
                  ? `Le Mac va contacter le relais ${relais}. Les confirmations passeront par lui ; il ne peut pas en forger.`
                  : 'Couper le PDA : confirmations hors du tailnet ?',
              )
            )
              return;
            void agir(async () => {
              setPda(await client.request('PUT', '/api/host/pda', { actif, relais }));
            });
          }}
        />
        PDA : confirmations hors du tailnet
      </label>
      <label>
        Adresse du relais
        <input
          type="url"
          placeholder="https://relais.example.com"
          value={relais}
          disabled={occupe || !!pda?.actif}
          onChange={(e) => setRelais(e.target.value)}
        />
      </label>
      <h3>Appareils PDA</h3>
      <ul className="machines-appareils">
        {appareils.map((a) => (
          <li key={a.id}>
            <span>{a.nom}</span>
            <span>{{ attente: 'en attente', actif: 'actif', revoque: 'révoqué' }[a.etat]}</span>
            <code className="host-code-court">{a.empreinte}</code>
            <span>Créé : {a.cree_a}</span>
            {a.active_a && <span>Activé : {a.active_a}</span>}
            {a.revoque_a && <span>Révoqué : {a.revoque_a}</span>}
            {a.id === activation && confirmation.id
              ? confirmation.attente
              : a.etat === 'attente' && (
                  <button
                    className="bouton"
                    disabled={occupe || (!!confirmation.id && !confirmation.terminee)}
                    onClick={() => {
                      if (
                        window.confirm(
                          `L'empreinte affichée sur le téléphone est-elle exactement ${a.empreinte} ?`,
                        )
                      )
                        void agir(() => appareil(a.id, 'activer', a.empreinte));
                    }}
                  >
                    Activer
                  </button>
                )}
            {a.etat !== 'revoque' && (
              <button
                className="bouton bouton--danger"
                disabled={occupe}
                onClick={() => {
                  if (window.confirm(`Révoquer l’appareil PDA ${a.nom} ?`))
                    void agir(() => appareil(a.id, 'revoquer'));
                }}
              >
                Révoquer
              </button>
            )}
          </li>
        ))}
      </ul>
      <h3>Clé publique du daemon</h3>
      {cle && (
        <>
          <code>{cle}</code>
          <button
            className="bouton"
            onClick={() => void agir(() => navigator.clipboard.writeText(cle))}
          >
            Copier
          </button>
          <p>
            <code>aid relais --cle-daemon {cle}</code>
          </p>
        </>
      )}
      <p>
        Après une rotation, le relais en cours refusera les requêtes signées par le daemon jusqu’à
        son redémarrage avec la nouvelle clé publique.
      </p>
      <button
        className="bouton bouton--danger"
        disabled={occupe}
        onClick={() => {
          if (
            window.confirm(
              'Les téléphones devront repasser par le tailnet pour reprendre la nouvelle clé, et le relais doit recevoir la nouvelle clé publique.',
            )
          )
            void agir(async () => {
              const r = await client.request<{ clePublique: string }>(
                'POST',
                '/api/host/pda/cle/tourner',
                {},
              );
              setCle(r.clePublique);
            });
        }}
      >
        Faire tourner la clé
      </button>
      <label>
        Sujet
        <input maxLength={80} value={sujet} onChange={(e) => setSujet(e.target.value)} />
      </label>
      <button
        className="bouton"
        disabled={occupe || demande !== null}
        onClick={() =>
          void agir(async () => {
            const r = await client.request<{ id: string }>('POST', '/api/host/pda/essai', {
              sujet,
            });
            setDemande(r.id);
            setResultat('Demande envoyée, en attente…');
          })
        }
      >
        Envoyer une demande d’essai
      </button>
      <p role="status">{resultat}</p>
      {erreur && (
        <p className="message-erreur" role="alert">
          {erreur}
        </p>
      )}
    </div>
  );
}

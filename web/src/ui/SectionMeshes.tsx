import { useEffect, useRef, useState } from 'react';
import type { DemandeRejoindre, EtatRejoindre } from '../../../src/daemon/mesh/rejoindre.js';
import { useMeshes } from '../data/meshes.js';
import { useAid, useAidClient } from '../data/useAidState.js';

// Source : swarph-cli, src/swarph_cli/commands/join.py, _QUESTIONS (brief 33.4 r1).
const questions = [
  'How will you handle routine AI-to-AI peer DMs, and stop at privilege boundaries?',
  'How will you keep your canonical name and flag a DM addressed to the wrong identity?',
  'How will you disclose mistakes and assumptions to the peers affected?',
  'What counts as a mesh secret, and how will you keep it out of mesh messages?',
];
const citer = (texte: string) => "'" + texte.replaceAll("'", "'\"'\"'") + "'";
type Inscription = EtatRejoindre & Partial<DemandeRejoindre> & { cheminJeton?: string };
const chemin = '/api/meshes/rejoindre';
const messageErreur = (erreur: unknown) =>
  erreur instanceof Error ? erreur.message : 'Erreur de communication';

function Copier({ texte, nom }: { texte: string; nom: string }) {
  const [message, setMessage] = useState('');
  return (
    <div>
      <pre>{texte}</pre>
      <button
        data-node="machines.meshes.copier-nom"
        type="button"
        className="bouton"
        aria-label={`Copier ${nom}`}
        onClick={() => {
          void navigator.clipboard.writeText(texte).then(
            () => setMessage('Copié'),
            () => setMessage('Copie impossible'),
          );
        }}
      >
        Copier
      </button>
      <span role="status">{message}</span>
    </div>
  );
}

/** Montée uniquement dans Machines : la relecture s'arrête avec la section. */
export function SectionMeshes() {
  const { appareil } = useAid();
  return appareil ? null : <MeshesAdmin />;
}

function MeshesAdmin() {
  const client = useAidClient();
  const { meshes, erreur: erreurListe, relire } = useMeshes();
  const [inscription, setInscription] = useState<Inscription>({ etat: 'aucune' });
  const [formulaire, setFormulaire] = useState(false);
  const [gateway, setGateway] = useState('');
  const [cell, setCell] = useState('');
  const [mesh, setMesh] = useState('');
  const [erreur, setErreur] = useState('');
  const [message, setMessage] = useState('');
  const [occupe, setOccupe] = useState(false);
  const [maintenant, setMaintenant] = useState(Date.now);
  const attente = inscription.etat === 'demande' || inscription.etat === 'en-attente';

  const revision = useRef(0);
  useEffect(() => {
    let actif = true;
    const debut = revision.current;
    void client.request<Inscription>('GET', chemin).then(
      (etat) => {
        if (actif && debut === revision.current) {
          setMaintenant(Date.now());
          setInscription(etat);
        }
      },
      (e: unknown) => {
        if (actif && debut === revision.current) setErreur(messageErreur(e));
      },
    );
    return () => {
      actif = false;
    };
  }, [client]);

  useEffect(() => {
    if (!attente) return;
    let actif = true;
    let minuterie: ReturnType<typeof setTimeout>;
    const lire = async () => {
      const debut = revision.current;
      try {
        const etat = await client.request<Inscription>('GET', chemin);
        if (!actif) return;
        if (debut === revision.current) {
          setMaintenant(Date.now());
          setInscription(etat);
        }
        if (debut !== revision.current || etat.etat === 'demande' || etat.etat === 'en-attente')
          minuterie = setTimeout(() => void lire(), 2000);
      } catch (e) {
        if (actif) {
          setErreur(messageErreur(e));
          minuterie = setTimeout(() => void lire(), 2000);
        }
      }
    };
    minuterie = setTimeout(() => void lire(), 2000);
    return () => {
      actif = false;
      clearTimeout(minuterie);
    };
  }, [client, attente]);

  useEffect(() => {
    if (inscription.etat !== 'en-attente') return;
    const minuterie = setInterval(() => setMaintenant(Date.now()), 1000);
    return () => clearInterval(minuterie);
  }, [inscription.etat]);

  async function agir(action: () => Promise<void>) {
    setOccupe(true);
    setErreur('');
    try {
      await action();
    } catch (e) {
      setErreur(messageErreur(e));
    } finally {
      setOccupe(false);
    }
  }

  const adresse = inscription.gateway;
  const identite = inscription.cell;
  const code = 'code' in inscription ? inscription.code : undefined;
  const approbation =
    code && adresse ? `swarph mesh approve ${citer(code)} --gateway ${citer(adresse)}` : null;
  const secondes =
    inscription.etat === 'en-attente'
      ? Math.max(0, Math.ceil((inscription.expiration - maintenant) / 1000))
      : 0;

  return (
    <section className="machines-section" data-node="machines.meshes" aria-labelledby="mm-titre">
      <h2 id="mm-titre" className="titre-zone">
        Meshes
      </h2>
      {erreurListe && <p role="alert">{erreurListe}</p>}
      <ul>
        {meshes.map((m) => (
          <li key={m.nom}>
            <span>
              {m.nom} · {m.cell} · {m.gateway} · {m.jeton ? 'jeton présent' : 'jeton absent'}
            </span>
            {m.nom !== 'principal' && (
              <button
                data-node={`machines.meshes.oublier-${m.nom}`}
                type="button"
                className="bouton"
                disabled={occupe}
                onClick={() =>
                  void agir(async () => {
                    const resultat = await client.request<{ message: string }>(
                      'DELETE',
                      `/api/meshes/config/${encodeURIComponent(m.nom)}`,
                    );
                    setMessage(resultat.message);
                    await relire();
                  })
                }
              >
                Oublier
              </button>
            )}
          </li>
        ))}
      </ul>
      {message && <p role="status">{message}</p>}
      {erreur && (
        <p role="alert" className="message-erreur">
          {erreur}
        </p>
      )}
      {!attente && inscription.etat !== 'a-voir' && (
        <button
          data-node="machines.meshes.rejoindre-un-mesh"
          type="button"
          className="bouton"
          onClick={() => setFormulaire(true)}
        >
          Rejoindre un mesh
        </button>
      )}
      {formulaire && !attente && inscription.etat !== 'a-voir' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void agir(async () => {
              revision.current++;
              const resultat = await client.request<Inscription>('POST', chemin, {
                gateway,
                cell,
                mesh,
              });
              setMaintenant(Date.now());
              setInscription(resultat);
              setFormulaire(false);
            });
          }}
        >
          <label>
            Adresse du gateway
            <input
              data-node="machines.meshes.adresse-du-gateway"
              required
              value={gateway}
              onChange={(e) => setGateway(e.target.value)}
            />
          </label>
          <label>
            Nom de la nouvelle cell
            <input
              data-node="machines.meshes.nom-de-la-nouvelle-cell"
              required
              value={cell}
              onChange={(e) => setCell(e.target.value)}
            />
          </label>
          <label>
            Nom local du mesh
            <input
              data-node="machines.meshes.nom-local-du-mesh"
              required
              value={mesh}
              onChange={(e) => setMesh(e.target.value)}
            />
          </label>
          <button
            data-node="machines.meshes.rejoindre"
            className="bouton"
            type="submit"
            disabled={occupe}
          >
            Rejoindre
          </button>
        </form>
      )}
      {adresse && <p>Gateway : {adresse}</p>}
      {(inscription.etat === 'interrompue' || inscription.etat === 'a-voir') && (
        <p>
          Cell : {inscription.cell} · Mesh : {inscription.mesh}
          {inscription.cheminJeton && <> · Jeton : {inscription.cheminJeton}</>}
        </p>
      )}
      {inscription.etat === 'interrompue' && (
        <p>Le daemon a redémarré pendant la demande ; rien n&apos;a été inscrit.</p>
      )}
      {inscription.etat === 'demande' && <p>Demande en cours…</p>}
      {inscription.etat === 'en-attente' && (
        <div>
          <p style={{ fontSize: '2rem' }}>{inscription.code}</p>
          <p>
            Expiration dans {Math.floor(secondes / 60)}:{String(secondes % 60).padStart(2, '0')}
          </p>
          {approbation && (
            <Copier
              nom="la commande d’approbation"
              texte={`${approbation} --witness <TÉMOIN> --token-file <JETON-OPÉRATEUR>`}
            />
          )}
          <button
            data-node="machines.meshes.annuler"
            type="button"
            className="bouton"
            disabled={occupe}
            onClick={() =>
              void agir(async () => {
                revision.current++;
                setInscription(await client.request<Inscription>('DELETE', chemin));
              })
            }
          >
            Annuler
          </button>
        </div>
      )}
      {inscription.etat === 'annule' && (
        <div>
          <p>Demande annulée : demande à l&apos;opérateur de refuser le code {code}</p>
          {approbation && (
            <Copier
              nom="la commande de refus"
              texte={`${approbation} --refuse --token-file <JETON-OPÉRATEUR>`}
            />
          )}
        </div>
      )}
      {inscription.etat === 'approuve' && (
        <div>
          <p>
            Cell inscrite, pas encore ratifiée : la boîte marche, le board reste vide jusqu&apos;à
            la ratification
          </p>
          <ol>
            {questions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ol>
          {identite && (
            <Copier
              nom="le modèle de réponses"
              texte={`Handshake for ${identite}\n${questions.map((question) => `${question}\n<ta réponse, avec tes propres mots>`).join('\n')}`}
            />
          )}
          {identite && adresse && (
            <Copier
              nom="la commande d’envoi"
              texte={`swarph mesh send ${inscription.temoin ? citer(inscription.temoin) : '<TÉMOIN>'} --kind status --content-file <réponses> --as ${citer(identite)} --gateway ${citer(adresse)} --token-file ${inscription.cheminJeton ? citer(inscription.cheminJeton) : '<chemin du jeton>'}`}
            />
          )}
          <p>{inscription.libelle ?? 'Redémarre le daemon pour activer ce mesh.'}</p>
        </div>
      )}
      {inscription.etat === 'a-voir' && (
        <p>Le jeton a peut-être été retiré : vois avec l&apos;opérateur du gateway.</p>
      )}
      {inscription.etat === 'refuse' && <p>Demande refusée par l’opérateur du gateway.</p>}
      {inscription.etat === 'expire' && <p>La demande a expiré.</p>}
      {inscription.etat === 'echec' && <p>Échec : {inscription.libelle}</p>}
    </section>
  );
}

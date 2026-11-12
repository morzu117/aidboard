import { ParametresSignes } from './ui/ParametresSignes.js';
import { useCallback, useEffect, useState } from 'react';
import { empreintePda, encoderBase64url } from '../../src/shared/pda.js';
import {
  chargerCodePda,
  fabriquerReponse,
  lireDemandes,
  requeteRelais,
  stockagePda,
  type CodePda,
  type DemandePda,
  type PdaLocal,
} from './data/pda.js';
import { HorsAcces, type FinAcces } from './ui/HorsAcces.js';

export function AppPda() {
  const [code, setCode] = useState<CodePda | null>(null);
  const [appareil, setAppareil] = useState<PdaLocal | null>(null);
  const [pret, setPret] = useState(false);
  const [message, setMessage] = useState('');
  const [demandes, setDemandes] = useState<DemandePda[]>([]);
  const [illisibles, setIllisibles] = useState(0);
  const [occupe, setOccupe] = useState(false);
  const [nom, setNom] = useState('');
  const [empreinte, setEmpreinte] = useState('');
  const [fin, setFin] = useState<FinAcces | null>(null);
  const enregistrement = location.pathname === '/pda/enregistrer';
  const erreur = (e: unknown) =>
    setMessage(
      (e instanceof Error || e instanceof DOMException) && e.name === 'NotAllowedError'
        ? 'Passkey annulée'
        : e instanceof Error && e.name === 'Error'
          ? e.message
          : 'Relais injoignable',
    );
  useEffect(() => {
    void Promise.all([chargerCodePda(), stockagePda()])
      .then(([c, a]) => {
        setCode(c);
        setAppareil(a);
        setPret(true);
      })
      .catch(() => setMessage('PDA indisponible. Repasse par le tailnet.'));
  }, []);
  const rafraichir = useCallback(async () => {
    if (!appareil || !code?.RELAIS || enregistrement) return;
    setOccupe(true);
    try {
      const resultat = await lireDemandes(
        await requeteRelais(code.RELAIS, appareil, '/demandes'),
        code.CLE_DAEMON,
      );
      setDemandes(resultat.demandes);
      setIllisibles(resultat.illisibles);
      setMessage('');
    } catch (e) {
      setDemandes([]);
      erreur(e);
    } finally {
      setOccupe(false);
    }
  }, [appareil, code, enregistrement]);
  useEffect(() => {
    let actif = true;
    void Promise.resolve().then(() => {
      if (actif) return rafraichir();
    });
    const retour = () => {
      if (document.visibilityState === 'visible') void rafraichir();
    };
    document.addEventListener('visibilitychange', retour);
    return () => {
      actif = false;
      document.removeEventListener('visibilitychange', retour);
    };
  }, [rafraichir]);
  const enregistrer = async () => {
    setOccupe(true);
    setMessage('');
    try {
      const acces = await fetch('/api/appareils/moi', { cache: 'no-store' });
      if (acces.status === 401) {
        setFin('expire');
        return;
      }
      if (!acces.ok) throw new Error('Enregistrement indisponible. Rejoins le tailnet.');
      const credential = (await navigator.credentials.create({
        publicKey: {
          rp: { id: location.hostname, name: 'A-I-D' },
          user: { id: crypto.getRandomValues(new Uint8Array(16)), name: nom, displayName: nom },
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
          attestation: 'none',
        },
      })) as PublicKeyCredential | null;
      if (!credential) throw new DOMException('Annulée', 'NotAllowedError');
      const reponse = credential.response as AuthenticatorAttestationResponse;
      const publique = reponse.getPublicKey();
      if (!publique)
        throw new Error('Cette passkey ne fournit pas sa clé publique. Essaie une autre passkey.');
      if (reponse.getPublicKeyAlgorithm() !== -7)
        throw new Error('Cette passkey ne prend pas en charge ES256.');
      const paire = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
        'sign',
      ]);
      const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', paire.publicKey);
      const cles = {
        credId: encoderBase64url(new Uint8Array(credential.rawId)),
        passkey: encoderBase64url(new Uint8Array(publique)),
        relais: { kty: kty!, crv: crv!, x: x!, y: y! },
      };
      const resultat = await fetch('/api/appareils/moi/pda', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nom, ...cles, algorithme: -7 }),
      });
      if (resultat.status === 401) {
        setFin('expire');
        return;
      }
      if (!resultat.ok) throw new Error('Enregistrement refusé');
      const retour = await resultat.json();
      if (retour.empreinte !== (await empreintePda(cles)))
        throw new Error('Les empreintes diffèrent. Rien n’a été enregistré sur ce téléphone.');
      if (typeof retour.id !== 'string') throw new Error('Enregistrement refusé');
      await stockagePda({ id: retour.id, credId: cles.credId, cleRelais: paire.privateKey });
      setEmpreinte(retour.empreinte);
    } catch (e) {
      erreur(e);
    } finally {
      setOccupe(false);
    }
  };
  const repondre = async (entree: DemandePda, valeur: 'oui' | 'non', numero: string) => {
    if (!appareil || !code?.RELAIS) return;
    setOccupe(true);
    setMessage('');
    try {
      if (entree.demande.echeance <= Date.now()) {
        await rafraichir();
        return;
      }
      const corps = await fabriquerReponse(entree, appareil, valeur, numero);
      await requeteRelais(code.RELAIS, appareil, `/reponses/${entree.demande.id}`, corps);
      setDemandes((liste) => liste.filter((d) => d.demande.id !== entree.demande.id));
      setMessage('Réponse envoyée');
    } catch (e) {
      erreur(e);
    } finally {
      setOccupe(false);
    }
  };
  if (fin) return <HorsAcces fin={fin} />;
  return (
    <main className="appareil-coque pda">
      <h1>{enregistrement ? 'Enregistrer cet appareil' : 'Confirmer'}</h1>
      <p role="status">{message}</p>
      {pret && code?.RELAIS === null ? (
        <p>Le PDA est coupé sur le Mac</p>
      ) : pret && enregistrement ? (
        empreinte ? (
          <>
            <strong className="pda-empreinte">{empreinte}</strong>
            <p>Compare-la sur le Mac, puis active cet appareil là-bas</p>
            <a href="/pda">Confirmations</a>
          </>
        ) : (
          <form
            className="appairer-form"
            onSubmit={(e) => {
              e.preventDefault();
              void enregistrer();
            }}
          >
            <label>
              Nom de cet appareil
              <input value={nom} maxLength={80} onChange={(e) => setNom(e.target.value)} />
            </label>
            <button disabled={occupe || !nom.trim()}>Enregistrer cet appareil</button>
          </form>
        )
      ) : pret && !appareil ? (
        <a href="/pda/enregistrer">Enregistrer cet appareil</a>
      ) : (
        appareil && (
          <>
            <button disabled={occupe} onClick={() => void rafraichir()}>
              Actualiser
            </button>
            {illisibles > 0 && (
              <p>
                {illisibles}{' '}
                {illisibles === 1 ? 'demande illisible ignorée' : 'demandes illisibles ignorées'}
              </p>
            )}
            {demandes.map((d) => (
              <Demande key={d.demande.id} entree={d} occupe={occupe} repondre={repondre} />
            ))}
          </>
        )
      )}
    </main>
  );
}
function Demande({
  entree,
  occupe,
  repondre,
}: {
  entree: DemandePda;
  occupe: boolean;
  repondre: (d: DemandePda, valeur: 'oui' | 'non', numero: string) => Promise<void>;
}) {
  const [numero, setNumero] = useState('');
  const demande = entree.demande;
  return (
    <section>
      <h2>{demande.v === 2 ? demande.resume : 'Demande d’essai'}</h2>
      {demande.v === 1 ? (
        <p>{demande.sujet}</p>
      ) : (
        <ParametresSignes action={demande.action} params={demande.params} surface="telephone" />
      )}
      <strong className="pda-numero">{entree.demande.numero}</strong>
      <label>
        {demande.numero === null ? 'Retape le numéro affiché sur le Mac' : 'Retape le numéro'}
        <input inputMode="numeric" value={numero} onChange={(e) => setNumero(e.target.value)} />
      </label>
      <div className="appareil-actions">
        <button
          disabled={
            occupe ||
            (demande.numero === null ? !/^\d{4}$/.test(numero) : numero !== demande.numero)
          }
          onClick={() => void repondre(entree, 'oui', numero)}
        >
          Confirmer
        </button>
        <button disabled={occupe} onClick={() => void repondre(entree, 'non', '')}>
          Refuser
        </button>
      </div>
    </section>
  );
}
export function LienPda() {
  const [present, setPresent] = useState(false);
  useEffect(() => {
    void stockagePda()
      .then((p) => setPresent(!!p))
      .catch(() => undefined);
  }, []);
  return present ? <a href="/pda">Confirmations</a> : null;
}

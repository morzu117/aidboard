import { ParametresSignes } from './ui/ParametresSignes.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { empreintePda, encoderBase64url, type CorpsResultatV1 } from '../../src/shared/pda.js';
import {
  chargerCodePda,
  fabriquerReponse,
  lireDemandes,
  lireResultats,
  requeteRelais,
  stockagePda,
  type CodePda,
  type DemandePda,
  type PdaLocal,
} from './data/pda.js';
import { HorsAcces, type FinAcces } from './ui/HorsAcces.js';

export function libelleResultat(
  corps: CorpsResultatV1 | null,
  repondueA: number,
  maintenant: number,
): string {
  if (!corps)
    return maintenant - repondueA > 24 * 60 * 60_000
      ? 'Résultat non reçu, à lire sur le Mac'
      : 'En attente du résultat';
  const incertain =
    corps.raison === 'delai' ||
    ['upstream_ambiguous', 'delai', 'interrompu'].includes(corps.code ?? '');
  let libelle = incertain
    ? 'Issue incertaine, à vérifier sur le Mac'
    : corps.raison === 'numero'
      ? 'Annulée : numéro faux'
      : { executee: 'Exécutée', echouee: 'Échouée', perimee: 'Périmée', annulee: 'Annulée' }[
          corps.resultat
        ];
  const raison =
    !incertain && corps.raison !== 'numero' && corps.resultat === 'echouee' ? corps.raison : null;
  const details = [raison, corps.code !== 'succes' ? corps.code : null].filter(
    (detail, index, liste) => detail && liste.indexOf(detail) === index,
  );
  if (details.length) libelle += ` (${details.join(', ')})`;
  return libelle;
}

interface ReponseRecente {
  id: string;
  action: CorpsResultatV1['action'];
  resume: string;
  repondueA: number;
}

export function AppPda() {
  const [code, setCode] = useState<CodePda | null>(null);
  const [appareil, setAppareil] = useState<PdaLocal | null>(null);
  const [pret, setPret] = useState(false);
  const [message, setMessage] = useState('');
  const [demandes, setDemandes] = useState<DemandePda[]>([]);
  const [recentes, setRecentes] = useState<ReponseRecente[]>([]);
  const [resultats, setResultats] = useState<CorpsResultatV1[]>([]);
  const minuteries = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [maintenant, setMaintenant] = useState(() => Date.now());
  useEffect(() => () => minuteries.current.forEach(clearTimeout), []);
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
  const releverResultats = useCallback(async () => {
    if (!appareil || !code?.RELAIS || enregistrement) return;
    const liste = await lireResultats(code.RELAIS, appareil, code.CLE_DAEMON);
    if (liste !== null) {
      setResultats((gardes) => {
        const fusion = new Map(gardes.map((corps) => [corps.id, corps]));
        for (const corps of liste) {
          // Le premier résultat vérifié reçu pour cet id fait foi.
          if (!fusion.has(corps.id)) fusion.set(corps.id, corps);
        }
        return [...fusion.values()].sort((a, b) => b.emis - a.emis).slice(0, 50);
      });
    }
    setMaintenant(Date.now());
  }, [appareil, code, enregistrement]);
  const rafraichir = useCallback(async () => {
    if (!appareil || !code?.RELAIS || enregistrement) return;
    void releverResultats();
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
  }, [appareil, code, enregistrement, releverResultats]);
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
      if (valeur === 'oui') {
        const demande = entree.demande;
        setRecentes((liste) => [
          ...liste.filter((r) => r.id !== demande.id),
          {
            id: demande.id,
            action: demande.action,
            resume: demande.v === 2 ? demande.resume : 'Demande d’essai',
            repondueA: Date.now(),
          },
        ]);
        for (const delai of [20_000, 45_000]) {
          minuteries.current.push(setTimeout(() => void releverResultats(), delai));
        }
      }
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
            {(recentes.length > 0 || resultats.length > 0) && (
              <section>
                <h2>Réponses récentes</h2>
                {recentes.map((r) => (
                  <article key={r.id}>
                    <h3>{r.action}</h3>
                    <p>{r.resume}</p>
                    <time dateTime={new Date(r.repondueA).toISOString()}>
                      {new Date(r.repondueA).toLocaleString('fr-FR')}
                    </time>
                    <p>
                      {libelleResultat(
                        resultats.find((c) => c.id === r.id && c.action === r.action) ?? null,
                        r.repondueA,
                        maintenant,
                      )}
                    </p>
                  </article>
                ))}
                {resultats
                  .filter((c) => !recentes.some((r) => r.id === c.id))
                  .map((c) => (
                    <article key={c.id}>
                      <h3>{c.action}</h3>
                      <time dateTime={new Date(c.emis).toISOString()}>
                        {new Date(c.emis).toLocaleString('fr-FR')}
                      </time>
                      <p>{libelleResultat(c, c.emis, maintenant)}</p>
                    </article>
                  ))}
              </section>
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

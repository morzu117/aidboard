import { useEffect, useId, useRef, useState } from 'react';
import {
  KINDS_ECRITURE,
  type ActionEcriture,
  type KindEcriture,
} from '../../../src/shared/ecritures.js';
import { apercuEcriture, type ApercuEcriture } from '../data/ecritures.js';
import { useAidClient } from '../data/useAidState.js';
import { Dialogue } from '../dialogues/Dialogue.js';

export function EcrireAuMesh({
  action: depart,
  valeurs = {},
  choix = false,
  onClose,
}: {
  action: ActionEcriture;
  valeurs?: {
    texte?: string;
    kind?: KindEcriture;
    carte?: number;
    a?: string;
    pair?: string;
    canal?: string;
    fil?: string | null;
  };
  choix?: boolean;
  onClose: () => void;
}) {
  const client = useAidClient();
  const idTexte = useId();
  const idKind = useId();
  const idDestination = useId();
  const idCarte = useId();
  const idDestinataire = useId();
  const idPair = useId();
  const idCanal = useId();
  const [action, setAction] = useState(depart);
  const [texte, setTexte] = useState(valeurs.texte ?? '');
  const [kind, setKind] = useState<KindEcriture>(valeurs.kind ?? 'fyi');
  const [carte, setCarte] = useState(String(valeurs.carte ?? ''));
  const [a, setA] = useState(valeurs.a ?? '');
  const [pair, setPair] = useState(valeurs.pair ?? '');
  const [canal, setCanal] = useState(valeurs.canal ?? '');
  const [apercu, setApercu] = useState<ApercuEcriture | null>(null);
  const [attente, setAttente] = useState(false);
  const [erreur, setErreur] = useState('');
  const [copie, setCopie] = useState('');
  const cadre = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const avant = document.activeElement as HTMLElement | null;
    cadre.current?.querySelector('textarea')?.focus();
    return () => avant?.focus();
  }, []);
  function effacer() {
    setApercu(null);
    setErreur('');
    setCopie('');
  }
  async function voir() {
    effacer();
    setAttente(true);
    const commun = { texte, kind };
    try {
      setApercu(
        await (action === 'carte.note'
          ? apercuEcriture(action, { ...commun, carte: Number(carte), a: a || null }, client)
          : action === 'dm.envoyer'
            ? apercuEcriture(action, { ...commun, pair, fil: valeurs.fil ?? null }, client)
            : apercuEcriture(action, { ...commun, canal }, client)),
      );
    } catch {
      setErreur('Impossible de lire l’aperçu. Réessaie.');
    } finally {
      setAttente(false);
    }
  }
  async function copier(contenu: string, cible: string) {
    setCopie('');
    setErreur('');
    try {
      await navigator.clipboard.writeText(contenu);
      setCopie(cible);
    } catch {
      setErreur('Copie impossible : accès au presse-papiers refusé.');
    }
  }
  const commande = apercu?.ok
    ? ['swarph', ...apercu.argv]
        .map((v) =>
          /^[A-Za-z0-9._/:=@-]+$/.test(v) ? v : "'" + v.replaceAll("'", "'\"'\"'") + "'",
        )
        .join(' ')
    : '';
  return (
    <Dialogue titre="Écrire au mesh (à blanc)" onClose={onClose}>
      <div
        ref={cadre}
        onKeyDown={(e) => {
          if (e.key !== 'Tab') return;
          const elements = cadre.current?.querySelectorAll<HTMLElement>(
            'textarea:enabled, input:enabled, select:enabled, button:enabled',
          );
          if (!elements?.length) return;
          const premier = elements[0]!;
          const dernier = elements[elements.length - 1]!;
          if (e.shiftKey && document.activeElement === premier) {
            e.preventDefault();
            dernier.focus();
          } else if (!e.shiftKey && document.activeElement === dernier) {
            e.preventDefault();
            premier.focus();
          }
        }}
      >
        <fieldset disabled={attente} onChange={effacer}>
          <label htmlFor={idTexte}>Texte</label>
          <textarea id={idTexte} value={texte} onChange={(e) => setTexte(e.target.value)} />
          <label htmlFor={idKind}>Kind</label>
          <select
            id={idKind}
            value={kind}
            onChange={(e) => setKind(e.target.value as KindEcriture)}
          >
            {KINDS_ECRITURE.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
          {choix && (
            <>
              <label htmlFor={idDestination}>Destination</label>
              <select
                id={idDestination}
                value={action}
                onChange={(e) => setAction(e.target.value as ActionEcriture)}
              >
                <option value="dm.envoyer">DM</option>
                <option value="canal.poster">Canal</option>
              </select>
            </>
          )}
          {action === 'carte.note' && (
            <>
              <label htmlFor={idCarte}>Carte</label>
              <input
                id={idCarte}
                type="number"
                value={carte}
                onChange={(e) => setCarte(e.target.value)}
              />
              <label htmlFor={idDestinataire}>Destinataire facultatif</label>
              <input id={idDestinataire} value={a} onChange={(e) => setA(e.target.value)} />
            </>
          )}
          {action === 'dm.envoyer' && (
            <>
              <label htmlFor={idPair}>Pair</label>
              <input id={idPair} value={pair} onChange={(e) => setPair(e.target.value)} />
            </>
          )}
          {action === 'canal.poster' && (
            <>
              <label htmlFor={idCanal}>Canal</label>
              <input id={idCanal} value={canal} onChange={(e) => setCanal(e.target.value)} />
              <p>Ce post serait lu par tous les membres du canal.</p>
            </>
          )}
          <button onClick={() => void voir()}>Voir l&apos;aperçu</button>
        </fieldset>
        {apercu &&
          (apercu.ok ? (
            <section aria-label="Aperçu">
              <p>{apercu.resume}</p>
              <pre>{commande}</pre>
              <pre>{apercu.texte}</pre>
              {apercu.rappel &&
                ('indisponible' in apercu.rappel ? (
                  <p>Rappel des obligations indisponible.</p>
                ) : (
                  apercu.rappel.obligations.map((n) => (
                    <p key={n}>
                      Tu as l&apos;obligation #{n} ouverte sur cette carte. Cette note ne la clôt
                      pas ; la clore passe par le 36.
                    </p>
                  ))
                ))}
              <p>
                À blanc : rien n&apos;est parti. L&apos;envoi viendra avec le proxy local (#20).
              </p>
              <button onClick={() => void copier(commande, 'commande')}>Copier la commande</button>
              {copie === 'commande' && <span role="status">Copié</span>}
              <p>
                S&apos;exécute avec tous les droits de ta cellule. Écris d&apos;abord le texte dans
                un fichier et remplace FICHIER par son chemin.
              </p>
              <button onClick={() => void copier(apercu.texte, 'texte')}>Copier le texte</button>
              {copie === 'texte' && <span role="status">Copié</span>}
            </section>
          ) : (
            <p role="alert">{apercu.message}</p>
          ))}
        {erreur && <p role="alert">{erreur}</p>}
        <button onClick={onClose}>Fermer</button>
      </div>
    </Dialogue>
  );
}

import { useBoardProjects } from '../data/board.js';
import { AVERTISSEMENT_CREATION, lignesCreation } from '../../../src/shared/ecritures.js';
import { EnteteMesh } from './SelecteurMesh.js';
import { instantaneMesh } from '../data/meshLecture.js';
import { AidApiError } from '../data/api.js';
import { AttenteConfirmation } from './AttenteConfirmation.js';
import { useEffect, useId, useRef, useState } from 'react';
import {
  KINDS_ECRITURE,
  type ActionEcriture,
  type KindEcriture,
} from '../../../src/shared/ecritures.js';
import {
  envoyerEcriture,
  envoiIncertain,
  libelleEnvoi,
  type ResultatEnvoi,
  apercuEcriture,
  type ApercuEcriture,
} from '../data/ecritures.js';
import { useAid, useAidClient } from '../data/useAidState.js';
import { Dialogue } from '../dialogues/Dialogue.js';

export function EcrireAuMesh(props: ParametresFormulaire) {
  const mesh = props.mesh;
  const [origine, setOrigine] = useState({ mesh, efface: false });
  if (origine.mesh !== mesh) setOrigine({ mesh, efface: true });
  return (
    <FormulaireEcriture
      key={mesh}
      {...props}
      mesh={mesh}
      valeurs={origine.mesh === mesh && !origine.efface ? props.valeurs : {}}
    />
  );
}

type ParametresFormulaire = {
  mesh: string;
  propositionSwairm?: number;
  onEnvoye?: () => void;
  action: ActionEcriture;
  valeurs?: {
    titre?: string;
    ligneSwairm?: string;
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
  onRelire?: () => void | Promise<void>;
};

function FormulaireEcriture({
  mesh,
  action: depart,
  valeurs = {},
  choix = false,
  onClose,
  onRelire,
  propositionSwairm,
  onEnvoye,
}: ParametresFormulaire & { mesh: string }) {
  const client = useAidClient();
  const projets = useBoardProjects(mesh);
  const [projet, setProjet] = useState('');
  const [titre, setTitre] = useState(valeurs.titre ?? '');
  const projetChoisi = projets.result?.ok
    ? projets.result.data.find((p) => p.id === Number(projet) && p.title)
    : undefined;

  const { state } = useAid();
  const objetMesh = instantaneMesh(state, mesh);
  const lectureSeule = objetMesh?.state.proxyConfigure && !objetMesh.state.ecritures;
  const [proxyAbsent, setProxyAbsent] = useState(false);
  const [envoye, setEnvoye] = useState(false);
  const verrou = useRef(false);
  const [terminee, setTerminee] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [resultat, setResultat] = useState<ResultatEnvoi | null>(null);
  const idTexte = useId();
  const idKind = useId();
  const idDestination = useId();
  const idCarte = useId();
  const idDestinataire = useId();
  const idPair = useId();
  const idCanal = useId();
  const [action, setAction] = useState(depart);
  const [texte, setTexte] = useState(valeurs.texte ?? '');
  const creation = {
    projet: Number(projet),
    projetNom: projetChoisi?.title ?? '',
    titre,
    corps: (valeurs.ligneSwairm ?? '') + (texte ? `\n\n${texte}` : ''),
  };
  const [kind, setKind] = useState<KindEcriture>(valeurs.kind ?? 'fyi');
  const [carte, setCarte] = useState(String(valeurs.carte ?? ''));
  const [a, setA] = useState(valeurs.a ?? '');
  const [pair, setPair] = useState(valeurs.pair ?? '');
  const [canal, setCanal] = useState(valeurs.canal ?? '');
  const [apercu, setApercu] = useState<ApercuEcriture | null>(null);
  const [attente, setAttente] = useState(false);
  const [erreur, setErreur] = useState('');
  const [copie, setCopie] = useState('');
  const [relectureEnCours, setRelectureEnCours] = useState(false);
  const cadre = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const avant = document.activeElement as HTMLElement | null;
    cadre.current?.querySelector('textarea')?.focus();
    return () => avant?.focus();
  }, []);
  function effacer() {
    setApercu(null);
    verrou.current = false;
    setEnvoye(false);
    setConfirmation(null);
    setTerminee(false);
    setResultat(null);
    setErreur('');
    setCopie('');
  }
  async function voir() {
    effacer();
    setAttente(true);
    const commun = { texte, kind };
    try {
      setApercu(
        await (action === 'carte.creer'
          ? apercuEcriture(action, creation, client, mesh)
          : action === 'carte.note'
            ? apercuEcriture(
                action,
                { ...commun, carte: Number(carte), a: a || null },
                client,
                mesh,
              )
            : action === 'dm.envoyer'
              ? apercuEcriture(action, { ...commun, pair, fil: valeurs.fil ?? null }, client, mesh)
              : apercuEcriture(action, { ...commun, canal }, client, mesh)),
      );
    } catch {
      setErreur('Impossible de lire l’aperçu. Réessaie.');
    } finally {
      setAttente(false);
    }
  }
  async function envoyer() {
    if (verrou.current || proxyAbsent || lectureSeule) return;
    verrou.current = true;
    setEnvoye(true);
    setConfirmation(null);
    setTerminee(false);
    setErreur('');
    setAttente(true);
    const commun = { texte, kind };
    try {
      const r = await (action === 'carte.creer'
        ? envoyerEcriture(action, creation, client, undefined, mesh)
        : action === 'carte.note'
          ? envoyerEcriture(
              action,
              { ...commun, carte: Number(carte), a: a || null },
              client,
              propositionSwairm,
              mesh,
            )
          : action === 'dm.envoyer'
            ? envoyerEcriture(
                action,
                { ...commun, pair, fil: valeurs.fil ?? null },
                client,
                undefined,
                mesh,
              )
            : envoyerEcriture(action, { ...commun, canal }, client, undefined, mesh));
      if ('confirmation' in r) setConfirmation(r.confirmation);
      else {
        setResultat(r);
        if (r.code === 'succes') onEnvoye?.();
      }
    } catch (e) {
      if (e instanceof AidApiError && e.status === 409 && e.body.error === 'proxy_absent')
        setProxyAbsent(true);
      else if (
        e instanceof AidApiError &&
        e.status === 409 &&
        e.body.error === 'confirmation_requise'
      )
        setErreur(
          "La porte des confirmations n'est pas armée : arme-la depuis ton téléphone pour écrire sur le mesh. Rien n'est parti.",
        );
      else
        setErreur(
          e instanceof AidApiError && typeof e.body.message === 'string'
            ? e.body.message
            : e instanceof Error
              ? e.message
              : 'Envoi impossible.',
        );
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
    <Dialogue
      titre={action === 'carte.creer' ? 'Créer la carte' : 'Écrire au mesh (à blanc)'}
      onClose={onClose}
    >
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
        <fieldset disabled={attente || (confirmation !== null && !terminee)} onChange={effacer}>
          {action === 'carte.creer' && (
            <>
              <EnteteMesh mesh={mesh} />
              <label>
                Projet
                <select value={projet} onChange={(e) => setProjet(e.target.value)}>
                  <option value="">Choisir un projet</option>
                  {projets.result?.ok &&
                    projets.result.data
                      .filter((p) => p.title)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.title} (#{p.id})
                        </option>
                      ))}
                </select>
              </label>
              {projets.erreur && <p role="alert">{projets.erreur}</p>}
              <label>
                Titre
                <input value={titre} onChange={(e) => setTitre(e.target.value)} />
              </label>
              <p>{valeurs.ligneSwairm}</p>
            </>
          )}
          <label htmlFor={idTexte}>{action === 'carte.creer' ? 'Texte facultatif' : 'Texte'}</label>
          <textarea id={idTexte} value={texte} onChange={(e) => setTexte(e.target.value)} />
          {action !== 'carte.creer' && (
            <>
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
            </>
          )}
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
          <button
            disabled={envoye || (action === 'carte.creer' && !projetChoisi)}
            onClick={() => void voir()}
          >
            Voir l&apos;aperçu
          </button>
        </fieldset>
        {apercu &&
          (apercu.ok ? (
            <section aria-label="Aperçu">
              <EnteteMesh mesh={mesh} />
              <p>{apercu.resume}</p>
              {action === 'carte.creer' ? (
                <>
                  {(apercu.lignes ?? lignesCreation(creation)).map((ligne) => (
                    <p key={ligne}>{ligne}</p>
                  ))}
                  <p>{apercu.avertissement ?? AVERTISSEMENT_CREATION}</p>
                </>
              ) : (
                <pre>{commande}</pre>
              )}
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
              {action !== 'carte.creer' && !resultat && !confirmation && (
                <p>
                  À blanc : rien n&apos;est parti. L&apos;envoi viendra avec le proxy local (#20).
                </p>
              )}
              <button
                disabled={lectureSeule || proxyAbsent || envoye}
                onClick={() => void envoyer()}
              >
                Envoyer
              </button>
              {lectureSeule && (
                <p>Le proxy de ta cellule est en lecture seule : rien ne peut partir.</p>
              )}
              {proxyAbsent && (
                <p>
                  Le proxy de ta cellule n&apos;est pas configuré. Rien ne peut partir ;
                  l&apos;aperçu reste disponible.
                </p>
              )}
              {confirmation && (
                <>
                  {!terminee && <p>En attente de ta confirmation sur le téléphone.</p>}
                  <AttenteConfirmation
                    key={confirmation}
                    id={confirmation}
                    onTerminee={(d) => {
                      if (d?.envoi) setResultat(d.envoi);
                      if (d?.envoi?.code === 'succes') onEnvoye?.();
                      if (!d || (!d.envoi && (d.resultat === 'annulee' || d.etat === 'expiree'))) {
                        verrou.current = false;
                        setEnvoye(false);
                      }
                      setTerminee(true);
                    }}
                  />
                </>
              )}
              {resultat && <p role="status">{resultat.message ?? libelleEnvoi(resultat)}</p>}
              {action === 'carte.creer' && resultat?.id && <p>Carte : #{resultat.id}</p>}
              {action === 'carte.creer' && resultat?.relecture === 'trouvee' && (
                <p>Le board a retrouvé la carte.</p>
              )}
              {action === 'carte.creer' && resultat?.relecture === 'absente' && (
                <p>Le board a été relu : aucune carte ne porte ce sujet.</p>
              )}
              {resultat &&
                envoiIncertain(resultat) &&
                (action !== 'carte.creer' || resultat.cree !== true) &&
                (action === 'carte.creer' ? (
                  <button
                    disabled={relectureEnCours}
                    onClick={() => {
                      setRelectureEnCours(true);
                      void Promise.resolve(onRelire?.()).finally(() => setRelectureEnCours(false));
                    }}
                  >
                    Relire le board
                  </button>
                ) : action === 'carte.note' ? (
                  <button
                    onClick={() => {
                      onClose();
                      onRelire?.();
                    }}
                  >
                    Relire le fil
                  </button>
                ) : (
                  <p>Vérifie la Boîte ou le canal avant de réessayer.</p>
                ))}
              {action !== 'carte.creer' && (
                <>
                  <button onClick={() => void copier(commande, 'commande')}>
                    Copier la commande
                  </button>
                  {copie === 'commande' && <span role="status">Copié</span>}
                  <p>
                    S&apos;exécute avec tous les droits de ta cellule. Écris d&apos;abord le texte
                    dans un fichier et remplace FICHIER par son chemin.
                  </p>
                  <button onClick={() => void copier(apercu.texte, 'texte')}>
                    Copier le texte
                  </button>
                  {copie === 'texte' && <span role="status">Copié</span>}
                </>
              )}
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

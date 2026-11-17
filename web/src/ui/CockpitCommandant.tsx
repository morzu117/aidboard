import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { EtatFileCommandant } from '../../../src/daemon/commandant/service.js';
import type { ControleCommandant } from '../../../src/shared/commandant.js';
import {
  AVERTISSEMENT_COMMANDANT,
  texteCommandantValide,
} from '../../../src/shared/commandant-texte.js';
import {
  ageCommandant,
  CONSIGNE_IDENTIFIANT_COMMANDANT,
  identifiantCommandantARefaire,
  messageErreurCommandant,
} from '../../../src/shared/commandant-reponse.js';
import { useAidClient } from '../data/useAidState.js';
import { AidApiError } from '../data/api.js';
import { AttenteConfirmation, type Confirmation } from './AttenteConfirmation.js';

export const ETATS_COCKPIT = {
  absent: 'Absent',
  valide: 'Configuré',
  expire: 'Expiré',
  revoque: 'Révoqué',
  inconnu: 'Inconnu',
  refuse: 'Refusé',
};
function messageErreur(e: unknown): string {
  return e instanceof AidApiError
    ? messageErreurCommandant(String(e.body.error ?? ''), e.status)
    : messageErreurCommandant('reseau');
}
function ReglagesCommandant() {
  return (
    <Link data-node="commandant.reglages" to="/swarph/reglages">
      Réglages swarph
    </Link>
  );
}
export function EtatCockpit({
  identifiant,
  appareil = false,
  reglages = false,
  aide = true,
}: {
  identifiant: EtatFileCommandant['identifiant'];
  appareil?: boolean;
  reglages?: boolean;
  aide?: boolean;
}) {
  const arret = ['expire', 'revoque', 'inconnu'].includes(identifiant.etat);
  return (
    <div className="groupe">
      <div className="element-entete">
        <span
          className={`badge ${identifiant.etat === 'valide' ? 'badge--cours' : 'badge--attente'}`}
        >
          Identifiant cockpit : {ETATS_COCKPIT[identifiant.etat]}
        </span>
        {identifiant.saisie && (
          <span className="texte-discret">
            Saisi le {new Date(identifiant.saisie).toLocaleString('fr-FR')}
          </span>
        )}
      </div>
      {aide &&
        identifiant.etat !== 'valide' &&
        (appareil ? (
          <p>L’identifiant cockpit se règle sur le Mac.</p>
        ) : (
          (arret || identifiant.etat === 'refuse' || !reglages) && (
            <div className="groupe">
              {arret && <p>{CONSIGNE_IDENTIFIANT_COMMANDANT}.</p>}
              {identifiant.etat === 'refuse' && <p>La passerelle refuse cet identifiant.</p>}
              {!reglages && <ReglagesCommandant />}
            </div>
          )
        ))}
    </div>
  );
}
function Illisible({ controle }: { controle: Extract<ControleCommandant, { valide: false }> }) {
  const message =
    controle.raison === 'digest'
      ? 'Demande illisible : le digest ne correspond pas'
      : controle.raison === 'summary'
        ? 'Demande illisible : le résumé sort des règles'
        : `Demande illisible (${controle.raison})`;
  return (
    <p className="message-erreur" role="alert">
      {message} — #{controle.id ?? '?'}
    </p>
  );
}
type LectureDetail = ControleCommandant | { erreur: { code: string; http?: number } };
export function CockpitCommandant({
  mesh,
  appareil = false,
}: {
  mesh: string;
  appareil?: boolean;
}) {
  const client = useAidClient();
  const selection = useRef<number | null>(null);
  const [maintenant, setMaintenant] = useState(Date.now);
  const [file, setFile] = useState<EtatFileCommandant | null>(null);
  const [detail, setDetail] = useState<ControleCommandant | null>(null);
  const [erreurLecture, setErreurLecture] = useState('');
  const [erreurAction, setErreurAction] = useState('');
  const [texte, setTexte] = useState('');
  const [occupe, setOccupe] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [resultatPorte, setResultatPorte] = useState<Confirmation | null>(null);
  const [terminee, setTerminee] = useState(false);
  const base = `/api/commandant/${encodeURIComponent(mesh)}`;
  const lire = useCallback(
    async (forcer = false) => {
      if (forcer) await client.request('POST', `${base}/battement`, { ouverture: true });
      const id = selection.current;
      const [r, d] = await Promise.all([
        client.request<EtatFileCommandant>('GET', base),
        id === null
          ? Promise.resolve(null)
          : client.request<LectureDetail>('GET', `${base}/demandes/${id}`),
      ]);
      if (selection.current !== id) return;
      setMaintenant(Date.now());
      const remplace = d !== null && (!('erreur' in d) || d.erreur.code === 'not_found');
      const lignes = r.lignes.filter(
        (c) => c.ligne.status === 'pending' && (!remplace || c.ligne.id !== id),
      );
      const refusees = r.refusees.filter((c) => !remplace || c.id !== id);
      if (d && !('erreur' in d)) {
        setDetail(d);
        if (d.valide && d.ligne.status === 'pending') {
          const position = r.lignes.findIndex((c) => c.ligne.id === id);
          lignes.splice(position < 0 ? lignes.length : Math.min(position, lignes.length), 0, d);
        } else if (!d.valide) refusees.push(d);
      }
      const e = d && 'erreur' in d ? d.erreur : r.erreur;
      setErreurLecture(e ? messageErreurCommandant(e.code, e.http) : '');
      setFile({ ...r, lignes, refusees });
    },
    [client, base],
  );
  useEffect(() => {
    let actif = true;
    const battement = async (ouverture = false) => {
      if (document.hidden || !actif) return;
      try {
        await client.request('POST', `${base}/battement`, { ouverture });
        if (actif) await lire();
      } catch (e) {
        if (actif) setErreurLecture(messageErreur(e));
      }
    };
    void battement(true);
    const timer = setInterval(() => void battement(), 30_000);
    const visibilite = () => void battement(true);
    document.addEventListener('visibilitychange', visibilite);
    return () => {
      actif = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visibilite);
    };
  }, [client, base, lire]);
  async function actualiser() {
    setOccupe(true);
    setErreurAction('');
    try {
      await lire(true);
    } catch (e) {
      setErreurLecture(messageErreur(e));
    } finally {
      setOccupe(false);
    }
  }
  async function ouvrir(id: number) {
    selection.current = id;
    setOccupe(true);
    setErreurAction('');
    setErreurLecture('');
    setTexte('');
    setConfirmation(null);
    setResultatPorte(null);
    try {
      const d = await client.request<LectureDetail>('GET', `${base}/demandes/${id}`);
      if (selection.current !== id) return;
      if ('erreur' in d) {
        setDetail(null);
        setErreurLecture(messageErreurCommandant(d.erreur.code, d.erreur.http));
      } else {
        setDetail(d);
        if (!d.valide || d.ligne.status !== 'pending')
          setFile((r) => r && { ...r, lignes: r.lignes.filter((c) => c.ligne.id !== id) });
      }
    } catch (e) {
      setErreurLecture(messageErreur(e));
    } finally {
      setOccupe(false);
    }
  }
  async function repondre(decision: string) {
    if (!detail?.valide || appareil) return;
    setOccupe(true);
    setErreurAction('');
    setConfirmation(null);
    setResultatPorte(null);
    try {
      const r = await client.request<{ confirmation: string }>(
        'POST',
        `${base}/demandes/${detail.ligne.id}/reponse`,
        { digest: detail.ligne.digest, decision },
      );
      setTerminee(false);
      setConfirmation(r.confirmation);
    } catch (e) {
      setErreurAction(messageErreur(e));
      await lire(true).catch(() => {});
    } finally {
      setOccupe(false);
    }
  }
  const ligne = detail?.valide ? detail.ligne : null;
  const attente = occupe || (!!confirmation && !terminee);
  const erreur = erreurAction || (!confirmation ? erreurLecture : '');
  const arret = file && ['expire', 'revoque', 'inconnu'].includes(file.identifiant.etat);
  const erreurAffichee = erreur && (
    <div className="groupe">
      <p className="message-erreur" role="alert">
        {erreur}
      </p>
      {(arret || erreur.includes('cockpit_credential_')) && !appareil && <ReglagesCommandant />}
    </div>
  );
  const suivi = confirmation && !appareil && (
    <section className="groupe" aria-label="Résultat de la réponse">
      {!terminee && <p>En attente de ton PDA</p>}
      <AttenteConfirmation
        key={confirmation}
        id={confirmation}
        toujours
        complement={
          identifiantCommandantARefaire(resultatPorte?.envoi?.code) ? (
            <ReglagesCommandant />
          ) : undefined
        }
        onTerminee={(r) => {
          setTerminee(true);
          setResultatPorte(r ?? null);
          setOccupe(true);
          void lire(true)
            .catch((e: unknown) => setErreurLecture(messageErreur(e)))
            .finally(() => setOccupe(false));
        }}
      />
    </section>
  );
  return (
    <section className="groupe" aria-label="Cockpit du commandant">
      <div className="entete">
        <div className="entete-texte">
          <h1 className="titre-ecran">Cockpit du commandant</h1>
        </div>
        <button
          data-node="commandant.relire"
          className="bouton"
          disabled={occupe}
          onClick={() => void actualiser()}
        >
          Relire la file
        </button>
      </div>
      {file && (
        <EtatCockpit
          identifiant={file.identifiant}
          appareil={appareil}
          aide={appareil || (!confirmation && !erreur)}
        />
      )}
      {!ligne && erreurAffichee}
      <ul className="board-cartes" aria-label="Demandes en attente">
        {file?.lignes.map((c) => (
          <li className="groupe" key={c.ligne.id}>
            <button
              data-node="commandant.ouvrir"
              className="board-carte"
              aria-pressed={ligne?.id === c.ligne.id}
              disabled={occupe}
              onClick={() => void ouvrir(c.ligne.id)}
            >
              <span className="element-entete">
                <strong className="board-carte-titre">
                  #{c.ligne.id} — {c.ligne.type}
                </strong>
                {ligne?.id === c.ligne.id && (
                  <span className="badge badge--attente">Sélectionnée</span>
                )}
              </span>
              <span className="board-carte-meta">
                <span className="board-carte-titre">{c.ligne.proposer}</span>
                <span>{ageCommandant(c.dates.creation, maintenant)}</span>
              </span>
              <code className="serveur-mono">{c.ligne.digest.slice(0, 16)}</code>
            </button>
          </li>
        ))}
      </ul>
      {file?.refusees.map((c, i) => (
        <Illisible key={i} controle={c} />
      ))}
      {detail && !detail.valide && !file?.refusees.some((c) => c.id === detail.id) && (
        <Illisible controle={detail} />
      )}
      {ligne && (
        <article className="carte-panneau" aria-label={`Demande #${ligne.id}`}>
          <h2 className="titre-panneau">Demande #{ligne.id}</h2>
          <section className="groupe">
            <h3 className="titre-zone">Rendu par la passerelle</h3>
            <div className="element-question board-carte-titre">
              {ligne.summary.map((s, i) => (
                <p key={i}>{s}</p>
              ))}
            </div>
          </section>
          <section className="groupe">
            <h3 className="titre-zone">Les mots du proposant</h3>
            <p className="element-detail board-carte-titre">{ligne.why ?? 'Aucun motif fourni.'}</p>
          </section>
          <section className="groupe">
            <h3 className="titre-zone">Digest</h3>
            <code className="serveur-mono">{ligne.digest.slice(0, 16)}</code>
          </section>
          {ligne.status !== 'pending' ? (
            <p>
              Close : {ligne.status} — {ligne.decided_by ?? 'inconnu'} —{' '}
              {ligne.decided_via ?? 'inconnu'}
            </p>
          ) : ligne.type !== 'decision' ? (
            <p>{`Approuve dans l'onglet Command de swarph-desktop : demande #${ligne.id}, digest ${ligne.digest.slice(0, 16)}`}</p>
          ) : ligne.needs_sso ? (
            <p>Cette question demande ta session SSO : réponds dans le Command Center.</p>
          ) : !detail?.valide || !detail.repondable ? (
            <p>Cette question dépasse les limites du cockpit : réponds dans le Command Center.</p>
          ) : appareil ? (
            <p>{`Réponds depuis l'écran du Mac : demande #${ligne.id}, digest ${ligne.digest.slice(0, 16)}.`}</p>
          ) : (
            <section className="element" aria-label="Ta réponse">
              <h3 className="titre-zone">Ta réponse</h3>
              <p className="board-carte-titre">{ligne.params.question as string}</p>
              {(ligne.params.options as string[]).length ? (
                <div className="element-actions">
                  {(ligne.params.options as string[]).map((o, i) => (
                    <button
                      data-node="commandant.option"
                      key={i}
                      className="bouton"
                      disabled={attente}
                      onClick={() => void repondre(o)}
                    >
                      <span className="board-carte-titre">{o}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="formulaire">
                  <label className="serveur-champ">
                    Ta réponse
                    <input
                      className="champ"
                      data-node="commandant.texte"
                      value={texte}
                      onChange={(e) => setTexte(e.target.value)}
                    />
                  </label>
                  <div className="element-actions">
                    <button
                      data-node="commandant.repondre"
                      className="bouton"
                      disabled={attente || !texte.trim() || !texteCommandantValide(texte, 1000)}
                      onClick={() => void repondre(texte)}
                    >
                      Répondre
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}
          {!appareil && ligne.type === 'decision' && (
            <p className="texte-discret">{AVERTISSEMENT_COMMANDANT}</p>
          )}
          {erreurAffichee}
          {suivi}
        </article>
      )}
      {!ligne && suivi}
    </section>
  );
}

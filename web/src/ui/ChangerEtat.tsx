import { useId, useRef, useState } from 'react';
import type { BoardObligation, BoardStep } from '../../../src/shared/board.js';
import { hashAccept, ISSUES_CLOTURE, type IssueCloture } from '../../../src/shared/etats.js';
import { AidApiError } from '../data/api.js';
import {
  actionsPossibles,
  CLOTURE_PAR_CONDITION,
  envoyerEtat,
  type ActionPossible,
  type ResultatEtat,
} from '../data/etats.js';
import { envoiIncertain, libelleEnvoi } from '../data/ecritures.js';
import { useAid, useAidClient } from '../data/useAidState.js';
import { Dialogue } from '../dialogues/Dialogue.js';
import { AttenteConfirmation } from './AttenteConfirmation.js';

const LIBELLES = { prendre: 'Prendre', refuser: 'Refuser', clore: 'Clore' };
const PERIME =
  "L'obligation a changé juste avant l'écriture. Rien n'a été modifié. Relis la carte.";

export function ChangerEtat({
  obligation,
  etape,
  carte,
  relire,
}: {
  obligation: BoardObligation;
  etape: BoardStep | undefined;
  carte: number;
  relire: () => void;
}) {
  const { state } = useAid();
  const [action, choisir] = useState<ActionPossible | null>(null);
  if (!state?.mesh || !state.mesh.state.ecritures) return null;
  return (
    <>
      {actionsPossibles(obligation, etape, state.mesh.state.cell).map((a) => (
        <button key={a} onClick={() => choisir(a)}>
          {LIBELLES[a]}
        </button>
      ))}
      {action && (
        <DemandeEtat
          action={action}
          obligation={obligation}
          etape={etape}
          carte={carte}
          relire={relire}
          fermer={() => choisir(null)}
        />
      )}
    </>
  );
}

function DemandeEtat({
  action,
  obligation,
  etape,
  carte,
  relire,
  fermer,
}: {
  action: ActionPossible;
  obligation: BoardObligation;
  etape: BoardStep | undefined;
  carte: number;
  relire: () => void;
  fermer: () => void;
}) {
  const client = useAidClient();
  // La lecture qui a ouvert la boîte reste l'attendu, même si la carte est rafraîchie.
  const [lecture] = useState(obligation);
  const verrou = useRef(false);
  const [envoye, setEnvoye] = useState(false);
  const [issue, setIssue] = useState<IssueCloture>('pass');
  const [preuve, setPreuve] = useState('');
  const [motif, setMotif] = useState('');
  const [preuves, setPreuves] = useState<Record<string, string>>({});
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [resultat, setResultat] = useState<ResultatEtat | null>(null);
  const [erreur, setErreur] = useState('');
  const id = useId();
  function terminer(r: ResultatEtat) {
    setResultat(r);
    relire();
  }
  async function envoyer() {
    if (verrou.current) return;
    verrou.current = true;
    setEnvoye(true);
    try {
      const cible = { carte, obligation: lecture.id, attendu: { status: 'open' as const } };
      const r =
        action === 'clore'
          ? await envoyerEtat(
              'obligation.clore',
              {
                ...cible,
                attendu: {
                  status: 'open',
                  acceptSha256: await hashAccept(lecture.accept),
                },
                issue,
                ...(lecture.conditions.length ? { preuves } : { preuve }),
              },
              client,
            )
          : action === 'refuser'
            ? await envoyerEtat('obligation.refuser', { ...cible, motif }, client)
            : await envoyerEtat('obligation.prendre', cible, client);
      if ('confirmation' in r) setConfirmation(r.confirmation);
      else terminer(r);
    } catch (e) {
      if (e instanceof AidApiError && e.status === 409 && e.body.error === 'perime') {
        setErreur(PERIME);
        relire();
      } else if (e instanceof AidApiError && e.body.error === 'proxy_absent') {
        setErreur("Le proxy de ta cellule n'est pas configuré. Rien ne peut partir.");
      } else
        setErreur(
          e instanceof AidApiError && typeof e.body.message === 'string'
            ? e.body.message
            : 'Envoi impossible. Relis la carte.',
        );
    }
  }
  const perime = resultat?.code === 'upstream_error' && resultat.status === 409;
  return (
    <Dialogue titre={`${LIBELLES[action]} l'obligation #${lecture.id} ?`} onClose={fermer}>
      <fieldset disabled={envoye}>
        {action === 'refuser' && (
          <>
            <label htmlFor={`${id}-motif`}>Motif</label>
            <textarea
              id={`${id}-motif`}
              required
              maxLength={2000}
              value={motif}
              onChange={(e) => setMotif(e.target.value)}
            />
          </>
        )}
        {action === 'clore' && (
          <>
            <pre>{lecture.accept ?? ''}</pre>
            <label htmlFor={`${id}-issue`}>Issue</label>
            <select
              id={`${id}-issue`}
              value={issue}
              onChange={(e) => setIssue(e.target.value as IssueCloture)}
            >
              {ISSUES_CLOTURE.filter(
                (i) => i !== 'skipped' || (CLOTURE_PAR_CONDITION && etape?.mandatory === false),
              ).map((i) => (
                <option key={i}>{i}</option>
              ))}
            </select>
            {lecture.conditions.length ? (
              lecture.conditions.map((condition) => {
                const cle =
                  typeof condition === 'string'
                    ? condition
                    : String((condition as { id: string }).id);
                return (
                  <div key={cle}>
                    <label htmlFor={`${id}-${cle}`}>Preuve {cle}</label>
                    <textarea
                      id={`${id}-${cle}`}
                      required
                      maxLength={16000}
                      value={preuves[cle] ?? ''}
                      onChange={(e) => setPreuves({ ...preuves, [cle]: e.target.value })}
                    />
                  </div>
                );
              })
            ) : (
              <>
                <label htmlFor={`${id}-preuve`}>Preuve</label>
                <textarea
                  id={`${id}-preuve`}
                  maxLength={4000}
                  value={preuve}
                  onChange={(e) => setPreuve(e.target.value)}
                />
              </>
            )}
          </>
        )}
        <button
          disabled={
            envoye ||
            (action === 'refuser' && !motif.trim()) ||
            (action === 'clore' &&
              (lecture.conditions.length
                ? Object.values(preuves).filter((p) => p.trim()).length !==
                  lecture.conditions.length
                : !preuve.trim()))
          }
          onClick={() => void envoyer()}
        >
          Confirmer
        </button>
      </fieldset>
      {confirmation && (
        <AttenteConfirmation
          id={confirmation}
          onTerminee={(d) => {
            if (d?.envoi) terminer(d.envoi);
            else relire();
          }}
        />
      )}
      {resultat && (
        <p role="status">
          {perime
            ? PERIME
            : envoiIncertain({ ...resultat, open_obligations: [] })
              ? 'Envoi incertain : relis la carte avant toute nouvelle action.'
              : libelleEnvoi({ ...resultat, open_obligations: [] })}
        </p>
      )}
      {erreur && <p role="alert">{erreur}</p>}
      {(erreur ||
        (resultat && (perime || envoiIncertain({ ...resultat, open_obligations: [] })))) && (
        <button onClick={relire}>Relire la carte</button>
      )}
      <button onClick={fermer}>Fermer</button>
    </Dialogue>
  );
}

import { AvatarCell } from './AvatarCell.js';
import { EnteteMesh } from './SelecteurMesh.js';
import { cheminMesh, instantaneMesh } from '../data/meshLecture.js';
import {
  siegesAvis,
  FAMILLES_AVIS,
  type ConfigAvisMesh,
} from '../../../src/shared/avis-mesh-api.js';
import { useConfirmation } from './AttenteConfirmation.js';
import { useEffect, useState } from 'react';
import { validerQuestionMesh } from '../../../src/shared/charter-avis.js';
import {
  demanderAvisMesh,
  ETATS_AVIS,
  type EcheancesAvisMesh,
  type DemandeAvisMesh,
} from '../data/avis-mesh.js';
import { useBoardCard } from '../data/board.js';
import { useCells } from '../data/swarph.js';
import { useAid, useAidClient } from '../data/useAidState.js';

export function daterEcheances(heures: {
  positions: number;
  rebuttal: number;
  vote: number;
}): EcheancesAvisMesh {
  let fin = Date.now();
  return Object.fromEntries(
    Object.entries(heures).map(([tour, duree]) => {
      fin += duree * 3600000;
      return [tour, new Date(fin).toISOString()];
    }),
  ) as unknown as EcheancesAvisMesh;
}
export function DureesAvis({
  heures,
  onChange,
}: {
  heures: { positions: number; rebuttal: number; vote: number };
  onChange: (h: typeof heures) => void;
}) {
  return (
    <>
      {(['positions', 'rebuttal', 'vote'] as const).map((tour) => (
        <label key={tour}>
          Durée {tour} (heures){' '}
          <input
            type="number"
            min="1"
            max="168"
            value={heures[tour]}
            onChange={(e) => onChange({ ...heures, [tour]: Number(e.target.value) })}
          />
        </label>
      ))}
    </>
  );
}

function TitreCarte({
  numero,
  mesh,
  onCarte,
}: {
  numero: number;
  mesh: string;
  onCarte: (numero: number) => void;
}) {
  const lecture = useBoardCard(numero, mesh);
  const carte = lecture.result?.card;
  // Le titre et l'autorisation d'envoi proviennent de la même réponse, pour ce numéro.
  return (
    <>
      <p>{carte?.ok && carte.data.id === numero ? carte.data.title : 'carte inconnue'}</p>
      <button
        type="button"
        disabled={!carte?.ok || carte.data.id !== numero}
        onClick={() => onCarte(numero)}
      >
        Confirmer la carte
      </button>
      {lecture.erreur && <p role="alert">{lecture.erreur}</p>}
    </>
  );
}
export function FormulaireAvisMesh(props: { mesh: string; onResultat?: () => void }) {
  const mesh = props.mesh;
  return <FormulaireAvis key={mesh} {...props} mesh={mesh} />;
}
function FormulaireAvis({ mesh, onResultat }: { mesh: string; onResultat?: () => void }) {
  const client = useAidClient();
  const confirmation = useConfirmation(onResultat, true);
  const [config, setConfig] = useState<ConfigAvisMesh | null>(null);
  const { state } = useAid();
  const lecture = useCells(mesh);
  const [question, setQuestion] = useState('');
  const [cells, setCells] = useState<string[]>([]);
  const [numero, setNumero] = useState('');
  const [carte, setCarte] = useState<number | null>(null);
  const [heures, setHeures] = useState({ positions: 24, rebuttal: 1, vote: 1 });
  const [attente, setAttente] = useState(false);
  const [erreur, setErreur] = useState('');
  const [resultat, setResultat] = useState<DemandeAvisMesh | null>(null);
  useEffect(() => {
    void client
      .request<ConfigAvisMesh>('GET', cheminMesh('/api/avis-mesh/config', mesh))
      .then(setConfig, (e) => setErreur(String(e.message)));
  }, [client, mesh]);
  const connectee = instantaneMesh(state, mesh)?.state.connected === true;
  const pairs = lecture.result?.peers;
  const noms = pairs?.ok
    ? [...new Set(pairs.data.map((p) => p.nom))].filter(
        (nom) => nom !== config?.cellAid && nom !== config?.baseline,
      )
    : [];
  const choisies = cells.filter((nom) => noms.includes(nom));
  const validation = validerQuestionMesh(question);
  let erreurFamilles = '';
  if (config && choisies.length >= 2) {
    try {
      siegesAvis({ ...config, baseline: config.baseline ?? undefined, cells: choisies });
    } catch (e) {
      erreurFamilles = (e as Error).message;
    }
  }
  const raison = !config?.baseline
    ? 'baseline non configuré'
    : erreurFamilles
      ? erreurFamilles
      : !connectee
        ? 'La cell doit être connectée.'
        : !question.trim()
          ? 'Écris une question.'
          : !validation.ok
            ? `Question refusée : ${validation.classe}`
            : choisies.length < 2 || choisies.length > 8
              ? 'Choisis de 2 à 8 cells.'
              : carte !== Number(numero) || carte === null
                ? 'Choisis une carte connue et confirme son titre.'
                : Object.entries(heures).some(([, h]) => !Number.isFinite(h) || h < 1 || h > 168)
                  ? 'Chaque échéance doit être comprise entre 1 h et 7 j.'
                  : '';
  async function envoyer() {
    if (raison || attente || carte === null) return;
    setAttente(true);
    setErreur('');
    const echeances = daterEcheances(heures);
    try {
      const r = await demanderAvisMesh(
        { mesh, question, cells: choisies, carte, echeances },
        client,
      );
      setResultat(r);
      confirmation.recevoir(r);
      onResultat?.();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    } finally {
      setAttente(false);
    }
  }
  return (
    <>
      {resultat ? (
        <>
          <p role="status">
            Demande {resultat.id} — {ETATS_AVIS[resultat.etat] ?? resultat.etat}
          </p>
          {resultat.apercu && (
            <section aria-label="Aperçu exact">
              <EnteteMesh mesh={mesh} />
              <p>{resultat.apercu.nom}</p>
              {resultat.apercu.sieges.map((s) => (
                <p key={s.peer}>
                  {s.peer} — {s.role} — {s.family}
                </p>
              ))}
              <p>Carte {resultat.apercu.carte}</p>
              {Object.entries(resultat.apercu.echeances).map(([tour, date]) => (
                <p key={tour}>
                  {tour} : {date}
                </p>
              ))}
              <pre>{resultat.apercu.texte}</pre>
            </section>
          )}
          {confirmation.attente}
        </>
      ) : (
        <>
          <fieldset disabled={attente}>
            <label>
              Question <textarea value={question} onChange={(e) => setQuestion(e.target.value)} />
            </label>
            <p>Numérote les sous-questions : 1. 2. 3.</p>
            <fieldset>
              <legend>Cells</legend>
              {noms.map((nom) => (
                <label key={nom}>
                  <input
                    type="checkbox"
                    aria-label={nom}
                    checked={choisies.includes(nom)}
                    disabled={
                      !FAMILLES_AVIS.includes(
                        config?.familles[nom]?.toLowerCase() as (typeof FAMILLES_AVIS)[number],
                      ) ||
                      (choisies.length >= 8 && !choisies.includes(nom))
                    }
                    onChange={(e) =>
                      setCells(
                        e.target.checked ? [...choisies, nom] : choisies.filter((n) => n !== nom),
                      )
                    }
                  />
                  <span>
                    <AvatarCell nom={nom} cellLocale={instantaneMesh(state, mesh)?.state.cell} />
                    {nom}
                  </span>
                  <span>
                    {' '}
                    — {config?.familles[nom] ?? 'Famille manquante : cette cell ne peut pas siéger'}
                  </span>
                </label>
              ))}
            </fieldset>
            <label>
              Numéro de carte{' '}
              <input
                type="number"
                min="1"
                step="1"
                value={numero}
                onChange={(e) => {
                  setNumero(e.target.value);
                  setCarte(null);
                }}
              />
            </label>
            {Number.isSafeInteger(Number(numero)) && Number(numero) > 0 && (
              <TitreCarte mesh={mesh} key={numero} numero={Number(numero)} onCarte={setCarte} />
            )}
            <DureesAvis heures={heures} onChange={setHeures} />
          </fieldset>
          <p>
            Le texte part dans le mesh, vers les cells choisies et le gateway. N’y mets ni secret,
            ni contenu de carte, ni nom de client.
          </p>
          {raison && <p role="status">{raison}</p>}
          <button disabled={!!raison || attente} onClick={() => void envoyer()}>
            Envoyer
          </button>
        </>
      )}
      {lecture.erreur && <p role="alert">{lecture.erreur}</p>}
      {erreur && <p role="alert">{erreur}</p>}
    </>
  );
}

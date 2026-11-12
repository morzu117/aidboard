import { useState } from 'react';
import type { ResultatAvisMesh } from '../data/avis-mesh.js';

const etats = {
  ok: 'ok',
  scelle: 'scellé par le gateway',
  absent: 'absent',
  attendu: 'en attente',
  abstention: 'abstention',
  secret_suspecte: 'secret suspecté',
  invalide: 'invalide',
};
const priorite = { partage: 0, insuffisant: 1, majorite: 2, unanime: 3 };
export function TableauAvisMesh({ resultat }: { resultat: ResultatAvisMesh }) {
  const [tri, setTri] = useState('accord');
  const accord = (n: number) => resultat.accord.find((a) => a.n === n)?.accord ?? 'insuffisant';
  const lignes = [...resultat.sous_questions].sort((a, b) =>
    tri === 'numeros' ? a.n - b.n : priorite[accord(a.n)] - priorite[accord(b.n)] || a.n - b.n,
  );
  return (
    <section aria-label="Tableau des avis mesh">
      <p>Phase : {resultat.phase}</p>
      <dl>
        {Object.entries(resultat.echeances).map(([tour, date]) => (
          <div key={tour}>
            <dt>{tour}</dt>
            <dd>
              <time dateTime={date}>{date}</time>
            </dd>
          </div>
        ))}
      </dl>
      <label>
        Trier les sous-questions{' '}
        <select value={tri} onChange={(e) => setTri(e.target.value)}>
          <option value="accord">Par accord</option>
          <option value="numeros">Par numéro</option>
        </select>
      </label>
      <table>
        <caption>Avis par sous-question</caption>
        <thead>
          <tr>
            <th scope="col">Sous-question</th>
            {resultat.avis.map((avis) => (
              <th scope="col" key={avis.i}>
                {avis.cell} <span className="pastille pastille--discret">{etats[avis.etat]}</span>
                {avis.vote_scelle && <p>Vote : scellé par le gateway</p>}
                {avis.vote_pris_en_compte && <p>Vote pris en compte à la place de la position</p>}
                {avis.etat === 'invalide' && avis.brut !== null && (
                  <details>
                    <summary>Réponse brute</summary>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{avis.brut}</div>
                  </details>
                )}
              </th>
            ))}
            <th scope="col">Accord</th>
          </tr>
        </thead>
        <tbody>
          {lignes.map((ligne) => (
            <tr key={ligne.n}>
              <th scope="row">
                {ligne.n}. {ligne.texte}
              </th>
              {resultat.avis.map((avis) => {
                const reponse = avis.reponses.find((r) => r.n === ligne.n);
                return (
                  <td key={avis.i}>
                    <span className="pastille pastille--discret">
                      {reponse?.verdict ?? (avis.etat === 'ok' ? 'manquant' : etats[avis.etat])}
                    </span>
                    {reponse?.justification && (
                      <details>
                        <summary>Justification</summary>
                        <div style={{ whiteSpace: 'pre-wrap' }}>{reponse.justification}</div>
                      </details>
                    )}
                  </td>
                );
              })}
              <td>{accord(ligne.n)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {resultat.rebuttals.map((r, i) => (
        <p key={i} style={{ whiteSpace: 'pre-wrap' }}>
          {r.cell} : {r.texte ?? 'scellé par le gateway'}
        </p>
      ))}
    </section>
  );
}

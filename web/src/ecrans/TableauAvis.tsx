import { useState } from 'react';
import type { Ask, AskResult } from '../../../src/shared/swairm-ask.js';

const etats = {
  absent: 'Swairm absent',
  'too-old': 'Swairm trop ancien, ask manquant',
  timeout: 'Délai dépassé',
  annule: 'Annulé',
  format: 'Réponse illisible',
  unknown: 'Réponse illisible',
  'aucun-avis': 'Aucun avis valide',
};
const priorite = { partage: 0, insuffisant: 1, majorite: 2, unanime: 3 };
export function TableauAvis({ resultat }: { resultat: AskResult<Ask> }) {
  const [tri, setTri] = useState('accord');
  const demande = 'data' in resultat ? resultat.data : null;
  const lignes = demande ? [...demande.sous_questions] : [];
  const accord = (n: number) => demande?.accord.find((a) => a.n === n)?.accord ?? 'insuffisant';
  lignes.sort((a, b) =>
    tri === 'numeros' ? a.n - b.n : priorite[accord(a.n)] - priorite[accord(b.n)] || a.n - b.n,
  );
  return (
    <section aria-label="Tableau des avis">
      {!resultat.ok && (
        <p role="status">
          {resultat.kind === 'refusee'
            ? `Question refusée : ${resultat.message}`
            : etats[resultat.kind]}
        </p>
      )}
      {demande && (
        <>
          <p style={{ whiteSpace: 'pre-wrap' }}>{demande.question}</p>
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
                {demande.avis.map((avis) => (
                  <th scope="col" key={avis.i}>
                    {avis.modele_servi ?? avis.modele_demande} —{' '}
                    {avis.etat === 'budget' ? 'Budget atteint' : avis.etat}
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
                  {demande.avis.map((avis) => {
                    const reponse = avis.reponses.find((r) => r.n === ligne.n);
                    return (
                      <td key={avis.i}>
                        <span className="pastille pastille--discret">
                          {reponse?.verdict ?? 'manquant'}
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
            <tfoot>
              <tr>
                <td colSpan={demande.avis.length + 2}>
                  Coût total : {demande.cout_total_usd.toFixed(2)} USD
                </td>
              </tr>
            </tfoot>
          </table>
        </>
      )}
    </section>
  );
}

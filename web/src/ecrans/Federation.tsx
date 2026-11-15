import { useState } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { requeteCodegraphValide } from '../../../src/shared/swarph.js';
import { useFederation } from '../data/swarph.js';
import { useAid } from '../data/useAidState.js';
import { Layout } from '../ui/Layout.js';
import { OngletsSwarph } from '../ui/OngletsSwarph.js';
import { EtatsSwarph376, LectureSwarph376 } from './EtatsSwarph376.js';

function raisonRequete(texte: string) {
  if (!texte.length) return 'Saisis une requête.';
  if (texte.length > 200) return 'La requête est limitée à 200 caractères.';
  if (texte.startsWith('-')) return 'La requête ne doit pas commencer par « - ».';
  if (!requeteCodegraphValide(texte))
    return 'La requête ne doit pas contenir de caractère de contrôle.';
  return null;
}

function ContenuFederation() {
  const [params, setParams] = useSearchParams();
  const soumise = params.get('q') ?? '';
  const [texte, setTexte] = useState(soumise);
  const lecture = useFederation(soumise);
  const raison = raisonRequete(texte);
  return (
    <main className="page" data-node="federation">
      <OngletsSwarph />
      <h1 className="titre-ecran">Federation</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (raison || lecture.enLecture) return;
          if (texte === soumise) void lecture.relire();
          else setParams({ q: texte });
        }}
      >
        <label htmlFor="federation-requete">Requête</label>
        <input
          id="federation-requete"
          data-node="federation.requete"
          value={texte}
          onChange={(event) => setTexte(event.target.value)}
          aria-describedby="federation-raison"
        />
        <button
          type="submit"
          className="bouton"
          data-node="federation.chercher"
          disabled={!!raison || lecture.enLecture}
        >
          Chercher
        </button>
        <p id="federation-raison" data-node="federation.raison">
          {raison}
        </p>
      </form>
      <LectureSwarph376
        {...lecture}
        node="federation"
        desactive={!requeteCodegraphValide(soumise)}
      />
      <EtatsSwarph376 {...lecture} node="federation" />
      {lecture.result?.ok && (
        <>
          {lecture.result.data.perime && (
            <p data-node="federation.perime">Index périmé : les numéros de ligne ont pu bouger</p>
          )}
          {!lecture.result.data.lignes.length && <p data-node="federation.vide">Aucun résultat.</p>}
          <ul>
            {lecture.result.data.lignes.map((ligne, index) => (
              <li
                key={`${ligne.repo}:${ligne.file_path}:${ligne.start_line}:${ligne.name}:${index}`}
                data-node={`federation.resultat-${index}`}
              >
                <h2>{ligne.qualified_name ?? ligne.name}</h2>
                <p>
                  {ligne.kind} · {ligne.repo} · {ligne.file_path}:{ligne.start_line} ·{' '}
                  {ligne.callers ?? 0} appelants
                </p>
                <pre style={{ whiteSpace: 'pre-wrap' }}>{ligne.signature}</pre>
                {ligne.docstring && (
                  <details>
                    <summary>Docstring</summary>
                    <p style={{ whiteSpace: 'pre-wrap' }}>{ligne.docstring}</p>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

export function Federation() {
  const [params] = useSearchParams();
  const { state } = useAid();
  if (state && !state.mesh && !Object.keys(state.meshes ?? {}).length)
    return <Navigate to="/swarph" replace />;
  return (
    <Layout screen="board">
      {(state?.mesh || Object.keys(state?.meshes ?? {}).length) && (
        <ContenuFederation key={params.get('q') ?? ''} />
      )}
    </Layout>
  );
}

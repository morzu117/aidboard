import { useId, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { slugValide, tagValide, typeValide } from '../../../src/shared/swarph.js';
import { useMemoire, usePageMemoire } from '../data/swarph.js';
import { useAid } from '../data/useAidState.js';
import { Layout } from '../ui/Layout.js';
import { OngletsSwarph } from '../ui/OngletsSwarph.js';
import { EtatsSwarph376, LectureSwarph376 } from './EtatsSwarph376.js';

function ContenuMemoire() {
  const [params, setParams] = useSearchParams();
  const slug = params.get('page') ?? '';
  const [tag, setTag] = useState('');
  const id = useId();
  const [filtre, setFiltre] = useState('tous');
  // Le filtre n'est lu qu'à la soumission.
  const [soumis, setSoumis] = useState<{ tag: string; type: string } | null>(null);
  const liste = useMemoire(soumis?.tag ?? null, soumis?.type);
  const valide = filtre === 'tous' || (filtre === 'tag' ? tagValide(tag) : typeValide(tag));
  const page = usePageMemoire(slug);
  const ouvrir = (valeur: string) => {
    if (slugValide(valeur)) setParams({ page: valeur });
  };
  const navigation = (valeur: string) =>
    slugValide(valeur) ? (
      <button type="button" className="bouton" onClick={() => ouvrir(valeur)}>
        {valeur}
      </button>
    ) : (
      <span>{valeur}</span>
    );
  return (
    <main className="page" data-node="memoire-swarph">
      <OngletsSwarph />
      <h1 className="titre-ecran">Memory</h1>
      <p data-node="memoire-swarph.bandeau">
        Cette mémoire est partagée par tout le mesh pour l&apos;instant. Sa portée se réduira à ta
        cellule.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!valide || liste.enLecture) return;
          const suivant = { tag: filtre === 'tag' ? tag : '', type: filtre === 'type' ? tag : '' };
          if (soumis?.tag === suivant.tag && soumis?.type === suivant.type) void liste.relire();
          else setSoumis(suivant);
        }}
      >
        <label htmlFor={`${id}-filtre`}>Filtre</label>
        <select
          id={`${id}-filtre`}
          value={filtre}
          onChange={(event) => setFiltre(event.target.value)}
        >
          <option value="tous">Tous</option>
          <option value="tag">Par tag</option>
          <option value="type">Par type</option>
        </select>
        {filtre !== 'tous' && (
          <>
            <label htmlFor={`${id}-valeur`}>{filtre === 'tag' ? 'Tag' : 'Type'}</label>
            <input
              id={`${id}-valeur`}
              data-node="memoire-swarph.tag"
              value={tag}
              onChange={(event) => setTag(event.target.value)}
            />
          </>
        )}
        {filtre === 'type' && (
          <p>Le type peut être reclassé par le cerveau ; le tag est plus fiable.</p>
        )}
        <button
          type="submit"
          className="bouton"
          data-node="memoire-swarph.lister"
          disabled={!valide || liste.enLecture}
        >
          Lister
        </button>
        {!valide && filtre === 'tag' && (
          <p data-node="memoire-swarph.raison">
            Saisis un tag de 1 à 200 caractères : lettres, chiffres, point, soulignement,
            deux-points, barre oblique ou tiret.
          </p>
        )}
        {!valide && filtre === 'type' && (
          <p data-node="memoire-swarph.raison">
            Saisis un type de 1 à 64 caractères : minuscules, chiffres, soulignement ou tiret, en
            commençant par une lettre.
          </p>
        )}
      </form>
      <LectureSwarph376 {...liste} node="memoire-swarph.liste" desactive={soumis === null} />
      <EtatsSwarph376 {...liste} node="memoire-swarph.liste" memoire />
      {liste.result?.ok && (
        <ul data-node="memoire-swarph.liste">
          {liste.result.data.map((resume) => (
            <li key={resume.slug}>
              {navigation(resume.slug)} {resume.title}
            </li>
          ))}
        </ul>
      )}
      {slug && (
        <section data-node="memoire-swarph.page">
          {!slugValide(slug) && <p>Slug invalide.</p>}
          <LectureSwarph376 {...page} node="memoire-swarph.page" desactive={!slugValide(slug)} />
          <EtatsSwarph376
            result={page.result?.page ?? null}
            erreur={page.erreur}
            relire={page.relire}
            node="memoire-swarph.page"
            memoire
          />
          {page.result?.page.ok && (
            <>
              <h2>{page.result.page.data.title ?? slug}</h2>
              <div data-node="memoire-swarph.corps" style={{ whiteSpace: 'pre-wrap' }}>
                {page.result.page.data.content}
              </div>
            </>
          )}
          <EtatsSwarph376
            result={page.result?.links ?? null}
            erreur={null}
            relire={page.relire}
            node="memoire-swarph.liens"
            memoire
          />
          {page.result?.links.ok && (
            <>
              <h2>Liens entrants et sortants</h2>
              <ul data-node="memoire-swarph.liens">
                {page.result.links.data.map((lien, index) => (
                  <li
                    key={`${lien.from}:${lien.to}:${index}`}
                    data-node={`memoire-swarph.lien-${index}`}
                  >
                    {navigation(lien.from === slug ? lien.to : lien.from)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </main>
  );
}

export function MemoireSwarph() {
  const { state } = useAid();
  if (state && !state.mesh && !Object.keys(state.meshes ?? {}).length)
    return <Navigate to="/swarph" replace />;
  return (
    <Layout screen="board">
      {(state?.mesh || Object.keys(state?.meshes ?? {}).length) && <ContenuMemoire />}
    </Layout>
  );
}

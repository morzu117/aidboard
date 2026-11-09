import { useState } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { slugValide, tagValide } from '../../../src/shared/swarph.js';
import { useMemoire, usePageMemoire } from '../data/swarph.js';
import { useAid } from '../data/useAidState.js';
import { Layout } from '../ui/Layout.js';
import { OngletsSwarph } from '../ui/OngletsSwarph.js';
import { EtatsSwarph376, LectureSwarph376 } from './EtatsSwarph376.js';

function ContenuMemoire() {
  const [params, setParams] = useSearchParams();
  const slug = params.get('page') ?? '';
  const [tag, setTag] = useState('');
  // le tag n'est lu qu'à la soumission, pour ne pas lancer swarph à chaque frappe
  const [tagSoumis, setTagSoumis] = useState('');
  const liste = useMemoire(tagSoumis);
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
          if (!tagValide(tag) || liste.enLecture) return;
          if (tag === tagSoumis) void liste.relire();
          else setTagSoumis(tag);
        }}
      >
        <label htmlFor="memoire-tag">Tag</label>
        <input
          id="memoire-tag"
          data-node="memoire-swarph.tag"
          value={tag}
          onChange={(event) => setTag(event.target.value)}
        />
        <button
          type="submit"
          className="bouton"
          data-node="memoire-swarph.lister"
          disabled={!tagValide(tag) || liste.enLecture}
        >
          Lister
        </button>
        {!tagValide(tag) && (
          <p data-node="memoire-swarph.raison">
            Saisis un tag de 1 à 200 caractères : lettres, chiffres, point, soulignement,
            deux-points, barre oblique ou tiret.
          </p>
        )}
      </form>
      <LectureSwarph376 {...liste} node="memoire-swarph.liste" desactive={!tagValide(tagSoumis)} />
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
  if (state && !state.mesh) return <Navigate to="/swarph" replace />;
  return <Layout screen="board">{state?.mesh && <ContenuMemoire />}</Layout>;
}

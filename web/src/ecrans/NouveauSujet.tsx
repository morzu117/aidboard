import { type FormEvent, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import type { TopicType } from '../../../src/shared/model.js';
import { slugify } from '../../../src/shared/slug.js';
import { AidApiError } from '../data/api.js';
import { useAid } from '../data/useAidState.js';
import { Layout, useLayout } from '../ui/Layout.js';

// Chantier 28 (D141, D142) : Nouveau sujet devient un écran, `/sujets/nouveau?projet=`. Le projet vit dans l'URL :
// « Ajouter un projet… » y revient avec le projet enregistré, sans état resté d'avant.

const TYPES: TopicType[] = ['feat', 'fix', 'chore', 'spike'];

function Contenu() {
  const { state, call } = useAid();
  const { addWorkspaceThenTopic } = useLayout();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const workspaces = state?.workspaces ?? [];
  // sans projet dans l'URL, le dernier enregistré : on vient en général de l'ajouter
  const latest = [...workspaces].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  const workspace = workspaces.find((w) => w.id === params.get('projet')) ?? latest;
  const [title, setTitle] = useState('');
  const [type, setType] = useState<TopicType>('feat');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const n = (rest: string) => `nouveau-sujet.${rest}`;

  const slug = useMemo(() => {
    try {
      return slugify(title);
    } catch {
      return null;
    }
  }, [title]);

  // D141 : Annuler revient d'où l'on vient ; arrivé directement sur l'URL, à l'accueil
  const annuler = () => (location.key !== 'default' ? navigate(-1) : navigate('/'));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!workspace) return;
    setError(null);
    setSubmitting(true);
    try {
      // D15 : le sujet existe en draft dès cette requête ; l'écran Sujet suit topic.create
      const r = await call<{ topicId: string }>('POST', '/api/topics', {
        workspaceId: workspace.id,
        title: title.trim(),
        type,
      });
      navigate(`/sujets/${r.topicId}`, { replace: true });
    } catch (err) {
      setError(err instanceof AidApiError ? err.message : String(err));
      setSubmitting(false);
    }
  }

  const running = submitting;
  return (
    <main className="page nouveau-sujet" data-node={n('page')}>
      <div className="entete" data-node={n('entete')}>
        <h1 className="titre-ecran" data-node={n('titre')}>
          Nouveau sujet
        </h1>
      </div>
      <form
        id="nouveau-sujet-formulaire"
        className="nouveau-sujet-colonnes"
        aria-label="Créer un sujet"
        onSubmit={submit}
      >
        <section className="nouveau-sujet-carte" data-node={n('besoin')} aria-label="Le besoin">
          <h2 className="titre-zone" data-node={n('besoin.titre')}>
            1 · Le besoin
          </h2>
          {state && workspaces.length === 0 ? (
            <div className="nouveau-sujet-sans-projet" data-node={n('besoin.sans-projet')}>
              <p className="texte-discret">Aucun projet : un sujet part d’un dépôt enregistré.</p>
              <button
                className="bouton bouton--primaire"
                data-node={n('besoin.ajouter-projet')}
                data-action="workspace.ajouter"
                type="button"
                onClick={() => addWorkspaceThenTopic?.()}
              >
                Ajouter un projet…
              </button>
            </div>
          ) : (
            <>
              <div className="nouveau-sujet-ligne">
                <label className="nouveau-sujet-champ">
                  Projet
                  <select
                    className="selecteur"
                    data-node={n('besoin.projet')}
                    value={workspace?.id ?? ''}
                    onChange={(e) => setParams({ projet: e.target.value }, { replace: true })}
                    disabled={running}
                  >
                    {workspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="nouveau-sujet-champ">
                  Type
                  <select
                    className="selecteur"
                    data-node={n('besoin.type')}
                    value={type}
                    onChange={(e) => setType(e.target.value as TopicType)}
                    disabled={running}
                  >
                    {TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <button
                className="bouton bouton--fantome nouveau-sujet-ajouter"
                data-node={n('besoin.ajouter-projet')}
                data-action="workspace.ajouter"
                type="button"
                onClick={() => addWorkspaceThenTopic?.()}
                disabled={running}
              >
                Ajouter un projet…
              </button>
              <label className="nouveau-sujet-champ">
                Titre
                <input
                  className="champ"
                  data-node={n('besoin.titre-sujet')}
                  value={title}
                  placeholder="Ce que tu veux explorer"
                  onChange={(e) => setTitle(e.target.value)}
                  disabled={running}
                  autoFocus
                />
              </label>
              <p className="nouveau-sujet-git">
                <span data-node={n('besoin.branche')} data-bind="apercu.branche">
                  Branche : <code>{slug ? `${type}/${slug}` : `${type}/(titre à saisir)`}</code>
                </span>
                {workspace && (
                  <span data-node={n('besoin.base')} data-bind="projet.base">
                    Base : <code>{workspace.baseBranch}</code>
                  </span>
                )}
              </p>
              <div className="nouveau-sujet-local" data-node={n('besoin.local')}>
                <span className="nouveau-sujet-local-badge">○ local</span>
                <p>
                  Ce sujet reste sur cette machine. Aucune autre machine ne le retrouvera tant que
                  tu ne l’auras pas publié.
                </p>
              </div>
            </>
          )}
        </section>
      </form>
      {error && (
        <p className="message-erreur" role="alert" data-node={n('erreur')}>
          {error}
        </p>
      )}
      <div className="nouveau-sujet-pied" data-node={n('pied')}>
        <p className="texte-discret" data-node={n('pied.effet')}>
          À la création : rien n’est publié. Tu pourras publier plus tard.
        </p>
        <button
          className="bouton"
          data-node={n('pied.annuler')}
          data-action="nav.retour"
          type="button"
          onClick={annuler}
        >
          Annuler
        </button>
        <button
          className="bouton bouton--primaire"
          data-node={n('pied.creer')}
          data-action="sujet.creer"
          type="submit"
          form="nouveau-sujet-formulaire"
          disabled={running || !slug || !workspace}
        >
          {running ? 'Création…' : 'Créer le sujet'}
        </button>
      </div>
    </main>
  );
}

export function NouveauSujet() {
  return (
    <Layout screen="nouveau-sujet">
      <Contenu />
    </Layout>
  );
}

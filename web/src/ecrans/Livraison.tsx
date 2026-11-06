import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { LivraisonGit } from '../../../src/shared/git.js';
import type { Topic } from '../../../src/shared/model.js';
import { Dialogue } from '../dialogues/Dialogue.js';
import { AidApiError } from '../data/api.js';
import { useActionSuivie, useLivraison } from '../data/livraison.js';
import { usePlacement } from '../data/placement.js';
import { useAid } from '../data/useAidState.js';
import { Bandeau } from '../ui/Bandeau.js';
import { Layout } from '../ui/Layout.js';
import { court, type PrLue } from '../ui/livraisonVue.js';

// Chantier 27 (D121) : peut-on livrer cette tête Git, et sur quelles preuves ?

export function Livraison() {
  const { topicId = '' } = useParams();
  return (
    <Layout screen="livraison">
      <Contenu topicId={topicId} />
    </Layout>
  );
}

function Contenu({ topicId }: { topicId: string }) {
  const { state } = useAid();
  const topic = state?.topics.find((t) => t.id === topicId);
  if (!state)
    return (
      <main className="page">
        <p className="texte-discret">Chargement…</p>
      </main>
    );
  if (!topic)
    return (
      <main className="page" data-node="livraison.introuvable">
        <p className="texte-discret">Ce sujet n’existe pas, ou plus.</p>
        <Link className="bouton" to="/">
          Revenir à l’accueil
        </Link>
      </main>
    );
  return <Ecran topic={topic} />;
}

const pluriel = (n: number, mot: string) => `${n} ${mot}${n > 1 ? 's' : ''}`;

function Ecran({ topic }: { topic: Topic }) {
  const placement = usePlacement(topic.id);
  const nom = placement?.displayName ?? topic.title;
  const l = useLivraison(topic, null);
  const tete = l.pr?.headRefOid ?? l.git?.head ?? null;
  const base = l.pr?.baseRefName ?? topic.base;
  const fusionne = topic.state === 'merged' || l.pr?.state === 'MERGED';

  return (
    <main className="page livraison" data-node="livraison">
      <header className="entete livraison-entete" data-node="livraison.entete">
        <div className="entete-texte">
          <p className="fil-ariane" data-node="livraison.fil-ariane">
            <Link data-node="livraison.fil-ariane.sujet" to={`/sujets/${topic.id}`}>
              {nom}
            </Link>{' '}
            / livraison
          </p>
          <h1 className="titre-ecran" data-node="livraison.titre">
            {tete ? (
              <>
                Peut-on livrer <code className="livraison-sha">{court(tete)}</code> ?
              </>
            ) : (
              'Peut-on livrer ce sujet ?'
            )}
          </h1>
          <p className="livraison-contexte" data-node="livraison.contexte">
            {topic.branch} → {base}
            {l.git?.empreinte && ` · diff ${l.git.empreinte}`}
            {l.git?.mergeBase &&
              ` · ${pluriel(l.git.files.length, 'fichier')} · +${l.git.additions} −${l.git.deletions}`}
          </p>
        </div>
        <div className="livraison-actions" data-node="livraison.actions">
          {topic.prNumber !== null && !topic.worktreeMissing && (
            <button
              className="bouton bouton--fantome"
              type="button"
              data-node="livraison.relire"
              disabled={l.lecturePr.enCours}
              onClick={l.relire}
            >
              {l.lecturePr.enCours ? 'Lecture de la PR…' : 'Relire la PR'}
            </button>
          )}
        </div>
      </header>

      {topic.worktreeMissing && (
        <Bandeau ton="rouge" constat="Worktree introuvable" node="livraison.sans-worktree">
          Rien ne peut être lu ni livré tant que le worktree du sujet manque.
        </Bandeau>
      )}
      {l.lecturePr.echec && (
        <Bandeau ton="rouge" constat="La PR n’a pas pu être relue" node="livraison.lecture-pr">
          {l.lecturePr.echec}
        </Bandeau>
      )}
      {l.erreurGit && (
        <Bandeau ton="rouge" constat="Le dépôt n’a pas pu être lu" node="livraison.lecture-git">
          {l.erreurGit}
        </Bandeau>
      )}
      {!fusionne && <BandeauTete topicId={topic.id} pr={l.pr} git={l.git} onPousse={l.relire} />}

      <div className="livraison-corps">
        <section className="livraison-principal">
          <Fichiers topicId={topic.id} base={base} git={l.git} />
        </section>
        <aside className="livraison-cote">
          <Trace topic={topic} nom={nom} base={base} fusionne={fusionne} />
        </aside>
      </div>
    </main>
  );
}

/** D122 : la tête locale n'est pas celle de la PR ; Pousser, puis relire. */
function BandeauTete({
  topicId,
  pr,
  git,
  onPousse,
}: {
  topicId: string;
  pr: PrLue | null;
  git: LivraisonGit | null;
  onPousse: () => void;
}) {
  const pousser = useActionSuivie(topicId);
  const fini = pousser.reussi ? pousser.run?.id : undefined;
  useEffect(() => {
    if (fini) onPousse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fini]);
  if (!pr?.headRefOid || !git?.head || pr.headRefOid === git.head) return null;
  return (
    <Bandeau
      ton="ambre"
      constat={`La tête locale ${court(git.head)} n’est pas sur la PR`}
      node="livraison.tete-locale"
      action={{
        label: pousser.enCours ? 'Envoi…' : 'Pousser',
        enCours: pousser.enCours,
        onClick: () => void pousser.lancer('git.pousser'),
      }}
    >
      La PR porte {court(pr.headRefOid)}. Ce qui se livre est ce qui est sur la PR.
      {pousser.echec && (
        <span role="alert" data-node="livraison.tete-locale.erreur">
          {' '}
          {pousser.echec}
        </span>
      )}
    </Bandeau>
  );
}

const STATUT: Record<string, string> = { A: 'ajouté', M: 'modifié', D: 'supprimé' };

/** Q5 : la liste des fichiers ; chacun ouvre son diff `base...tête` dans l'éditeur (D135). */
function Fichiers({
  topicId,
  base,
  git,
}: {
  topicId: string;
  base: string;
  git: LivraisonGit | null;
}) {
  const { call } = useAid();
  const [erreur, setErreur] = useState<string | null>(null);
  const ouvrir = async (path: string) => {
    if (!git?.head || !git.mergeBase) return;
    setErreur(null);
    try {
      await call('POST', `/api/topics/${topicId}/actions/diff.ouvrir-fichier`, {
        hash: git.head,
        depuis: git.mergeBase,
        path,
      });
    } catch (err) {
      setErreur(err instanceof AidApiError ? err.message : String(err));
    }
  };
  return (
    <div className="livraison-bloc" data-node="livraison.fichiers">
      <h2 className="livraison-bloc-titre">Le changement</h2>
      {!git ? (
        <p className="texte-discret">Lecture du dépôt…</p>
      ) : !git.mergeBase ? (
        <p className="texte-discret" data-node="livraison.fichiers.sans-base">
          origin/{base} est introuvable : faire un fetch depuis l’onglet Git du sujet.
        </p>
      ) : git.files.length === 0 ? (
        <p className="texte-discret" data-node="livraison.fichiers.vide">
          Aucun changement par rapport à origin/{base}.
        </p>
      ) : (
        <ul className="livraison-fichiers">
          {git.files.map((f, i) => (
            <li key={f.path}>
              <button
                className="livraison-fichier"
                type="button"
                data-node={`livraison.fichiers.fichier-${i}`}
                title="Ouvrir le diff dans l’éditeur"
                onClick={() => void ouvrir(f.path)}
              >
                <span className={`livraison-fichier-statut livraison-fichier-statut--${f.status}`}>
                  {STATUT[f.status] ?? f.status}
                </span>
                <span className="livraison-fichier-chemin">{f.path}</span>
                <span className="livraison-fichier-compte">
                  {f.additions === null ? 'binaire' : `+${f.additions} −${f.deletions ?? 0}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {erreur && (
        <p className="message-erreur" role="alert" data-node="livraison.fichiers.erreur">
          {erreur}
        </p>
      )}
    </div>
  );
}

/** D132 : la seule ligne de trace qu'A-I-D connaît, la PR. */
function Trace({
  topic,
  nom,
  base,
  fusionne,
}: {
  topic: Topic;
  nom: string;
  base: string;
  fusionne: boolean;
}) {
  const [ouvrir, setOuvrir] = useState(false);
  return (
    <div className="livraison-bloc" data-node="livraison.trace">
      <h2 className="livraison-bloc-titre">Trace publiée</h2>
      <p className="livraison-trace-ligne" data-node="livraison.trace.pr">
        <span>PR vers {base}</span>
        {fusionne ? (
          <span className="livraison-trace-etat livraison-trace-etat--fait">● fusionnée</span>
        ) : topic.prNumber !== null ? (
          topic.prUrl ? (
            <a
              className="livraison-trace-etat livraison-trace-etat--fait"
              href={topic.prUrl}
              target="_blank"
              rel="noreferrer"
            >
              ● #{topic.prNumber} ouverte
            </a>
          ) : (
            <span className="livraison-trace-etat livraison-trace-etat--fait">
              ● #{topic.prNumber} ouverte
            </span>
          )
        ) : (
          <span className="livraison-trace-etat">○ à créer</span>
        )}
      </p>
      {!fusionne && topic.prNumber === null && (
        <button
          className="bouton"
          type="button"
          data-node="livraison.trace.ouvrir-pr"
          disabled={topic.worktreeMissing}
          onClick={() => setOuvrir(true)}
        >
          Ouvrir la PR
        </button>
      )}
      {ouvrir && <OuvrirPr topicId={topic.id} nom={nom} onClose={() => setOuvrir(false)} />}
    </div>
  );
}

function OuvrirPr({
  topicId,
  nom,
  onClose,
}: {
  topicId: string;
  nom: string;
  onClose: () => void;
}) {
  const [titre, setTitre] = useState(nom);
  const [description, setDescription] = useState('');
  const pr = useActionSuivie(topicId);
  const ouverte = pr.reussi;
  useEffect(() => {
    if (ouverte) onClose();
  }, [ouverte, onClose]);
  return (
    <Dialogue titre="Ouvrir la PR" onClose={onClose}>
      <form
        className="livraison-dialogue"
        data-node="livraison.ouvrir-pr"
        onSubmit={(e) => {
          e.preventDefault();
          if (titre.trim()) void pr.lancer('topic.pr', { title: titre.trim(), body: description });
        }}
      >
        <label>
          Titre
          <input
            data-node="livraison.ouvrir-pr.titre"
            value={titre}
            onChange={(e) => setTitre(e.target.value)}
          />
        </label>
        <label>
          Description
          <textarea
            data-node="livraison.ouvrir-pr.description"
            rows={6}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <p className="texte-faible">La branche est poussée sur origin, puis la PR est ouverte.</p>
        {pr.echec && (
          <p className="message-erreur" role="alert" data-node="livraison.ouvrir-pr.erreur">
            {pr.echec}
          </p>
        )}
        <div className="dialogue-actions">
          <button className="bouton bouton--fantome" type="button" onClick={onClose}>
            Annuler
          </button>
          <button
            className="bouton bouton--primaire"
            type="submit"
            data-node="livraison.ouvrir-pr.valider"
            disabled={pr.enCours || !titre.trim()}
          >
            {pr.enCours ? 'Ouverture…' : 'Ouvrir la PR'}
          </button>
        </div>
      </form>
    </Dialogue>
  );
}

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { LivraisonGit } from '../../../src/shared/git.js';
import type { MemoryPage } from '../../../src/shared/memory.js';
import type { Topic } from '../../../src/shared/model.js';
import { ConfirmerMerge } from '../dialogues/ConfirmerMerge.js';
import { Dialogue } from '../dialogues/Dialogue.js';
import { AidApiError } from '../data/api.js';
import { useActionSuivie, useLivraison } from '../data/livraison.js';
import { usePlacement } from '../data/placement.js';
import { useAid } from '../data/useAidState.js';
import { Bandeau } from '../ui/Bandeau.js';
import { Layout } from '../ui/Layout.js';
import {
  blocageMerge,
  citations,
  compterControles,
  type Controle,
  court,
  type Fraicheur,
  libelleFraicheur,
  lireAvis,
  lireControles,
  type PrLue,
  type SourceRevue,
} from '../ui/livraisonVue.js';

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
  const { state } = useAid();
  const placement = usePlacement(topic.id);
  const nom = placement?.displayName ?? topic.title;
  const workspace = state?.workspaces.find((w) => w.id === topic.workspaceId);
  const l = useLivraison(topic, workspace?.namespace ?? workspace?.name ?? '');
  const tete = l.pr?.headRefOid ?? l.git?.head ?? null;
  const base = l.pr?.baseRefName ?? topic.base;
  const fusionne = topic.state === 'merged' || l.pr?.state === 'MERGED';
  const controles = lireControles(l.pr, l.test);
  const compte = compterControles(controles, tete);
  // pendant une lecture (PR, dépôt, revue), le bouton attend sans annoncer de raison
  const enLecture =
    !topic.worktreeMissing &&
    !fusionne &&
    (l.lecturePr.enCours || (!l.git && !l.erreurGit) || l.fraicheur === null);
  const blocage = topic.worktreeMissing
    ? 'le worktree du sujet manque.'
    : enLecture
      ? null
      : blocageMerge({
          fusionne,
          aPr: topic.prNumber !== null,
          pr: l.pr,
          teteLocale: l.git?.head ?? null,
          fraicheur: l.fraicheur ?? { etat: 'aucune' },
        });
  const merge = useActionSuivie(topic.id);
  // D128 : fini, dans un sens ou dans l'autre, l'écran relit ; refusé, le refus reste sous le bouton
  const mergeFini = merge.run && merge.run.state !== 'running' ? merge.run.id : null;
  useEffect(() => {
    if (mergeFini) l.relire();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergeFini]);
  // Le dialogue retient la fusion finie à son ouverture : il se ferme dès qu'une autre l'est.
  const [ouvertSur, setOuvertSur] = useState<string | null | false>(false);
  const confirmer = ouvertSur !== false && (mergeFini === null || mergeFini === ouvertSur);

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
          {!fusionne && (
            <button
              className="bouton bouton--primaire"
              type="button"
              data-node="livraison.autoriser"
              disabled={enLecture || blocage !== null || merge.enCours}
              onClick={() => setOuvertSur(mergeFini)}
            >
              {merge.enCours
                ? 'Fusion en cours…'
                : tete
                  ? `Autoriser le merge de ${court(tete)}`
                  : 'Autoriser le merge'}
            </button>
          )}
          {!fusionne && blocage && (
            <p className="livraison-blocage" data-node="livraison.autoriser.blocage">
              Bloqué : {blocage}
            </p>
          )}
          {merge.echec && (
            <p className="message-erreur" role="alert" data-node="livraison.autoriser.refus">
              {merge.echec}
            </p>
          )}
        </div>
      </header>
      {confirmer && l.pr?.headRefOid && l.fraicheur && !enLecture && blocage === null && (
        <ConfirmerMerge
          tete={l.pr.headRefOid}
          base={base}
          citations={citations(l.fraicheur, compte)}
          enCours={merge.enCours}
          onClose={() => setOuvertSur(false)}
          onConfirmer={(choix) =>
            void merge.lancer('topic.merge', { ...choix, head: l.pr?.headRefOid })
          }
        />
      )}

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

      <div className="livraison-tuiles">
        <TuileControles compte={compte} tete={tete} />
        <TuileRevue fraicheur={l.fraicheur} />
        <TuileAutorisation fusionne={fusionne} enCours={merge.enCours} tete={tete} />
      </div>

      <div className="livraison-corps">
        <section className="livraison-principal">
          <Fichiers topicId={topic.id} base={base} git={l.git} />
          <AvisRevue
            topicId={topic.id}
            page={l.page}
            source={l.source}
            fraicheur={l.fraicheur}
            tete={tete}
          />
        </section>
        <aside className="livraison-cote">
          <Controles
            topicId={topic.id}
            controles={controles}
            compte={compte}
            tete={tete}
            relancable={!fusionne && !topic.worktreeMissing}
          />
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

type Compte = ReturnType<typeof compterControles>;

/** Q7 : succès et pannes des contrôles portés par la tête de l'écran. */
function TuileControles({ compte, tete }: { compte: Compte; tete: string | null }) {
  const parts = [`${compte.passes} passé${compte.passes > 1 ? 's' : ''}`];
  if (compte.pannes > 0) parts.push(`${compte.pannes} panne${compte.pannes > 1 ? 's' : ''}`);
  if (compte.enCours > 0) parts.push(`${compte.enCours} en cours`);
  const ton = compte.pannes > 0 ? 'rouge' : compte.enCours > 0 ? 'ambre' : 'neutre';
  return (
    <div
      className={`livraison-tuile livraison-tuile--${ton}`}
      data-node="livraison.tuile-controles"
      data-ton={ton}
    >
      <p className="livraison-tuile-nom">Contrôles</p>
      <p className="livraison-tuile-valeur" data-node="livraison.tuile-controles.valeur">
        {compte.total === 0 ? 'Aucun contrôle' : parts.join(' · ')}
      </p>
      <p className="livraison-tuile-note" data-node="livraison.tuile-controles.note">
        {tete ? `Exécutés sur ${court(tete)}` : 'Tête inconnue'}
      </p>
    </div>
  );
}

/** Q2, D126 : la fraîcheur de la revue ; ambre si elle ne porte pas sur la tête. */
function TuileRevue({ fraicheur }: { fraicheur: Fraicheur | null }) {
  const { titre, note } = fraicheur
    ? libelleFraicheur(fraicheur)
    : { titre: 'Lecture…', note: 'La revue est en cours de lecture' };
  const ton =
    fraicheur?.etat === 'obsolete' ? 'ambre' : fraicheur?.etat === 'a-jour' ? 'ok' : 'neutre';
  return (
    <div
      className={`livraison-tuile livraison-tuile--${ton}`}
      data-node="livraison.tuile-revue"
      data-ton={ton}
    >
      <p className="livraison-tuile-nom">Revue</p>
      <p className="livraison-tuile-valeur" data-node="livraison.tuile-revue.valeur">
        {titre}
      </p>
      <p className="livraison-tuile-note" data-node="livraison.tuile-revue.note">
        {note}
      </p>
    </div>
  );
}

/** D128 : l'autorisation de livrer ; aucune tant que le merge n'est pas parti. */
function TuileAutorisation({
  fusionne,
  enCours,
  tete,
}: {
  fusionne: boolean;
  enCours: boolean;
  tete: string | null;
}) {
  const ton = fusionne ? 'ok' : enCours ? 'ambre' : 'neutre';
  const sur = tete ? court(tete) : null;
  return (
    <div
      className={`livraison-tuile livraison-tuile--${ton}`}
      data-node="livraison.tuile-autorisation"
      data-ton={ton}
    >
      <p className="livraison-tuile-nom">Autorisation</p>
      <p className="livraison-tuile-valeur" data-node="livraison.tuile-autorisation.valeur">
        {fusionne ? 'Fusionnée' : enCours ? 'Fusion en cours' : 'Aucune'}
      </p>
      <p className="livraison-tuile-note" data-node="livraison.tuile-autorisation.note">
        {!sur ? 'Tête inconnue' : fusionne ? `Sur ${sur}` : `Elle ciblera ${sur}`}
      </p>
    </div>
  );
}

const ETAT_CONTROLE: Record<Controle['etat'], string> = {
  succes: '✓ passé',
  panne: '✕ en panne',
  'en-cours': '… en cours',
};

const enDuree = (s: number) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`);

/** D130 : chaque contrôle, sa tête et sa durée ; un contrôle d'une autre tête est grisé et ne compte pas. */
function Controles({
  topicId,
  controles,
  compte,
  tete,
  relancable,
}: {
  topicId: string;
  controles: Controle[];
  compte: Compte;
  tete: string | null;
  relancable: boolean;
}) {
  const test = useActionSuivie(topicId);
  return (
    <div className="livraison-bloc" data-node="livraison.controles">
      <h2 className="livraison-bloc-titre">
        Contrôles exécutés
        {compte.total > 0 && (
          <span className="livraison-bloc-compte" data-node="livraison.controles.compte">
            {' '}
            · {compte.passes} sur {compte.total}
          </span>
        )}
      </h2>
      {controles.length === 0 && (
        <p className="texte-discret" data-node="livraison.controles.vide">
          Aucun contrôle connu pour cette tête.
        </p>
      )}
      <ul className="livraison-controles">
        {controles.map((c, i) => {
          const ailleurs = c.tete !== tete;
          return (
            <li
              key={`${c.nom}-${i}`}
              className={`livraison-controle${ailleurs ? ' livraison-controle--ailleurs' : ''}`}
              data-node={`livraison.controles.controle-${i}`}
              data-etat={c.etat}
            >
              <span className={`livraison-controle-etat livraison-controle-etat--${c.etat}`}>
                {ETAT_CONTROLE[c.etat]}
              </span>
              {c.url ? (
                <a className="livraison-controle-nom" href={c.url} target="_blank" rel="noreferrer">
                  {c.nom}
                </a>
              ) : (
                <span className="livraison-controle-nom">{c.nom}</span>
              )}
              <span className="livraison-controle-detail">
                {c.tete ? (ailleurs ? `sur ${court(c.tete)}` : court(c.tete)) : 'tête inconnue'}
                {c.dureeS !== null && ` · ${enDuree(c.dureeS)}`}
              </span>
            </li>
          );
        })}
      </ul>
      {relancable && (
        <button
          className="bouton bouton--fantome"
          type="button"
          data-node="livraison.controles.relancer"
          disabled={test.enCours || controles.some((c) => c.local && c.etat === 'en-cours')}
          onClick={() => void test.lancer('topic.test')}
        >
          {test.enCours ? 'Test en cours…' : 'Relancer le test local'}
        </button>
      )}
      {test.echec && test.run === null && (
        <p className="message-erreur" role="alert" data-node="livraison.controles.erreur">
          {test.echec}
        </p>
      )}
    </div>
  );
}

/** D131 : ce que la revue dit, ce qu'elle a examiné et ce qu'elle n'a pas examiné. */
function AvisRevue({
  topicId,
  page,
  source,
  fraicheur,
  tete,
}: {
  topicId: string;
  page: MemoryPage | null | undefined;
  source: SourceRevue | null;
  fraicheur: Fraicheur | null;
  tete: string | null;
}) {
  const avis = page ? lireAvis(page.body) : null;
  return (
    <div className="livraison-bloc" data-node="livraison.avis">
      <h2 className="livraison-bloc-titre">Avis de revue</h2>
      {fraicheur?.etat === 'obsolete' && tete && (
        <p className="livraison-encart" data-node="livraison.avis.obsolete">
          Revue obsolète. L’avis porte sur {court(fraicheur.commit)}, la tête est maintenant{' '}
          {court(tete)}.
        </p>
      )}
      {page === undefined ? (
        <p className="texte-discret">Lecture de la mémoire…</p>
      ) : avis ? (
        <>
          <p data-node="livraison.avis.texte">{avis.texte ?? 'La page de revue est vide.'}</p>
          {avis.examine && (
            <p className="texte-discret" data-node="livraison.avis.examine">
              Examiné : {avis.examine}
            </p>
          )}
          {avis.nonExamine && (
            <p className="texte-discret" data-node="livraison.avis.non-examine">
              Non examiné : {avis.nonExamine}
            </p>
          )}
        </>
      ) : source ? (
        <p className="texte-discret" data-node="livraison.avis.github">
          Revue GitHub{source.auteur ? ` de ${source.auteur}` : ''}, sans page de revue dans la
          mémoire.
        </p>
      ) : (
        <p className="texte-discret" data-node="livraison.avis.aucune">
          Aucune revue pour ce sujet.
        </p>
      )}
      {page && (
        <Link
          className="livraison-lien"
          data-node="livraison.avis.onglet"
          to={`/sujets/${topicId}?onglet=review`}
        >
          Ouvrir l’onglet Revue
        </Link>
      )}
    </div>
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

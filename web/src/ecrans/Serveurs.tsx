import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { Server, ServerStatus, ServerTest } from '../../../src/shared/model.js';
import { type ServeursStore, statutInconnu, useServeurs } from '../data/serveurs.js';
import { useAid } from '../data/useAidState.js';
import { Dialogue } from '../dialogues/Dialogue.js';
import { ContextMenu } from '../ui/ContextMenu.js';
import { Layout } from '../ui/Layout.js';
import { IconeServeur, MODE_SERVEUR, PastilleEtatServeur } from '../ui/Serveur.js';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const agentsTexte = (s: Server) =>
  s.detectedAgents === null
    ? 'non testé'
    : s.detectedAgents.length === 0
      ? 'aucun'
      : s.detectedAgents.join(' · ');

/** Les discussions sur serveur arrivent avec le groupe R (R.6) ; d'ici là, aucune n'existe. */
const DISCUSSIONS_INDISPONIBLES = 'Les discussions sur serveur arrivent avec la prochaine étape.';

function Carte({
  s,
  status,
  test,
  n,
  store,
  onSupprimer,
}: {
  s: Server;
  status: ServerStatus;
  test: ServerTest | undefined;
  n: number;
  store: ServeursStore;
  onSupprimer: (s: Server) => void;
}) {
  const { call } = useAid();
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const id = `serveurs.serveur-${n}`;
  const lancer = async (action: 'test' | 'ping') => {
    setErreur(null);
    setEnCours(true);
    try {
      const r = await call<ServerStatus | ServerTest>('POST', `/api/servers/${s.id}/${action}`);
      // « Reconnecter » rend l'état mesuré : la carte bouge même sans l'éphémère (socket coupée)
      if (action === 'ping' && r && 'state' in r) store.appliquer(r);
    } catch (err) {
      setErreur(message(err));
    } finally {
      setEnCours(false);
    }
  };
  const testEnCours = test !== undefined && test.finishedAt === null;
  const raison = status.state === 'unreachable' || status.state === 'error' ? status.reason : null;
  return (
    <section className="serveur-carte" data-node={id} aria-label={s.name}>
      <div className="serveur-carte-entete">
        <div className="serveur-carte-icone">
          <IconeServeur state={status.state} />
        </div>
        <div className="serveur-carte-ident">
          <div className="serveur-carte-nom">
            <span className="serveur-nom" data-node={`${id}.nom`}>
              {s.name}
            </span>
            <PastilleEtatServeur state={status.state} dataNode={`${id}.etat`} />
          </div>
          <div className="serveur-carte-cible" data-node={`${id}.cible`}>
            {MODE_SERVEUR[s.mode]} · {s.target}
          </div>
        </div>
        <button
          className="bouton"
          data-node={`${id}.configurer`}
          type="button"
          onClick={() => navigate(`/serveurs/${s.id}/configuration`)}
        >
          Configurer
        </button>
        <button
          className="bouton bouton--primaire"
          data-node={`${id}.ouvrir`}
          type="button"
          aria-disabled="true"
          aria-describedby={`${s.id}-discussions`}
          title={DISCUSSIONS_INDISPONIBLES}
        >
          Ouvrir la discussion
        </button>
        <div className="serveur-carte-menu">
          <button
            className="bouton serveur-carte-plus"
            data-node={`${id}.plus`}
            type="button"
            aria-label={`Plus d’actions pour ${s.name}`}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu(true)}
          >
            ···
          </button>
          {menu && (
            <ContextMenu
              label={`Actions pour ${s.name}`}
              onClose={() => setMenu(false)}
              items={[
                {
                  id: 'tester',
                  label: 'Tester la connexion',
                  disabled: enCours || testEnCours,
                  onSelect: () => void lancer('test'),
                },
                {
                  id: 'reconnecter',
                  label: 'Reconnecter',
                  disabled: enCours || testEnCours,
                  onSelect: () => void lancer('ping'),
                },
                {
                  id: 'supprimer',
                  label: 'Supprimer',
                  separatorBefore: true,
                  onSelect: () => onSupprimer(s),
                },
              ]}
            />
          )}
        </div>
      </div>
      {raison && (
        <p className="serveur-carte-raison" data-node={`${id}.raison`}>
          {raison}
        </p>
      )}
      {testEnCours && (
        <p className="texte-discret" data-node={`${id}.test`}>
          Test de connexion en cours…
        </p>
      )}
      {test?.finishedAt && test.ok === false && (
        <p className="serveur-carte-raison" data-node={`${id}.test`}>
          Dernier test : {test.error}
        </p>
      )}
      <dl className="serveur-indicateurs">
        <div className="serveur-indicateur">
          <dt>Latence</dt>
          <dd className="serveur-valeur-mono" data-node={`${id}.latence`}>
            {status.latencyMs === null ? '—' : `${status.latencyMs} ms`}
          </dd>
        </div>
        <div className="serveur-indicateur">
          <dt>Agents détectés</dt>
          <dd className="serveur-valeur-mono" data-node={`${id}.agents`} title={agentsTexte(s)}>
            {agentsTexte(s)}
          </dd>
        </div>
        <div className="serveur-indicateur">
          <dt>Répertoire de travail</dt>
          <dd className="serveur-valeur-mono" data-node={`${id}.repertoire`} title={s.workdir}>
            {s.workdir}
          </dd>
        </div>
        <div className="serveur-indicateur">
          <dt>Session persistante</dt>
          <dd data-node={`${id}.session`}>{s.keepSession ? 'Active' : 'Inactive'}</dd>
        </div>
      </dl>
      {erreur && (
        <p className="message-erreur" role="alert" data-node={`${id}.erreur`}>
          {erreur}
        </p>
      )}
      <div className="serveur-discussions" data-node={`${id}.discussions`}>
        <div className="groupe-entete">
          <span className="serveur-discussions-titre">Discussions sur {s.name}</span>
          <span className="texte-faible">0</span>
        </div>
        <p className="texte-discret" id={`${s.id}-discussions`}>
          Aucune discussion sur ce serveur. {DISCUSSIONS_INDISPONIBLES}
        </p>
      </div>
    </section>
  );
}

function Contenu() {
  const { call } = useAid();
  const { servers, statuses, tests, erreur, store } = useServeurs();
  const navigate = useNavigate();
  const [suppression, setSuppression] = useState<Server | null>(null);
  const [suppressionEnCours, setSuppressionEnCours] = useState(false);
  const [erreurSuppression, setErreurSuppression] = useState<string | null>(null);
  const ajouter = () => navigate('/serveurs/nouveau');
  const fermerSuppression = () => {
    setSuppression(null);
    setErreurSuppression(null);
  };
  const supprimer = async (s: Server) => {
    setErreurSuppression(null);
    setSuppressionEnCours(true);
    try {
      await call('DELETE', `/api/servers/${s.id}`);
      store.retirer(s.id);
      setSuppression(null);
    } catch (err) {
      // le dialogue reste ouvert : l'erreur s'affiche là où l'action a été faite (review S.4)
      setErreurSuppression(message(err));
    } finally {
      setSuppressionEnCours(false);
    }
  };
  return (
    <main className="page">
      <div className="entete" data-node="serveurs.entete">
        <div className="entete-texte">
          <h1 className="titre-ecran" data-node="serveurs.entete.titre">
            Serveurs
          </h1>
          <p className="resume">
            Machines distantes où tes agents peuvent travailler. La connexion passe par le daemon
            local de ton ordinateur.
          </p>
        </div>
        {servers !== null && servers.length > 0 && (
          <button
            className="bouton bouton--primaire"
            data-node="serveurs.ajouter"
            data-action="serveur.ajouter"
            type="button"
            onClick={ajouter}
          >
            Ajouter un serveur
          </button>
        )}
      </div>
      {erreur && (
        <p className="message-erreur" role="alert" data-node="serveurs.erreur">
          {erreur}
        </p>
      )}
      {servers !== null && servers.length === 0 && (
        <section className="vide" data-node="serveurs.vide">
          <p className="vide-message">Aucun serveur</p>
          <p className="texte-discret">
            Ajoute un VPS ou une machine de build : A-I-D s’y connecte par ssh, depuis ton
            ordinateur, avec ta configuration ssh. Aucun mot de passe ni clé n’est enregistré.
          </p>
          <div className="vide-actions">
            <button
              className="bouton bouton--primaire"
              data-node="serveurs.vide.ajouter"
              type="button"
              onClick={ajouter}
            >
              Ajouter un serveur
            </button>
          </div>
        </section>
      )}
      {servers?.map((s, i) => (
        <Carte
          key={s.id}
          s={s}
          n={i + 1}
          status={statuses[s.id] ?? statutInconnu(s.id)}
          test={tests[s.id]}
          store={store}
          onSupprimer={setSuppression}
        />
      ))}
      {servers !== null && servers.length > 0 && (
        <section className="serveur-ajout" data-node="serveurs.ajout">
          <div className="serveur-ajout-texte">
            <p className="serveur-ajout-titre">Ajouter un autre serveur</p>
            <p className="texte-discret">
              Un second VPS, une machine de build ou un serveur de test. Chacun apparaît dans la
              barre gauche avec son propre état de connexion.
            </p>
          </div>
          <button
            className="bouton"
            data-node="serveurs.ajout.ajouter"
            type="button"
            onClick={ajouter}
          >
            Ajouter un serveur
          </button>
        </section>
      )}
      {suppression && (
        <Dialogue titre={`Supprimer ${suppression.name} ?`} onClose={fermerSuppression}>
          <p className="texte-discret">
            A-I-D oublie ce serveur. Rien n’est exécuté sur le serveur : ses fichiers et ses
            sessions restent en place.
          </p>
          {erreurSuppression && (
            <p className="message-erreur" role="alert" data-node="serveurs.supprimer.erreur">
              {erreurSuppression}
            </p>
          )}
          <div className="dialogue-actions">
            <button
              className="bouton"
              type="button"
              disabled={suppressionEnCours}
              onClick={fermerSuppression}
            >
              Annuler
            </button>
            <button
              className="bouton bouton--danger"
              data-node="serveurs.supprimer.confirmer"
              type="button"
              disabled={suppressionEnCours}
              onClick={() => void supprimer(suppression)}
            >
              Supprimer
            </button>
          </div>
        </Dialogue>
      )}
    </main>
  );
}

export function Serveurs() {
  return (
    <Layout screen="serveurs">
      <Contenu />
    </Layout>
  );
}

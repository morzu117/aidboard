import { useEffect, useState } from 'react';
import type { Workspace } from '../../../src/shared/model.js';
import { useAid } from '../data/useAidState.js';
import { Dialogue } from '../dialogues/Dialogue.js';
import { Layout, useLayout } from '../ui/Layout.js';

interface HooksState {
  path: string;
  installed: boolean;
  missing: string[];
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const pluriel = (n: number, mot: string) => `${n} ${mot}${n > 1 ? 's' : ''}`;

function Projets() {
  const { state, call, refresh } = useAid();
  const { openNewTopic, openNewWorkspace } = useLayout();
  const [retrait, setRetrait] = useState<Workspace | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const workspaces = state?.workspaces ?? [];
  const ouverts = (id: string) => state?.topics.filter((t) => t.workspaceId === id).length ?? 0;
  const retirer = async (w: Workspace) => {
    setErreur(null);
    try {
      await call('DELETE', `/api/workspaces/${w.id}`);
      await refresh();
    } catch (err) {
      setErreur(message(err));
    } finally {
      setRetrait(null);
    }
  };
  return (
    <section className="groupe" data-node="reglages.projets" aria-label="Projets">
      <div className="groupe-entete">
        <h2 className="titre-zone">Projets</h2>
        <span className="texte-faible" data-node="reglages.projets.compte">
          {workspaces.length}
        </span>
      </div>
      {workspaces.length === 0 && (
        <p className="texte-discret" data-node="reglages.projets.vide">
          Aucun projet enregistré.
        </p>
      )}
      {workspaces.map((w, i) => {
        const id = `reglages.projets.projet-${i + 1}`;
        const n = ouverts(w.id);
        return (
          <article key={w.id} className="element" data-node={id} aria-label={w.name}>
            <div className="element-entete">
              <span className="identifiant" data-node={`${id}.nom`}>
                {w.name}
              </span>
              <span className="pastille pastille--code" data-node={`${id}.base`}>
                {w.remote ? `${w.remote}/${w.baseBranch}` : w.baseBranch}
              </span>
              {!w.remote && (
                <span className="pastille pastille--local" data-node={`${id}.local`}>
                  local
                </span>
              )}
              <span className="element-moment" data-node={`${id}.sujets`}>
                {n === 0
                  ? 'aucun sujet ouvert'
                  : `${pluriel(n, 'sujet')} ${n > 1 ? 'ouverts' : 'ouvert'}`}
              </span>
            </div>
            <p className="element-detail" data-node={`${id}.chemin`}>
              {w.root}
            </p>
            <div className="element-actions">
              <button
                className="bouton bouton--contour"
                data-node={`${id}.nouveau-sujet`}
                type="button"
                aria-label={`Nouveau sujet dans ${w.name}`}
                onClick={() => openNewTopic(w.id)}
              >
                Nouveau sujet
              </button>
              {n === 0 && (
                <button
                  className="bouton bouton--fantome"
                  data-node={`${id}.retirer`}
                  type="button"
                  aria-label={`Retirer ${w.name}`}
                  onClick={() => setRetrait(w)}
                >
                  Retirer
                </button>
              )}
            </div>
          </article>
        );
      })}
      {erreur && (
        <p className="message-erreur" role="alert" data-node="reglages.projets.erreur">
          {erreur}
        </p>
      )}
      <div className="element-actions">
        <button
          className="bouton"
          data-node="reglages.projets.ajouter"
          data-action="workspace.ajouter"
          type="button"
          onClick={openNewWorkspace}
        >
          Ajouter un projet
        </button>
      </div>
      {retrait && (
        <Dialogue titre={`Retirer ${retrait.name} ?`} onClose={() => setRetrait(null)}>
          <p className="texte-discret">
            A-I-D oublie ce projet et ses sujets archivés. Le dépôt et ses fichiers ne sont pas
            touchés ; tu pourras l’ajouter de nouveau.
          </p>
          <div className="dialogue-actions">
            <button className="bouton" type="button" onClick={() => setRetrait(null)}>
              Annuler
            </button>
            <button
              className="bouton bouton--danger"
              type="button"
              onClick={() => void retirer(retrait)}
            >
              Retirer
            </button>
          </div>
        </Dialogue>
      )}
    </section>
  );
}

function Hooks() {
  const { call } = useAid();
  const [hooks, setHooks] = useState<HooksState | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [confirmer, setConfirmer] = useState(false);
  const [installes, setInstalles] = useState<{ backup?: string } | null>(null);
  useEffect(() => {
    call<HooksState>('GET', '/api/hooks').then(setHooks, (err) => setErreur(message(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const installer = async () => {
    setErreur(null);
    try {
      const r = await call<HooksState & { changed: boolean; backup?: string }>(
        'POST',
        '/api/hooks/install',
        { confirm: true },
      );
      setHooks(r);
      setInstalles({ backup: r.backup });
    } catch (err) {
      setErreur(message(err));
    } finally {
      setConfirmer(false);
    }
  };
  return (
    <section className="groupe" data-node="reglages.hooks" aria-label="Hooks Claude Code">
      <div className="groupe-entete">
        <h2 className="titre-zone">Hooks Claude Code</h2>
      </div>
      <article className="element">
        <div className="element-entete">
          <span
            className={`badge badge--${hooks?.installed ? 'relire' : 'attente'}`}
            data-node="reglages.hooks.etat"
          >
            {hooks === null ? '…' : hooks.installed ? 'Installés' : 'Non installés'}
          </span>
          {hooks && (
            <span className="element-sujet" data-node="reglages.hooks.chemin">
              {hooks.path}
            </span>
          )}
        </div>
        <p className="element-detail">
          Sans hooks, le statut d’un agent claude est estimé depuis son terminal. Avec, il suit ce
          que claude fait vraiment, et ses demandes arrivent dans la boîte de réception. Hors A-I-D,
          ces hooks ne lancent rien.
        </p>
        {installes && (
          <p className="message-info" role="status" data-node="reglages.hooks.relancer">
            Hooks installés
            {installes.backup ? ` (sauvegarde : ${installes.backup})` : ''}. Relance les sessions
            claude déjà ouvertes : elles ne lisent leurs hooks qu’au démarrage.
          </p>
        )}
        {erreur && (
          <p className="message-erreur" role="alert" data-node="reglages.hooks.erreur">
            {erreur}
          </p>
        )}
        {hooks && !hooks.installed && (
          <div className="element-actions">
            <button
              className="bouton bouton--primaire"
              data-node="reglages.hooks.installer"
              type="button"
              onClick={() => setConfirmer(true)}
            >
              Installer les hooks
            </button>
          </div>
        )}
      </article>
      {confirmer && hooks && (
        <Dialogue titre="Installer les hooks ?" onClose={() => setConfirmer(false)}>
          <p className="texte-discret">
            A-I-D ajoute ses entrées à <code>{hooks.path}</code>, après en avoir fait une copie de
            sauvegarde. Le reste du fichier n’est pas modifié. <code>aid hooks uninstall</code> les
            retire.
          </p>
          <div className="dialogue-actions">
            <button className="bouton" type="button" onClick={() => setConfirmer(false)}>
              Annuler
            </button>
            <button
              className="bouton bouton--primaire"
              data-node="reglages.hooks.confirmer"
              type="button"
              onClick={() => void installer()}
            >
              Installer
            </button>
          </div>
        </Dialogue>
      )}
    </section>
  );
}

type Permission = NotificationPermission | 'absent';
const permissionActuelle = (): Permission =>
  typeof Notification === 'undefined' ? 'absent' : Notification.permission;
const PERMISSION_TEXTE: Record<Permission, string> = {
  granted: 'Autorisées',
  denied: 'Refusées par le navigateur',
  default: 'Pas encore autorisées',
  absent: 'Ce navigateur ne propose pas de notifications',
};

function Notifications() {
  const [permission, setPermission] = useState<Permission>(permissionActuelle);
  return (
    <section className="groupe" data-node="reglages.notifications" aria-label="Notifications">
      <div className="groupe-entete">
        <h2 className="titre-zone">Notifications</h2>
      </div>
      <article className="element">
        <div className="element-entete">
          <span className="identifiant" data-node="reglages.notifications.etat">
            {PERMISSION_TEXTE[permission]}
          </span>
        </div>
        <p className="element-detail">
          Quand l’onglet est caché, une notification signale chaque agent qui attend ta réponse.
        </p>
        {permission === 'default' && (
          <div className="element-actions">
            <button
              className="bouton"
              data-node="reglages.notifications.autoriser"
              type="button"
              onClick={() => void Notification.requestPermission().then(setPermission)}
            >
              Autoriser les notifications
            </button>
          </div>
        )}
      </article>
    </section>
  );
}

// Les sections attendent le premier instantané : avant, le daemon n'a pas encore répondu.
function Contenu() {
  const { state, daemon } = useAid();
  const down = daemon === 'injoignable' || daemon === 'session-expiree';
  return (
    <main className="page">
      <div className="entete" data-node="reglages.entete">
        <div className="entete-texte">
          <h1 className="titre-ecran" data-node="reglages.entete.titre">
            Réglages
          </h1>
        </div>
      </div>
      {state ? (
        <div className="liste">
          <Projets />
          <Hooks />
          <Notifications />
        </div>
      ) : down ? (
        <p className="message-erreur" role="alert">
          Le daemon est injoignable : les réglages ne peuvent pas être lus.
        </p>
      ) : (
        <span className="sq sq--ligne sq--moyen" />
      )}
    </main>
  );
}

export function Reglages() {
  return (
    <Layout screen="reglages">
      <Contenu />
    </Layout>
  );
}

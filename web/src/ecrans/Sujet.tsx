import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { Agent, IndexState } from '../../../src/shared/model.js';
import { AidApiError } from '../data/api.js';
import { useAid } from '../data/useAidState.js';
import { ConfirmerNettoyage } from '../dialogues/ConfirmerNettoyage.js';
import { Terminal } from '../terminal/Terminal.js';
import { Layout } from '../ui/Layout.js';
import { Point, statusView } from '../ui/Statut.js';
import { Cote } from './Cote.js';
import { useNettoyage } from './useNettoyage.js';
import { roleLabel } from '../ui/roles.js';

const INDEX_LABEL: Record<IndexState, string> = {
  disabled: 'index absent : lecture directe',
  indexing: 'indexation en cours',
  ready: 'index prêt',
  failed: 'index en échec : lecture directe',
};

const LIVE = ['starting', 'working', 'needs_input', 'idle'];
type Kind = 'claude' | 'codex' | 'shell';
const KINDS: Array<{ kind: Kind; label: string }> = [
  { kind: 'claude', label: 'Lancer claude' },
  { kind: 'codex', label: 'Lancer codex' },
  { kind: 'shell', label: 'Ouvrir un shell' },
];

function Contenu({ topicId }: { topicId: string }) {
  const { state, daemon, retry, call } = useAid();
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<'aucun' | 'agent' | 'plus'>('aucun');
  const [erreur, setErreur] = useState<string | null>(null);
  const nettoyage = useNettoyage(topicId);
  const down = daemon === 'injoignable' || daemon === 'session-expiree';

  if (!state) {
    return (
      <main className="page sujet-contenu">
        {down ? (
          <section className="zone-erreur" data-node="1-3.erreur">
            <div className="bandeau-erreur" data-node="1-3.erreur.bandeau" role="alert">
              <div className="bandeau-texte">
                <p className="bandeau-titre" data-node="1-3.erreur.bandeau.titre">
                  Impossible de lire l’état du sujet
                </p>
                <p
                  className="texte-discret"
                  data-node="1-3.erreur.bandeau.cause"
                  data-bind="erreur.cause"
                >
                  {daemon === 'session-expiree'
                    ? 'Cause : la session a expiré (le daemon a redémarré).'
                    : `Cause : le daemon est injoignable sur ${window.location.host}.`}
                </p>
              </div>
              {daemon !== 'session-expiree' && (
                <button
                  className="bouton bouton--contour"
                  data-node="1-3.erreur.bandeau.reessayer"
                  data-action="daemon.reconnecter"
                  type="button"
                  onClick={retry}
                >
                  Réessayer
                </button>
              )}
            </div>
          </section>
        ) : (
          <>
            <div className="sujet-entete" data-node="1-3.entete">
              <span className="sq sq--ligne sq--court" />
              <span className="sq sq--titre" />
              <span className="sq sq--puce" />
            </div>
            <div className="sujet-grille sujet-grille--seul">
              <div className="squelette" data-node="1-3.terminaux">
                <span className="sq sq--puce" />
                <span className="sq sq--grand-bloc" />
              </div>
            </div>
          </>
        )}
      </main>
    );
  }

  const topic = state.topics.find((t) => t.id === topicId);
  if (!topic) {
    return (
      <main className="page sujet-contenu">
        <section className="vide" data-node="1-3.vide">
          <p className="vide-message" data-node="1-3.vide.message">
            Sujet introuvable ou archivé.
          </p>
          <Link className="lien" to="/">
            ← Retour aux sujets
          </Link>
        </section>
      </main>
    );
  }
  const workspace = state.workspaces.find((w) => w.id === topic.workspaceId);
  const runIds = state.runs.filter((r) => r.topicId === topic.id).map((r) => r.id);
  const agents: Agent[] = state.agents.filter((a) => runIds.includes(a.runId));
  const active = agents.find((a) => a.id === selected) ?? agents.at(-1);

  async function launch(kind: Kind) {
    setErreur(null);
    setMenu('aucun');
    try {
      const a = await call<Agent>('POST', '/api/agents', { topicId, kind });
      setSelected(a.id);
    } catch (err) {
      setErreur(err instanceof AidApiError ? err.message : String(err));
    }
  }

  async function stop(agentId: string) {
    setErreur(null);
    try {
      await call('DELETE', `/api/agents/${agentId}`);
    } catch (err) {
      setErreur(err instanceof AidApiError ? err.message : String(err));
    }
  }

  async function openEditor() {
    setErreur(null);
    try {
      await call('POST', `/api/topics/${topicId}/actions/editor.open`, {});
    } catch (err) {
      setErreur(err instanceof AidApiError ? err.message : String(err));
    }
  }

  return (
    <main className="page sujet-contenu">
      <div className="sujet-entete" data-node="1-3.entete">
        <div className="sujet-titre-ligne">
          <div className="entete-texte">
            <p className="fil-ariane" data-node="1-3.entete.fil-ariane">
              <Link
                data-node="1-3.entete.workspace"
                data-bind="workspace.nom"
                data-action="nav.accueil"
                to="/"
              >
                {workspace?.name ?? '?'}
              </Link>{' '}
              / sujet
            </p>
            <h1 className="titre-ecran" data-node="1-3.entete.titre" data-bind="sujet.titre">
              {topic.title}
            </h1>
          </div>
          <div className="sujet-actions" data-node="1-3.actions">
            <button
              className="bouton"
              data-node="1-3.actions.editeur"
              data-action="editeur.ouvrir"
              type="button"
              onClick={() => void openEditor()}
              disabled={topic.worktreeMissing}
            >
              Ouvrir dans l’éditeur
            </button>
            <button
              className="bouton-icone"
              data-node="1-3.actions.plus"
              data-action="actions.menu"
              type="button"
              aria-label="Plus d’actions"
              aria-expanded={menu === 'plus'}
              onClick={() => setMenu(menu === 'plus' ? 'aucun' : 'plus')}
            >
              ⋯
            </button>
            {menu === 'plus' && (
              <button
                className="bouton bouton--danger"
                data-action="topic.cleanup"
                type="button"
                onClick={() => {
                  setMenu('aucun');
                  void nettoyage.start();
                }}
                disabled={nettoyage.phase.phase === 'en-cours'}
              >
                Nettoyer le sujet
              </button>
            )}
          </div>
        </div>
        <div className="sujet-meta">
          <span
            className="pastille pastille--etat"
            data-node="1-3.entete.etat"
            data-bind="sujet.etat"
          >
            {topic.state}
          </span>
          <span
            className="pastille pastille--code"
            data-node="1-3.entete.branche"
            data-bind="sujet.branche"
          >
            {topic.branch}
          </span>
          <span className="pastille pastille--discret" data-node="1-3.entete.base">
            base{' '}
            <span data-node="1-3.entete.base.branche" data-bind="sujet.base">
              origin/{topic.base}
            </span>
          </span>
          <span
            className="pastille pastille--discret"
            data-node="1-3.entete.worktree"
            data-bind="sujet.worktree"
          >
            {topic.worktree}
          </span>
          <span
            className="pastille pastille--discret"
            data-node="1-3.entete.index"
            data-bind="sujet.index"
          >
            {INDEX_LABEL[topic.indexState]}
          </span>
        </div>
      </div>
      {(erreur || nettoyage.phase.phase === 'refuse') && (
        <p className="message-erreur" role="alert">
          {erreur ?? (nettoyage.phase.phase === 'refuse' ? nettoyage.phase.message : '')}
        </p>
      )}
      {nettoyage.phase.phase === 'confirmer' && (
        <ConfirmerNettoyage
          commits={nettoyage.phase.commits}
          onClose={nettoyage.reset}
          onConfirm={(n) => void nettoyage.start(n)}
        />
      )}
      {topic.worktreeMissing ? (
        <section className="zone-erreur" data-node="1-3.erreur">
          <div className="bandeau-erreur" data-node="1-3.erreur.bandeau" role="alert">
            <p className="bandeau-titre" data-node="1-3.erreur.bandeau.titre">
              Worktree introuvable
            </p>
            <p
              className="texte-discret"
              data-node="1-3.erreur.bandeau.cause"
              data-bind="erreur.cause"
            >
              {topic.worktree} a été supprimé hors d’A-I-D : aucun agent ne peut y tourner.
            </p>
          </div>
        </section>
      ) : agents.length === 0 ? (
        <div className="sujet-grille sujet-grille--seul">
          <section className="vide" data-node="1-3.vide">
            <p className="vide-message" data-node="1-3.vide.message">
              Aucun agent ne tourne sur ce sujet.
            </p>
            <p className="texte-discret" data-node="1-3.vide.aide">
              Le premier lancement de claude ou de codex dans un worktree neuf affiche son propre
              dialogue de confiance : c’est normal.
            </p>
            <div className="vide-actions">
              {KINDS.map(({ kind, label }) => (
                <button
                  key={kind}
                  className={`bouton${kind === 'claude' ? ' bouton--primaire' : ''}`}
                  data-node={kind === 'shell' ? '1-3.vide.shell' : `1-3.vide.lancer-${kind}`}
                  data-action="agent.lancer"
                  data-agent={kind}
                  type="button"
                  onClick={() => void launch(kind)}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>
        </div>
      ) : (
        <div className="sujet-grille sujet-grille--seul">
          <section className="terminaux" data-node="1-3.terminaux" aria-label="Terminaux">
            <div
              className="onglets"
              data-node="1-3.terminaux.onglets"
              role="tablist"
              aria-label="Agents du sujet"
            >
              {agents.map((a, i) => {
                const v = statusView(a.status);
                return (
                  <span key={a.id} style={{ display: 'inline-flex' }}>
                    <button
                      className={`onglet${a.id === active?.id ? ' est-actif' : ''}`}
                      data-node={`1-3.terminaux.onglet-${i + 1}`}
                      data-action="onglet.choisir"
                      role="tab"
                      aria-selected={a.id === active?.id}
                      type="button"
                      onClick={() => setSelected(a.id)}
                    >
                      <Point tone={v.tone} label={v.label} />
                      <span data-node={`1-3.terminaux.onglet-${i + 1}.type`} data-bind="agent.type">
                        {a.kind}
                      </span>
                      <span
                        className="agent-role"
                        data-node={`1-3.terminaux.onglet-${i + 1}.role`}
                        data-bind="agent.role"
                      >
                        {roleLabel(a.role)}
                      </span>
                    </button>
                    {LIVE.includes(a.status) && (
                      <button
                        className="bouton bouton--fantome"
                        data-node={`1-3.terminaux.onglet-${i + 1}.arreter`}
                        data-action="agent.arreter"
                        type="button"
                        onClick={() => void stop(a.id)}
                      >
                        Arrêter
                      </button>
                    )}
                  </span>
                );
              })}
              <button
                className="onglet"
                data-node="1-3.terminaux.ajouter-agent"
                data-action="agent.ajouter"
                type="button"
                aria-expanded={menu === 'agent'}
                onClick={() => setMenu(menu === 'agent' ? 'aucun' : 'agent')}
              >
                + Agent
              </button>
              {menu === 'agent' &&
                KINDS.map(({ kind, label }) => (
                  <button
                    key={kind}
                    className="onglet"
                    data-action="agent.lancer"
                    data-agent={kind}
                    type="button"
                    onClick={() => void launch(kind)}
                  >
                    {label}
                  </button>
                ))}
            </div>
            {agents.map((a) => (
              <Terminal key={a.id} agentId={a.id} visible={a.id === active?.id} />
            ))}
          </section>
        </div>
      )}
    </main>
  );
}

export function Sujet() {
  const { topicId = '' } = useParams();
  return (
    <Layout screen="1-3">
      <div className="sujet-corps">
        <Cote activeTopicId={topicId} />
        <Contenu topicId={topicId} />
      </div>
    </Layout>
  );
}

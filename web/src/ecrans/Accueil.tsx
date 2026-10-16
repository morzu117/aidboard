import { useState } from 'react';
import type { Agent } from '../../../src/shared/model.js';
import { useAid } from '../data/useAidState.js';
import { Layout, useLayout } from '../ui/Layout.js';
import { isAlive, Point, type Tone, topicView } from '../ui/Statut.js';
import { CarteSujet } from './CarteSujet.js';
import { CasErreurWorktree } from './CasErreurWorktree.js';

function Squelettes() {
  return (
    <div className="grille" data-node="1-1.grille" aria-label="Chargement des sujets">
      {[1, 2, 3, 4, 5, 6].map((n) => (
        <div key={n} className="squelette" data-node={`1-1.grille.squelette-${n}`}>
          <div className="entete-texte" data-node={`1-1.grille.squelette-${n}.entete`}>
            <span className="sq sq--titre" />
            <span className="sq sq--ligne sq--court" />
          </div>
          <span className="sq sq--puce" />
          <div className="entete-texte" data-node={`1-1.grille.squelette-${n}.terminal`}>
            <span className="sq sq--bloc" />
          </div>
          <div className="entete-texte" data-node={`1-1.grille.squelette-${n}.message`}>
            <span className="sq sq--champ" />
          </div>
        </div>
      ))}
    </div>
  );
}

function BandeauDaemon() {
  const { daemon, retry } = useAid();
  const expired = daemon === 'session-expiree';
  return (
    <div className="bandeau-erreur" data-node="1-1.erreur.bandeau" role="alert">
      <div className="bandeau-texte">
        <p className="bandeau-titre" data-node="1-1.erreur.bandeau.titre">
          Impossible de lire l’état des sujets
        </p>
        <p className="texte-discret" data-node="1-1.erreur.bandeau.cause" data-bind="erreur.cause">
          {expired
            ? 'Cause : la session a expiré (le daemon a redémarré).'
            : `Cause : le daemon est injoignable sur ${window.location.host} (connexion refusée).`}
        </p>
        <p className="texte-faible" data-node="1-1.erreur.bandeau.aide">
          {expired
            ? 'Relance aid open pour obtenir un nouveau lien.'
            : 'Relance-le avec aid dans un terminal, puis réessaie.'}
        </p>
      </div>
      {!expired && (
        <button
          className="bouton bouton--contour"
          data-node="1-1.erreur.bandeau.reessayer"
          data-action="daemon.reconnecter"
          type="button"
          onClick={retry}
        >
          Réessayer
        </button>
      )}
    </div>
  );
}

const STATUTS: { tone: Exclude<Tone, 'inactif'>; label: string }[] = [
  { tone: 'attente', label: 'Attend une réponse' },
  { tone: 'erreur', label: 'Erreur' },
  { tone: 'relire', label: 'À relire' },
  { tone: 'cours', label: 'En cours' },
  { tone: 'pause', label: 'En pause' },
];

// E6 : seulement aux claude et codex vivants qui ont fini leur tour ; jamais à un shell, qui exécuterait le texte.
const recoitConsigne = (a: Agent) =>
  (a.kind === 'claude' || a.kind === 'codex') && isAlive(a) && !a.pausedAt && a.status === 'idle';

function Consigne({ agents }: { agents: Agent[] }) {
  const { call } = useAid();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [retour, setRetour] = useState<{ ok: number; erreurs: string[] } | null>(null);
  const cibles = agents.filter(recoitConsigne);
  const envoyer = async () => {
    setBusy(true);
    setRetour(null);
    const results = await Promise.allSettled(
      cibles.map((a) => call('POST', `/api/agents/${a.id}/input`, { text })),
    );
    const erreurs = results.flatMap((r, i) =>
      r.status === 'rejected' ? [`${cibles[i]!.kind} : ${(r.reason as Error).message}`] : [],
    );
    setRetour({ ok: results.length - erreurs.length, erreurs });
    if (erreurs.length === 0) setText('');
    setBusy(false);
  };
  return (
    <section className="consigne" data-node="1-1.consigne" aria-label="Consigne à tous les agents">
      <div className="consigne-entete">
        <h2 className="titre-zone" data-node="1-1.consigne.titre">
          Consigne à tous les agents
        </h2>
        <p className="texte-faible" data-node="1-1.consigne.aide">
          Envoyée maintenant aux agents inactifs.
        </p>
      </div>
      <div className="consigne-ligne">
        <input
          className="champ"
          data-node="1-1.consigne.champ"
          data-action="consigne.saisir"
          type="text"
          placeholder="Ex. : messages de commit en français, format Conventional Commits"
          aria-label="Consigne"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          className="bouton bouton--contour"
          data-node="1-1.consigne.envoyer"
          data-action="consigne.envoyer"
          type="button"
          disabled={busy || cibles.length === 0 || !text.trim()}
          onClick={() => void envoyer()}
        >
          <span>
            Envoyer aux agents inactifs (
            <span data-node="1-1.consigne.envoyer.nombre" data-bind="resume.agents_inactifs">
              {cibles.length}
            </span>
            )
          </span>
        </button>
      </div>
      {retour && retour.erreurs.length === 0 && (
        <p className="message-info" role="status" data-node="1-1.consigne.retour">
          Envoyée à {retour.ok} agent{retour.ok > 1 ? 's' : ''}.
        </p>
      )}
      {retour && retour.erreurs.length > 0 && (
        <p className="message-erreur" role="alert" data-node="1-1.consigne.erreur">
          {retour.erreurs.join(' · ')}
        </p>
      )}
    </section>
  );
}

function Legende() {
  return (
    <section className="legende" data-node="1-1.legende" aria-label="Légende">
      {STATUTS.map((s) => (
        <span key={s.tone} className="legende-element" data-node={`1-1.legende.statut-${s.tone}`}>
          <Point tone={s.tone} />
          {s.label}
        </span>
      ))}
      <span className="legende-element" data-node="1-1.legende.estime">
        <span className="badge badge--relire badge--estime">estimé</span>statut déduit du terminal,
        sans signal sûr
      </span>
    </section>
  );
}

function Contenu() {
  const { state, daemon } = useAid();
  const { openNewTopic } = useLayout();
  const [filtre, setFiltre] = useState<string | null>(null);
  const [statut, setStatut] = useState<Tone | null>(null);
  const down = daemon === 'injoignable' || daemon === 'session-expiree';

  if (!state) {
    return (
      <main className="page">
        <div className="entete" data-node="1-1.entete">
          <div className="entete-texte">
            <h1 className="titre-ecran" data-node="1-1.entete.titre">
              Sujets ouverts
            </h1>
            {down ? (
              <p className="resume">État indisponible</p>
            ) : (
              <span className="sq sq--ligne sq--moyen" />
            )}
          </div>
        </div>
        {down ? (
          <section className="zone-erreur" data-node="1-1.erreur">
            <BandeauDaemon />
          </section>
        ) : (
          <Squelettes />
        )}
      </main>
    );
  }

  const topics = state.topics.filter((t) => !filtre || t.workspaceId === filtre);
  const wsOf = (id: string) => state.workspaces.find((w) => w.id === id);
  const agentsOf = (topicId: string) => {
    const runIds = state.runs.filter((r) => r.topicId === topicId).map((r) => r.id);
    return state.agents.filter((a) => runIds.includes(a.runId));
  };
  const total = state.topics.length;
  const toneOf = (topicId: string) => topicView(agentsOf(topicId)).tone;
  const tones = new Map(topics.map((t) => [t.id, t.worktreeMissing ? 'erreur' : toneOf(t.id)]));
  const compte = (tone: Tone) => [...tones.values()].filter((x) => x === tone).length;
  const attente = state.topics.filter(
    (t) => !t.worktreeMissing && toneOf(t.id) === 'attente',
  ).length;
  const garde = (topicId: string) => !statut || tones.get(topicId) === statut;
  const sains = topics.filter((t) => !t.worktreeMissing && garde(t.id));
  const casses = topics.filter((t) => t.worktreeMissing && garde(t.id));

  return (
    <main className="page">
      <div className="entete" data-node="1-1.entete">
        <div className="entete-texte">
          <h1 className="titre-ecran" data-node="1-1.entete.titre">
            Sujets ouverts
          </h1>
          <p className="resume" data-node="1-1.entete.resume">
            <span data-node="1-1.entete.resume.sujets" data-bind="resume.sujets">
              {total}
            </span>{' '}
            {total > 1 ? 'sujets ouverts' : 'sujet ouvert'} ·{' '}
            <span data-node="1-1.entete.resume.en-attente" data-bind="resume.en_attente">
              {attente}
            </span>{' '}
            {attente > 1 ? 'attendent ta réponse' : 'attend ta réponse'}
          </p>
        </div>
        {state.workspaces.length > 0 && (
          <div className="filtres" data-node="1-1.filtres">
            <div className="groupe-filtres" role="group" aria-label="Filtrer par statut">
              {STATUTS.map((s) => (
                <button
                  key={s.tone}
                  className={`puce-filtre${statut === s.tone ? ' est-actif' : ''}`}
                  data-node={`1-1.filtres.statut-${s.tone}`}
                  data-action="filtre.statut"
                  type="button"
                  aria-pressed={statut === s.tone}
                  onClick={() => setStatut(statut === s.tone ? null : s.tone)}
                >
                  <Point tone={s.tone} />
                  {s.label}
                  <span className="compte" data-node={`1-1.filtres.statut-${s.tone}.compte`}>
                    {compte(s.tone)}
                  </span>
                </button>
              ))}
            </div>
            <span className="separateur" aria-hidden="true" />
            <div className="groupe-filtres" role="group" aria-label="Filtrer par workspace">
              <button
                className={`puce-filtre${filtre === null ? ' est-actif' : ''}`}
                data-node="1-1.filtres.workspace-tous"
                data-action="filtre.workspace"
                type="button"
                aria-pressed={filtre === null}
                onClick={() => setFiltre(null)}
              >
                Tous
              </button>
              {state.workspaces.map((w, i) => (
                <button
                  key={w.id}
                  className={`puce-filtre${filtre === w.id ? ' est-actif' : ''}`}
                  data-node={`1-1.filtres.workspace-${i + 1}`}
                  data-action="filtre.workspace"
                  type="button"
                  aria-pressed={filtre === w.id}
                  onClick={() => setFiltre(w.id)}
                >
                  <span data-node={`1-1.filtres.workspace-${i + 1}.nom`} data-bind="workspace.nom">
                    {w.name}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {down && (
        <section className="zone-erreur" data-node="1-1.erreur">
          <BandeauDaemon />
        </section>
      )}
      {topics.length === 0 ? (
        <section className="vide" data-node="1-1.vide">
          <p className="vide-message" data-node="1-1.vide.message">
            {filtre
              ? `Aucun sujet ouvert dans ${wsOf(filtre)?.name ?? 'ce projet'}.`
              : state.workspaces.length > 0
                ? 'Aucun sujet ouvert : un projet peut attendre, crée un sujet quand tu en as un.'
                : 'Aucun projet : ajoutes-en un, puis crée un sujet pour démarrer.'}
          </p>
          <p className="texte-discret" data-node="1-1.vide.aide">
            Chaque sujet aura sa branche et son worktree, créés hors du repo.
          </p>
          <div className="vide-actions">
            <button
              className="bouton bouton--primaire"
              data-node="1-1.vide.creer"
              data-action="sujet.creer"
              type="button"
              onClick={() => openNewTopic(filtre ?? undefined)}
            >
              Nouveau sujet
            </button>
          </div>
        </section>
      ) : (
        <>
          <div className="grille" data-node="1-1.grille">
            {sains.map((t, i) => (
              <CarteSujet
                key={t.id}
                n={i + 1}
                topic={t}
                workspace={wsOf(t.workspaceId)}
                agents={agentsOf(t.id)}
              />
            ))}
          </div>
          {sains.length + casses.length === 0 && (
            <p className="texte-discret" data-node="1-1.grille.aucun">
              Aucun sujet dans cet état.
            </p>
          )}
          {casses.map((t, i) => (
            <CasErreurWorktree key={t.id} n={i + 1} topic={t} workspace={wsOf(t.workspaceId)} />
          ))}
          <Consigne agents={state.agents} />
          <Legende />
        </>
      )}
    </main>
  );
}

export function Accueil() {
  return (
    <Layout screen="1-1">
      <Contenu />
    </Layout>
  );
}

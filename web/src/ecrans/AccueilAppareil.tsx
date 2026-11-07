import type { EtatPourAppareil } from '../../../src/shared/host.js';
import { useAid } from '../data/useAidState.js';
import { depuis } from '../ui/depuis.js';

// Chantier 31 (D175, D180) : l'accueil d'un appareil. Les sujets et leurs agents, en lecture :
// aucun bouton, aucun lien vers un écran du Mac. Ce qu'attend un agent n'est jamais montré, seul
// le fait qu'il attend (D175).

type Agent = EtatPourAppareil['agents'][number];

const RAISONS: Record<string, string> = {
  permission: 'attend une permission',
  question: 'attend une réponse',
  autre: 'attend',
};

function statutAgent(a: Agent): string {
  if (a.pausedAt) return 'en pause';
  if (a.attend) return `${RAISONS[a.statusReason ?? 'autre'] ?? 'attend'}, sur le Mac`;
  return a.status;
}

export function AccueilAppareil() {
  const { appareil } = useAid();
  if (!appareil) return <main className="page" data-node="appareil.accueil" />;
  const runs = new Map(appareil.runs.map((r) => [r.id, r.topicId]));
  const agentsDe = (topicId: string) =>
    appareil.agents.filter((a) => runs.get(a.runId) === topicId);
  const sujets = [...appareil.topics].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const attentes = appareil.agents.filter((a) => a.attend).length;
  return (
    <main className="page appareil-accueil" data-node="appareil.accueil">
      <div className="entete">
        <div className="entete-texte">
          <h1 className="titre-ecran">Accueil</h1>
          <p className="resume" data-node="appareil.accueil.resume">
            {sujets.length} sujet{sujets.length > 1 ? 's' : ''}
            {attentes > 0 ? ` · ${attentes} agent${attentes > 1 ? 's' : ''} en attente` : ''}.
            Lecture seule : on répond et on agit sur le Mac.
          </p>
        </div>
      </div>
      {appareil.workspaces.map((w) => {
        const liste = sujets.filter((t) => t.workspaceId === w.id);
        if (liste.length === 0) return null;
        return (
          <section key={w.id} className="appareil-projet" data-node={`appareil.projet.${w.id}`}>
            <h2 className="titre-zone">{w.name}</h2>
            <ul className="appareil-sujets">
              {liste.map((t) => (
                <li key={t.id} data-node={`appareil.sujet.${t.id}`}>
                  <div className="appareil-sujet-ligne">
                    <span className="machine-carte-nom">{t.title}</span>
                    <span className="pastille pastille--discret">{t.phase ?? t.state}</span>
                    {t.prNumber !== null && <span className="texte-discret">PR #{t.prNumber}</span>}
                    <span className="texte-discret">{depuis(t.updatedAt)}</span>
                  </div>
                  {agentsDe(t.id).length > 0 && (
                    <ul className="appareil-agents">
                      {agentsDe(t.id).map((a) => (
                        <li
                          key={a.id}
                          data-node={`appareil.agent.${a.id}`}
                          className={a.attend ? 'est-en-attente' : undefined}
                        >
                          {a.kind} · {a.role} · {statutAgent(a)}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {sujets.length === 0 && (
        <p className="texte-discret" data-node="appareil.accueil.vide">
          Aucun sujet.
        </p>
      )}
    </main>
  );
}

import { useAid } from '../data/useAidState.js';
import { Decision, Tour } from '../ui/ActionsAppareil.js';

export function AccueilAppareil() {
  const { appareil, horsLigne } = useAid();
  if (!appareil) return <main className="page" data-node="appareil.accueil" />;
  const runs = new Map(appareil.runs.map((r) => [r.id, r.topicId]));
  const sujets = new Map(appareil.topics.map((t) => [t.id, t]));
  const agents = appareil.agents.filter((a) => sujets.has(runs.get(a.runId) ?? ''));
  const decisions = agents.filter(
    (a) => a.question || (a.attend && a.statusReason === 'permission'),
  );
  const relectures = agents.filter((a) => a.tour && a.tour.marque !== 'relu');
  const enCours = agents.filter((a) => a.status === 'working' || a.status === 'starting');
  return (
    <main className="page appareil-accueil" data-node="appareil.accueil">
      <h1 className="titre-ecran">À traiter</h1>
      {decisions.length === 0 && (
        <div data-node="appareil.accueil.vide">
          <h2>{"Rien n'attend ta réponse"}</h2>
          <p>{"Tu seras prévenu dès qu'une décision arrive."}</p>
        </div>
      )}
      {[
        { titre: 'Décisions', liste: decisions },
        { titre: 'À relire', liste: relectures },
        { titre: 'En cours', liste: enCours },
      ].map(
        ({ titre, liste }) =>
          liste.length > 0 && (
            <section key={titre} aria-label={titre}>
              <h2 className="titre-zone">
                {titre} · {liste.length}
              </h2>
              <ul className="appareil-sujets">
                {liste.map((agent) => (
                  <li key={agent.id} data-node={`appareil.agent.${agent.id}`}>
                    <strong data-node={`appareil.sujet.${runs.get(agent.runId)}`}>
                      {sujets.get(runs.get(agent.runId)!)!.title}
                    </strong>
                    {titre === 'Décisions' && (
                      <Decision
                        key={agent.question?.pendingId}
                        agent={agent}
                        horsLigne={!!horsLigne}
                      />
                    )}
                    {titre === 'À relire' && (
                      <Tour key={agent.tour!.id} agent={agent} horsLigne={!!horsLigne} />
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ),
      )}
      {!appareil.mesh?.state.cell && (
        <p className="texte-discret">
          {
            "Cet A-I-D n'est pas connecté à swarph : pas d'onglet Board. Pour le connecter, passe par ton Mac."
          }
        </p>
      )}
    </main>
  );
}

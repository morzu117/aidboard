import { Link } from 'react-router';
import type { Topic } from '../../../src/shared/model.js';
import { useLivraison } from '../data/livraison.js';
import { useAid } from '../data/useAidState.js';
import { compterControles, court, lireControles } from '../ui/livraisonVue.js';

// Chantier 27 (D133) : le résumé de l'écran Livraison dans le panneau du sujet. Il relit la PR à son
// ouverture (D18), comme l'écran.

export function OngletLivraison({ topicId, namespace }: { topicId: string; namespace: string }) {
  const { state } = useAid();
  const topic = state?.topics.find((t) => t.id === topicId);
  if (!topic) return null;
  return <Resume topic={topic} namespace={namespace} />;
}

function Resume({ topic, namespace }: { topic: Topic; namespace: string }) {
  const l = useLivraison(topic, namespace);
  const tete = l.pr?.headRefOid ?? l.git?.head ?? null;
  const fusionne = topic.state === 'merged' || l.pr?.state === 'MERGED';
  const compte = compterControles(lireControles(l.pr, l.test), tete);
  const f = l.fraicheur;
  return (
    <div className="onglet-livraison" data-node="1-3.panneau.livraison">
      {f?.etat === 'obsolete' && tete && (
        <p className="livraison-encart" data-node="1-3.panneau.livraison.obsolete">
          Revue obsolète. L’avis porte sur {court(f.commit)}, la tête est maintenant {court(tete)}.
        </p>
      )}
      {l.lecturePr.echec && (
        <p className="message-erreur" role="alert" data-node="1-3.panneau.livraison.erreur">
          {l.lecturePr.echec}
        </p>
      )}
      <dl className="onglet-livraison-liste">
        <dt>Contrôles exécutés</dt>
        <dd data-node="1-3.panneau.livraison.controles">
          {compte.total === 0
            ? 'Aucun'
            : `${compte.passes} sur ${compte.total}${compte.pannes > 0 ? ` · ${compte.pannes} en panne` : ''}`}
        </dd>
        <dt>Autorisation de livraison</dt>
        <dd data-node="1-3.panneau.livraison.autorisation">
          {fusionne
            ? `Fusionnée${tete ? ` sur ${court(tete)}` : ''}`
            : `Aucune${tete ? ` · elle ciblera ${court(tete)}` : ''}`}
        </dd>
      </dl>
      <Link
        className="bouton"
        data-node="1-3.panneau.livraison.ouvrir"
        to={`/sujets/${topic.id}/livraison`}
      >
        Ouvrir la vue livraison
      </Link>
    </div>
  );
}

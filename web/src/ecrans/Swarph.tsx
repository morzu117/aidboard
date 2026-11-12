import { useMeshLecture, instantaneMesh } from '../data/meshLecture.js';
import { useState } from 'react';
import { EcrireAuMesh } from '../ui/EcrireAuMesh.js';
import { DemandesAvis } from '../ui/DemandesAvis.js';
import { Link } from 'react-router';
import { useAid } from '../data/useAidState.js';
import { Layout } from '../ui/Layout.js';

// Chantier 25 (D102) : ce que swarph ajoute et comment s'y connecter. A-I-D n'écrit pas la config : la page
// explique, elle ne connecte rien. Le flux de connexion par téléphone (V4, Connexion) attend le chantier 33.

const EXEMPLE_CONFIG = `mesh:
  cell: ma-cell        # le nom de cette machine dans le mesh, jamais celui d'une autre
  gateway: http://mesh-gw.example.ts.net:8788`;

function Contenu() {
  const { state } = useAid();
  const nomMesh = useMeshLecture();
  const mesh = instantaneMesh(state, nomMesh);
  const [ecriture, setEcriture] = useState(false);
  return (
    <main className="page">
      <div className="entete" data-node="swarph.entete">
        <div className="entete-texte">
          <h1 className="titre-ecran" data-node="swarph.entete.titre">
            Connecter cet A-I-D à swarph
          </h1>
          <p className="texte-discret" data-node="swarph.entete.sous-titre">
            Ton cockpit marche sans swarph : sujets, agents, machines et git restent ici. Se
            connecter est un choix, jamais une condition.
          </p>
        </div>
      </div>
      {mesh && (
        <>
          <button onClick={() => setEcriture(true)}>Écrire au mesh (à blanc)</button>
          {ecriture && (
            <EcrireAuMesh
              mesh={nomMesh}
              action="dm.envoyer"
              choix
              onClose={() => setEcriture(false)}
            />
          )}
        </>
      )}
      {state?.swairm?.enabled && <DemandesAvis />}
      {mesh ? (
        <section className="groupe" data-node="swarph.configure" aria-label="Déjà configuré">
          <article className="element">
            <p className="element-detail">
              Cet A-I-D est configuré pour la cell <code>{mesh.state.cell}</code>. La connexion se
              règle dans Réglages.
            </p>
            <div className="element-actions">
              <Link
                className="bouton"
                data-node="swarph.configure.reglages"
                data-action="nav.reglages-mesh"
                to="/reglages#mesh"
              >
                Réglages, section Mesh
              </Link>
            </div>
          </article>
        </section>
      ) : (
        <>
          <section className="groupe" data-node="swarph.apport" aria-label="Ce que swarph ajoute">
            <div className="groupe-entete">
              <h2 className="titre-zone">Ce que swarph ajoute</h2>
            </div>
            <article className="element">
              <ul className="element-detail" data-node="swarph.apport.liste">
                <li>les messages du mesh dans la Boîte de réception, et le réveil par les DM ;</li>
                <li>le board swarph en lecture : projets, cartes, obligations ;</li>
                <li>l’état du monitor dans la barre du haut.</li>
              </ul>
            </article>
          </section>
          <section className="groupe" data-node="swarph.etapes" aria-label="Marche à suivre">
            <div className="groupe-entete">
              <h2 className="titre-zone">Marche à suivre</h2>
            </div>
            <article className="element">
              <ol className="element-detail" data-node="swarph.etapes.liste">
                <li data-node="swarph.etapes.installer">
                  Installer swarph : <code>swarph --version</code> doit répondre dans un terminal.
                </li>
                <li data-node="swarph.etapes.onboard">
                  Enrôler cette machine : <code>swarph onboard</code>. L’identité de la cell reste
                  dans <code>~/.config/swarph/</code>.
                </li>
                <li data-node="swarph.etapes.config">
                  Dans <code>~/.aid/config.yaml</code>, renseigner la section <code>mesh</code> :
                  <pre data-node="swarph.etapes.config.exemple">{EXEMPLE_CONFIG}</pre>
                </li>
                <li data-node="swarph.etapes.relancer">
                  Relancer le daemon (<code>aid</code>), puis Réglages, section Mesh : Connecter.
                </li>
              </ol>
              <p className="texte-faible" data-node="swarph.etapes.note">
                A-I-D n’écrit pas cette configuration et ne connecte rien depuis cette page.
              </p>
            </article>
          </section>
        </>
      )}
      <div>
        <Link
          className="bouton bouton--contour"
          data-node="swarph.retour"
          data-action="nav.accueil"
          to="/"
        >
          Continuer sans swarph
        </Link>
      </div>
    </main>
  );
}

export function Swarph() {
  return (
    <Layout screen="swarph">
      <Contenu />
    </Layout>
  );
}

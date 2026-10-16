import { Layout } from '../ui/Layout.js';

export function Reglages() {
  return (
    <Layout screen="reglages">
      <main className="page">
        <div className="entete" data-node="reglages.entete">
          <div className="entete-texte">
            <h1 className="titre-ecran" data-node="reglages.entete.titre">
              Réglages
            </h1>
          </div>
        </div>
      </main>
    </Layout>
  );
}

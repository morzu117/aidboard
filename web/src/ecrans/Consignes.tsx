import { Layout } from '../ui/Layout.js';

export function Consignes() {
  return (
    <Layout screen="consignes">
      <main className="page">
        <div className="entete" data-node="consignes.entete">
          <div className="entete-texte">
            <h1 className="titre-ecran" data-node="consignes.entete.titre">
              Consignes
            </h1>
          </div>
        </div>
      </main>
    </Layout>
  );
}

import { Layout } from '../ui/Layout.js';

export function Boite() {
  return (
    <Layout screen="1-2">
      <main className="page">
        <div className="entete" data-node="1-2.entete">
          <div className="entete-texte">
            <h1 className="titre-ecran" data-node="1-2.entete.titre">
              Boîte de réception
            </h1>
          </div>
        </div>
      </main>
    </Layout>
  );
}

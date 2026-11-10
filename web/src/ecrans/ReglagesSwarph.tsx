import { useReglages } from '../data/swarph.js';
import { CadreSwarph37_5, EtatMonitor37_5, LectureSwarph37_5 } from '../ui/EcranSwarph37_5.js';

function ContenuReglagesSwarph() {
  const lecture = useReglages();
  const resultat = lecture.result?.rights ?? null;
  return (
    <LectureSwarph37_5
      titre="Réglages swarph"
      node="reglages-swarph"
      lecture={lecture}
      resultat={resultat}
    >
      {resultat?.ok && (
        <>
          <section data-node="reglages-swarph.groupes">
            <h2>Groupes</h2>
            {resultat.data.groups.length ? (
              <ul>
                {resultat.data.groups.map((groupe) => (
                  <li key={groupe}>{groupe}</li>
                ))}
              </ul>
            ) : (
              <p>Aucun groupe.</p>
            )}
          </section>
          <section data-node="reglages-swarph.droits">
            <h2>Droits</h2>
            {resultat.data.grants.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Cible</th>
                    <th>Niveau</th>
                    <th>Origine</th>
                  </tr>
                </thead>
                <tbody>
                  {resultat.data.grants.map((droit, index) => (
                    <tr key={index} data-node={`reglages-swarph.droit-${index}`}>
                      <td>{droit.grant_type ?? 'inconnu'}</td>
                      <td>{droit.target ?? 'inconnu'}</td>
                      <td>{droit.level ?? 'inconnu'}</td>
                      <td>
                        {droit.direct === null ? 'inconnu' : droit.direct ? 'direct' : 'hérité'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p>Aucun droit.</p>
            )}
          </section>
        </>
      )}
      {lecture.result && (
        <section data-node="reglages-swarph.monitor">
          <h2>Monitor</h2>
          {lecture.result.monitor.superviseur !== null && (
            <p>
              Supervisé par {lecture.result.monitor.superviseur} : A-I-D ne le démarre ni ne
              l&apos;arrête.
            </p>
          )}
          <p>
            <EtatMonitor37_5 etat={lecture.result.monitor.monitor} />
          </p>
        </section>
      )}
      <p data-node="reglages-swarph.verification">Vérification de la cellule : à venir.</p>
      <p data-node="reglages-swarph.sonde">Sonde des outils : à venir.</p>
    </LectureSwarph37_5>
  );
}

export function ReglagesSwarph() {
  return (
    <CadreSwarph37_5>
      <ContenuReglagesSwarph />
    </CadreSwarph37_5>
  );
}

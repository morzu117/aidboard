import { AvatarCell } from '../ui/AvatarCell.js';
import { useCells } from '../data/swarph.js';
import { CadreSwarph37_5, EtatMonitor37_5, LectureSwarph37_5 } from '../ui/EcranSwarph37_5.js';

function ContenuCells() {
  const lecture = useCells();
  const resultat = lecture.result?.peers ?? null;
  const monitor = lecture.result?.monitor;
  const pairs = resultat?.ok ? resultat.data : [];
  const locale =
    monitor &&
    (pairs.find((pair) => pair.nom === monitor.cell) ?? {
      nom: monitor.cell,
      version: 'Non déclarée',
    });
  const autres = pairs
    .filter((pair) => pair.nom !== monitor?.cell)
    .slice()
    .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  return (
    <LectureSwarph37_5 titre="Cells" node="cells" lecture={lecture} resultat={resultat}>
      {resultat?.ok && (
        <>
          <table data-node="cells.tableau">
            <thead>
              <tr>
                <th>Cellule</th>
                <th>Version déclarée</th>
                <th>Monitor</th>
              </tr>
            </thead>
            <tbody>
              {[...(locale ? [locale] : []), ...autres].map((pair) => (
                <tr key={pair.nom} data-node={`cells.cellule-${pair.nom}`}>
                  <td>
                    <AvatarCell nom={pair.nom} cellLocale={monitor?.cell} />
                    {pair.nom}
                    {pair.nom === monitor?.cell && ' · toi'}
                  </td>
                  <td>{pair.version}</td>
                  <td>
                    {pair.nom === monitor?.cell && <EtatMonitor37_5 etat={monitor.monitor} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="texte-discret" data-node="cells.note">
            Version annoncée à la dernière inscription du pair, pas forcément celle qui tourne. La
            présence arrivera avec une lecture swarph dédiée.
          </p>
        </>
      )}
    </LectureSwarph37_5>
  );
}

export function Cells() {
  return (
    <CadreSwarph37_5>
      <ContenuCells />
    </CadreSwarph37_5>
  );
}

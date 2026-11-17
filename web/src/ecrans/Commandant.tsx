import { OngletsSwarph } from '../ui/OngletsSwarph.js';
import { CockpitCommandant } from '../ui/CockpitCommandant.js';
import { CadreSwarph37_5 } from '../ui/EcranSwarph37_5.js';
import { useMeshLecture } from '../data/meshLecture.js';
function Contenu() {
  const mesh = useMeshLecture();
  return (
    <main className="page">
      <OngletsSwarph />
      <CockpitCommandant key={mesh} mesh={mesh} />
    </main>
  );
}
export function Commandant() {
  return (
    <CadreSwarph37_5>
      <Contenu />
    </CadreSwarph37_5>
  );
}

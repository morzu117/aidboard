import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';
import { VERBES_LECTURE, VERBES_PROXY } from '../../src/daemon/mesh/proxy.js';

const racine = join(import.meta.dirname, '../..');
function fichiers(dossier: string): string[] {
  return readdirSync(dossier, { withFileTypes: true }).flatMap((entree) => {
    const chemin = join(dossier, entree.name);
    return entree.isDirectory() ? fichiers(chemin) : [chemin];
  });
}
test('D257 : aucun chemin d’envoi dans le daemon et le partagé', () => {
  // Méthode HTTP pour la rotation de clé PDA, aucun argv swarph.
  const exceptions = ['src/daemon/routes/host.ts'];
  for (const fichier of ['src/daemon', 'src/shared'].flatMap((d) => fichiers(join(racine, d)))) {
    const nom = relative(racine, fichier);
    const source = readFileSync(fichier, 'utf8');
    if (nom !== 'src/shared/ecritures.ts' && !exceptions.includes(nom))
      expect(source, nom).not.toMatch(/['"](?:say|send|post)['"]/);
    const chemins = source.matchAll(/['"`]([^'"`]*\/api\/[^'"`]*)['"`]/g);
    for (const [, chemin] of chemins) {
      if (chemin!.includes('envoyer') || chemin!.includes('ecrire/'))
        expect(chemin, nom).toBe('/api/swarph/ecrire/apercu');
    }
  }
});

test('D268 : les lectures ne disposent que des verbes de VERBES_LECTURE', () => {
  const source = readFileSync(join(racine, 'src/daemon/mesh/lecteur.ts'), 'utf8');
  expect(source).toContain('creerProxyClient({ socket, verbes: VERBES_LECTURE })');
  for (const verbe of VERBES_PROXY) expect(source).not.toContain(verbe);
  const verbes = [...source.matchAll(/verb = '(.*?)'/g)].map((m) => m[1]);
  for (const verbe of verbes) expect(VERBES_LECTURE).toContain(verbe);
  for (const nom of ['board.ts', 'lectures.ts']) {
    const reader = readFileSync(join(racine, 'src/daemon/mesh', nom), 'utf8');
    expect(reader).not.toMatch(/creerProxyClient|\.appeler\(/);
  }
});

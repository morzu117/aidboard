import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { loadConfig } from '../src/daemon/config.js';
import { ajouterMesh, oublierMesh } from '../src/daemon/mesh/config-rejoindre.js';
import { resolvePaths } from '../src/daemon/paths.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aid-config-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
const config = { cell: 'peer-a', gateway: 'https://aid-e2e.ts.net' };
const paths = () => resolvePaths(home);
const lire = () => readFileSync(paths().config, 'utf8');

test('ajout puis oubli : commentaires, droits et autres réglages conservés', () => {
  writeFileSync(paths().config, '# garder\nport: 4870\nmeshes:\n  principal: {}\n');
  chmodSync(paths().config, 0o640);
  ajouterMesh(paths(), 'essai', config);
  expect(loadConfig(paths()).meshes.essai).toMatchObject(config);
  expect(lire()).toContain('# garder');
  expect(statSync(paths().config).mode & 0o777).toBe(0o640);
  oublierMesh(paths(), 'essai');
  expect(loadConfig(paths()).meshes.essai).toBeUndefined();
  expect(loadConfig(paths()).port).toBe(4870);
  expect(statSync(paths().config).mode & 0o777).toBe(0o640);
});

test('ancienne forme : aucun réglage ni commentaire perdu dans la conversion D311', () => {
  const ancien = `# configuration historique
mesh:
  bin: /opt/swarph
  tailscale:
    manage: false
    bin: /opt/tailscale
  cell: peer-b # identité conservée
  gateway: https://example.com
  home: ${home}
  cellFile: ${home}/cell.yaml
  stateRoot: ${home}/state
  inboxLog: ${home}/inbox.log
  proxySocket: ${home}/proxy.sock
  proxyLectureSeule: true
  avis:
    baseline: exemple
`;
  // Le jeu de réglages est relu avant et après : la conversion préserve sa sémantique.
  writeFileSync(paths().config, ancien);
  const avant = loadConfig(paths());
  ajouterMesh(paths(), 'essai', config);
  const apres = loadConfig(paths());
  expect(apres.meshes.principal).toEqual(avant.meshes.principal);
  expect(apres.mesh.bin).toBe(avant.mesh.bin);
  expect(apres.mesh.tailscale).toEqual(avant.mesh.tailscale);
  expect(lire()).toContain('# identité conservée');
  expect(lire()).toContain('# configuration historique');
});

test.each(['mesh: [', 'meshes: [1, 2]', 'port: invalide', 'mesh: { cell: peer-b }\nmeshes: {}'])(
  'config invalide inchangée : %s',
  (texte) => {
    writeFileSync(paths().config, texte);
    expect(() => ajouterMesh(paths(), 'essai', config)).toThrow();
    expect(() => oublierMesh(paths(), 'essai')).toThrow();
    expect(lire()).toBe(texte);
  },
);

test('un mesh existant, principal et un nom invalide ne sont jamais écrasés', () => {
  writeFileSync(paths().config, 'meshes:\n  principal: {}\n  essai: {cell: peer-b}\n');
  const avant = lire();
  expect(() => ajouterMesh(paths(), 'essai', config)).toThrow('Mesh déjà configuré');
  expect(() => oublierMesh(paths(), 'principal')).toThrow('principal');
  expect(() => ajouterMesh(paths(), '../autre', config)).toThrow('Nom de mesh invalide');
  expect(() => oublierMesh(paths(), 'absent')).toThrow('Mesh inconnu');
  expect(lire()).toBe(avant);
});

test('revalidation de la sortie : un couple cell/gateway en double ne laisse aucune écriture', () => {
  writeFileSync(
    paths().config,
    'meshes:\n  principal: {cell: peer-a, gateway: https://aid-e2e.ts.net}\n',
  );
  const avant = lire();
  expect(() => ajouterMesh(paths(), 'essai', config)).toThrow('config.yaml invalide');
  expect(lire()).toBe(avant);
});

test('un fichier illisible ne peut pas être remplacé', () => {
  mkdirSync(paths().config);
  expect(() => ajouterMesh(paths(), 'essai', config)).toThrow('illisible');
  expect(statSync(paths().config).isDirectory()).toBe(true);
});

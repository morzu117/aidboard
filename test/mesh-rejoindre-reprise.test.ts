import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import { LanceurRejoindre } from '../src/daemon/mesh/rejoindre.js';

let dossier: string;
let lanceur: LanceurRejoindre | undefined;
const demande = { cell: 'peer-a', mesh: 'essai', gateway: 'https://EXAMPLE.com/' };
const fichier = () => join(dossier, 'rejoindre.json');
const jeton = () => join(dossier, 'home/.config/swarph/peer-a.peer_token');
const config = () => ({
  mesh: { ...DEFAULT_CONFIG.mesh, bin: join(dossier, 'swarph'), home: join(dossier, 'home') },
  meshes: DEFAULT_CONFIG.meshes,
});
const reprendre = () => new LanceurRejoindre(config(), undefined, { home: dossier });

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), 'aid-reprise-'));
});
afterEach(async () => {
  await lanceur?.annuler();
  lanceur = undefined;
  rmSync(dossier, { recursive: true, force: true });
});

test.each(['absent', 'fichier', 'lien'])(
  'reprise avec jeton %s, sans relancer ni lire le jeton',
  (type) => {
    writeFileSync(fichier(), JSON.stringify({ ...demande, depuis: Date.now() }), { mode: 0o600 });
    if (type !== 'absent') {
      mkdirSync(join(dossier, 'home/.config/swarph'), { recursive: true });
      if (type === 'lien') symlinkSync(join(dossier, 'absent'), jeton());
      else writeFileSync(jeton(), '', { mode: 0o000 });
    }
    expect(reprendre().etat()).toEqual({
      etat: type === 'absent' ? 'interrompue' : 'a-voir',
      cell: demande.cell,
      mesh: demande.mesh,
    });
    expect(() => lstatSync(fichier())).toThrow();
    expect(reprendre().etat()).toEqual({ etat: 'aucune' });
  },
);

test.each([
  '{',
  'null',
  '{}',
  JSON.stringify({ ...demande, cell: '../peer-a', depuis: 1 }),
  JSON.stringify({ ...demande, depuis: 'hier' }),
])('état mal formé ignoré et effacé : %s', (texte) => {
  writeFileSync(fichier(), texte);
  expect(reprendre().etat()).toEqual({ etat: 'aucune' });
  expect(() => lstatSync(fichier())).toThrow();
});

test('état illisible ignoré et lien effacé', () => {
  symlinkSync(join(dossier, 'absent'), fichier());
  expect(reprendre().etat()).toEqual({ etat: 'aucune' });
  expect(() => lstatSync(fichier())).toThrow();
});

test.each([{}, { attente: true }, { raison: 'access_denied' }])(
  'état privé sans secret puis effacé à la fin : %j',
  async (scenario) => {
    copyFileSync(resolve('test/fixtures/fake-swarph-join.mjs'), join(dossier, 'swarph'));
    chmodSync(join(dossier, 'swarph'), 0o700);
    writeFileSync(join(dossier, 'scenario.json'), JSON.stringify(scenario));
    lanceur = reprendre();
    const avant = Date.now();
    lanceur.lancer(demande);
    await vi.waitFor(() => expect(lanceur!.etat().etat).toBe('en-attente'));
    const texte = readFileSync(fichier(), 'utf8');
    expect(JSON.parse(texte)).toEqual({
      ...demande,
      gateway: 'https://example.com',
      depuis: expect.any(Number),
    });
    expect(JSON.parse(texte).depuis).toBeGreaterThanOrEqual(avant);
    expect(lstatSync(fichier()).mode & 0o777).toBe(0o600);
    expect(texte).not.toContain('ABCD-EFGH');
    expect(texte).not.toContain('FAUX-JETON');
    if ('attente' in scenario) await lanceur.annuler();
    else await vi.waitFor(() => expect(['approuve', 'refuse']).toContain(lanceur!.etat().etat));
    expect(() => lstatSync(fichier())).toThrow();
  },
);

test('échec de lancement : état effacé après le résultat final', async () => {
  lanceur = reprendre();
  lanceur.lancer(demande);
  await vi.waitFor(() => expect(lanceur!.etat().etat).toBe('echec'));
  expect(() => lstatSync(fichier())).toThrow();
});

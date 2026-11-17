import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { IdentifiantsCockpit } from '../src/daemon/commandant/identifiant.js';
import { MASK, maskSecrets } from '../src/daemon/secrets.js';
import { IDENTIFIANT_COCKPIT_TEST } from './fixtures/passerelle-commandant.js';

const dossiers: string[] = [];
afterEach(() => {
  for (const d of dossiers.splice(0)) rmSync(d, { recursive: true, force: true });
});
function preparer() {
  const home = mkdtempSync(join(tmpdir(), 'aid-commandant-identifiant-'));
  dossiers.push(home);
  return { home, coffre: new IdentifiantsCockpit(home) };
}
it('écrit en 0600 dans 0700, relit la date et supprime sans config.yaml', () => {
  const { home, coffre } = preparer();
  expect(coffre.lire('principal')).toBeNull();
  coffre.ecrire('principal', IDENTIFIANT_COCKPIT_TEST);
  expect(statSync(join(home, 'cockpit')).mode & 0o777).toBe(0o700);
  expect(statSync(join(home, 'cockpit', 'principal.token')).mode & 0o777).toBe(0o600);
  expect(coffre.lire('principal')?.valeur === IDENTIFIANT_COCKPIT_TEST).toBe(true);
  expect(Number.isFinite(Date.parse(coffre.lire('principal')!.saisie))).toBe(true);
  expect(existsSync(join(home, 'config.yaml'))).toBe(false);
  expect(readdirSync(join(home, 'cockpit'))).toEqual(['principal.token']);
  coffre.supprimer('principal');
  coffre.supprimer('principal');
  expect(coffre.lire('principal')).toBeNull();
});
it.each([
  '',
  '../sortie',
  '..',
  '/sortie',
  'a/b',
  'a\\b',
  'a.token/../../sortie',
  'A',
  'a'.repeat(33),
])('refuse un nom de mesh invalide %# avant toute écriture', (mesh) => {
  const { home, coffre } = preparer();
  for (const f of [
    () => coffre.ecrire(mesh, IDENTIFIANT_COCKPIT_TEST),
    () => coffre.lire(mesh),
    () => coffre.supprimer(mesh),
  ])
    expect(f).toThrow('Nom de mesh invalide');
  expect(readdirSync(home)).toEqual([]);
});
it.each([
  undefined,
  null,
  1,
  '',
  'swck_' + 'a'.repeat(42),
  'swck_' + 'a'.repeat(44),
  'swck_' + '+'.repeat(43),
  'swck_' + '/'.repeat(43),
  'autre_' + 'a'.repeat(43),
])('refuse un format invalide sans remplacer le fichier %#', (valeur) => {
  const { home, coffre } = preparer();
  coffre.ecrire('principal', IDENTIFIANT_COCKPIT_TEST);
  expect(() => coffre.ecrire('principal', valeur)).toThrow('Format');
  expect(
    readFileSync(join(home, 'cockpit', 'principal.token'), 'utf8') === IDENTIFIANT_COCKPIT_TEST,
  ).toBe(true);
});
it('remplace par renommage sans suivre le lien cible ni laisser de temporaire', () => {
  const { home, coffre } = preparer();
  coffre.ecrire('principal', IDENTIFIANT_COCKPIT_TEST);
  const cible = join(home, 'cible');
  writeFileSync(cible, 'ne pas modifier');
  rmSync(join(home, 'cockpit', 'principal.token'));
  symlinkSync(cible, join(home, 'cockpit', 'principal.token'));
  expect(() => coffre.lire('principal')).toThrow('Lecture');
  coffre.ecrire('principal', IDENTIFIANT_COCKPIT_TEST);
  expect(readFileSync(cible, 'utf8')).toBe('ne pas modifier');
  expect(readdirSync(join(home, 'cockpit'))).toEqual(['principal.token']);
});
it('refuse un dossier lié et des droits trop ouverts', () => {
  const { home, coffre } = preparer();
  const autre = preparer().home;
  symlinkSync(autre, join(home, 'cockpit'));
  expect(() => coffre.ecrire('principal', IDENTIFIANT_COCKPIT_TEST)).toThrow('Écriture');
  expect(() => coffre.supprimer('principal')).toThrow('Suppression');
  rmSync(join(home, 'cockpit'));
  coffre.ecrire('principal', IDENTIFIANT_COCKPIT_TEST);
  chmodSync(join(home, 'cockpit', 'principal.token'), 0o644);
  expect(() => coffre.lire('principal')).toThrow('Lecture');
});
it('masque le préfixe cockpit, y compris ses caractères base64url', () => {
  expect(maskSecrets(IDENTIFIANT_COCKPIT_TEST)).toBe('swck_' + MASK);
  expect(maskSecrets('swck_' + '_-'.repeat(21) + '_')).toBe('swck_' + MASK);
});

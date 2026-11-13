import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';

const racine = join(import.meta.dirname, '..');
const fichiers = ['package.json', 'package-lock.json', 'app/src-tauri/tauri.conf.json'];

test('prépare les trois versions et refuse un semver invalide sans écriture', () => {
  const dossier = mkdtempSync(join(tmpdir(), 'aid-preparer-release-'));
  try {
    for (const fichier of fichiers) {
      mkdirSync(dirname(join(dossier, fichier)), { recursive: true });
      cpSync(join(racine, fichier), join(dossier, fichier));
    }
    writeFileSync(join(dossier, 'temoin.txt'), 'inchangé\n');
    const lire = (fichier: string) => readFileSync(join(dossier, fichier), 'utf8');
    const instantane = () =>
      Object.fromEntries(
        readdirSync(dossier, { recursive: true, withFileTypes: true })
          .filter((entree) => entree.isFile())
          .map((entree) => {
            const chemin = join(entree.parentPath, entree.name);
            return [chemin, readFileSync(chemin, 'utf8')];
          }),
      );
    const lancer = (version: string, sortieArchives = '') =>
      execFileSync(join(racine, 'scripts/preparer-release.sh'), [version], {
        cwd: dossier,
        env: { ...process.env, AID_RELEASE_DIR: sortieArchives },
        stdio: 'pipe',
      });
    const avant = instantane();
    for (const version of ['invalide', '1.2.3-rc.1', 'v1.2.3', '01.2.3', '']) {
      expect(() => lancer(version)).toThrow();
      expect(instantane()).toEqual(avant);
    }
    lancer('98.76.54');
    for (const fichier of fichiers) {
      expect(JSON.parse(lire(fichier)).version).toBe('98.76.54');
    }
    expect(JSON.parse(lire('package-lock.json')).packages[''].version).toBe('98.76.54');
    expect(Object.keys(instantane()).sort()).toEqual(Object.keys(avant).sort());
    expect(lire('temoin.txt')).toBe('inchangé\n');
    // La variable de sortie des archives ne doit pas déplacer la préparation.
    lancer('98.76.55', join(dossier, 'sortie-archives'));
    for (const fichier of fichiers) {
      expect(JSON.parse(lire(fichier)).version).toBe('98.76.55');
    }
    expect(Object.keys(instantane()).sort()).toEqual(Object.keys(avant).sort());
    expect(lire('temoin.txt')).toBe('inchangé\n');
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
}, 30_000);

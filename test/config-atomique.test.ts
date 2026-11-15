import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigError,
  ecrireConfig,
  ecrireModeHostActif,
  ecrireModeHostCode,
  ecrireModeHostPda,
  ecrireModeHostPush,
  loadConfig,
  writeDefaultConfigIfAbsent,
} from '../src/daemon/config.js';
import { resolvePaths } from '../src/daemon/paths.js';

// Une copie configurable permet d'intercepter les exports ESM de node:fs.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
}));

let dossier: string;
let chemins: ReturnType<typeof resolvePaths>;
const ecrivains = [
  ['actif', ecrireModeHostActif],
  ['push', ecrireModeHostPush],
  ['code', ecrireModeHostCode],
  ['pda', ecrireModeHostPda],
] as const;

beforeEach(() => {
  dossier = fs.mkdtempSync(join(tmpdir(), 'config-atomique-'));
  chemins = resolvePaths(dossier);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dossier, { recursive: true, force: true });
});

function temporaires(repertoire = dossier): string[] {
  return fs.readdirSync(repertoire).filter((nom) => /^\.config\.yaml\..*\.tmp$/.test(nom));
}

describe('écriture atomique de config.yaml (D337)', () => {
  it.each(['unlinkSync', 'closeSync'] as const)(
    '%s : le nettoyage ne masque pas une erreur d’écriture',
    (operation) => {
      const ancien = 'port: 4900\n';
      fs.writeFileSync(chemins.config, ancien);
      const erreur = new Error('écriture interrompue');
      vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
        throw erreur;
      });
      const nettoyer = fs[operation];
      const nettoyage = vi
        .spyOn(fs, operation)
        .mockImplementationOnce((fichier: fs.PathLike | number) => {
          // Fermer réellement le descripteur pour ne pas le laisser ouvert dans le test.
          if (operation === 'closeSync') (nettoyer as typeof fs.closeSync)(fichier as number);
          throw new Error('nettoyage impossible');
        });
      let recue: unknown;
      try {
        ecrireConfig(chemins, 'port: 4901\n');
      } catch (echec) {
        recue = echec;
      }
      expect(recue).toBe(erreur);
      expect(nettoyage).toHaveBeenCalledOnce();
      expect(fs.readFileSync(chemins.config, 'utf8')).toBe(ancien);
      expect(temporaires()).toHaveLength(operation === 'unlinkSync' ? 1 : 0);
    },
  );

  it.each(ecrivains)(
    '%s : conserve le contenu, les droits et ne laisse aucun temporaire',
    (cle, ecrire) => {
      fs.writeFileSync(chemins.config, '# commentaire conservé\nport: 4900\n');
      if (process.platform !== 'win32') fs.chmodSync(chemins.config, 0o640);
      ecrire(chemins, true);
      expect(loadConfig(chemins).modeHost[cle]).toBe(true);
      expect(loadConfig(chemins).port).toBe(4900);
      expect(fs.readFileSync(chemins.config, 'utf8')).toContain('# commentaire conservé');
      if (process.platform !== 'win32')
        expect(fs.statSync(chemins.config).mode & 0o777).toBe(0o640);
      expect(temporaires()).toEqual([]);
    },
  );

  it.each(ecrivains)('%s : une écriture interrompue garde les octets initiaux', (_cle, ecrire) => {
    const ancien = Buffer.from('# café\r\nport: 4900\r\n');
    fs.writeFileSync(chemins.config, ancien);
    const ecriture = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((fichier) => {
      expect(typeof fichier).toBe('number');
      ecriture(fichier, 'tronqué');
      throw new Error('coupure simulée');
    });
    expect(() => ecrire(chemins, true)).toThrow('coupure simulée');
    expect(fs.readFileSync(chemins.config)).toEqual(ancien);
    expect(temporaires()).toEqual([]);
  });

  it.each(ecrivains)('%s : un texte refusé par parseConfig reste intact', (_cle, ecrire) => {
    const ancien = 'port: invalide\n';
    fs.writeFileSync(chemins.config, ancien);
    expect(() => ecrire(chemins, true)).toThrow(ConfigError);
    expect(fs.readFileSync(chemins.config, 'utf8')).toBe(ancien);
    expect(temporaires()).toEqual([]);
  });

  it.each(['fsyncSync', 'renameSync'] as const)(
    '%s : un échec avant remplacement garde le fichier et nettoie le temporaire',
    (operation) => {
      const ancien = Buffer.from('port: 4900\n');
      fs.writeFileSync(chemins.config, ancien);
      vi.spyOn(fs, operation).mockImplementationOnce(() => {
        throw new Error('échec simulé');
      });
      expect(() => ecrireModeHostActif(chemins, true)).toThrow('échec simulé');
      expect(fs.readFileSync(chemins.config)).toEqual(ancien);
      expect(temporaires()).toEqual([]);
    },
  );

  it('synchronise et ferme le fichier avant le renommage, puis synchronise le dossier', () => {
    const ouvrir = vi.spyOn(fs, 'openSync');
    const ecrire = vi.spyOn(fs, 'writeFileSync');
    const synchroniser = vi.spyOn(fs, 'fsyncSync');
    const fermer = vi.spyOn(fs, 'closeSync');
    const renommer = vi.spyOn(fs, 'renameSync');
    ecrireModeHostActif(chemins, true);
    expect(ouvrir.mock.calls[0]![0]).toMatch(/\.config\.yaml\..*\.tmp$/);
    expect(ouvrir.mock.calls[0]![1]).toBe('wx');
    const ordre = [
      ouvrir.mock.invocationCallOrder[0]!,
      ecrire.mock.invocationCallOrder[0]!,
      synchroniser.mock.invocationCallOrder[0]!,
      fermer.mock.invocationCallOrder[0]!,
      renommer.mock.invocationCallOrder[0]!,
      ouvrir.mock.invocationCallOrder[1]!,
    ];
    expect(ordre).toEqual([...ordre].sort((a, b) => a - b));
    expect(ouvrir.mock.calls[1]).toEqual([dossier, 'r']);
    if (process.platform !== 'win32') {
      expect(synchroniser.mock.calls).toHaveLength(2);
      expect(synchroniser.mock.invocationCallOrder[1]!).toBeGreaterThan(ordre[5]!);
      expect(fermer.mock.invocationCallOrder[1]!).toBeGreaterThan(
        synchroniser.mock.invocationCallOrder[1]!,
      );
    }
  });

  it('ignore un échec de synchronisation du dossier après le remplacement', () => {
    vi.spyOn(fs, 'fsyncSync')
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('synchronisation du dossier indisponible');
      });
    expect(() => ecrireModeHostActif(chemins, true)).not.toThrow();
    expect(loadConfig(chemins).modeHost.actif).toBe(true);
    expect(temporaires()).toEqual([]);
  });

  it('crée la configuration par défaut une seule fois et sans temporaire', () => {
    writeDefaultConfigIfAbsent(chemins);
    expect(loadConfig(chemins).modeHost.actif).toBe(false);
    expect(fs.readFileSync(chemins.config, 'utf8')).toContain('# Configuration');
    fs.writeFileSync(chemins.config, 'port: 4900\n');
    writeDefaultConfigIfAbsent(chemins);
    expect(fs.readFileSync(chemins.config, 'utf8')).toBe('port: 4900\n');
    expect(temporaires()).toEqual([]);
  });

  it('nettoie aussi une création par défaut interrompue', () => {
    const ecriture = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((fichier) => {
      ecriture(fichier, 'tronqué');
      throw new Error('coupure simulée');
    });
    expect(() => writeDefaultConfigIfAbsent(chemins)).toThrow('coupure simulée');
    expect(fs.existsSync(chemins.config)).toBe(false);
    expect(temporaires()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('crée les fichiers neufs en 0600 malgré le umask', () => {
    const masque = process.umask(0o077);
    try {
      writeDefaultConfigIfAbsent(chemins);
      expect(fs.statSync(chemins.config).mode & 0o777).toBe(0o600);
      fs.unlinkSync(chemins.config);
      ecrireModeHostActif(chemins, true);
      expect(fs.statSync(chemins.config).mode & 0o777).toBe(0o600);
      fs.chmodSync(chemins.config, 0o640);
      ecrireModeHostActif(chemins, false);
      expect(fs.statSync(chemins.config).mode & 0o777).toBe(0o640);
    } finally {
      process.umask(masque);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'garde le lien et remplace sa cible dans un autre dossier',
    () => {
      const destination = join(dossier, 'cible');
      fs.mkdirSync(destination);
      const cible = join(destination, 'configuration.yaml');
      fs.writeFileSync(cible, 'port: 4900\n', { mode: 0o640 });
      fs.symlinkSync(join('cible', 'configuration.yaml'), chemins.config);
      ecrireModeHostActif(chemins, true);
      expect(fs.lstatSync(chemins.config).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(chemins.config)).toBe(join('cible', 'configuration.yaml'));
      expect(fs.readFileSync(cible, 'utf8')).toContain('actif: true');
      expect(fs.statSync(cible).mode & 0o777).toBe(0o640);
      expect(temporaires(destination)).toEqual([]);
      expect(temporaires()).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')('refuse un lien cassé sans rien écrire', () => {
    const cible = join(dossier, 'absente.yaml');
    fs.symlinkSync(cible, chemins.config);
    for (const [, ecrire] of ecrivains) {
      expect(() => ecrire(chemins, true)).toThrow(ConfigError);
    }
    expect(() => writeDefaultConfigIfAbsent(chemins)).toThrow(ConfigError);
    expect(fs.lstatSync(chemins.config).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(cible)).toBe(false);
    expect(fs.readdirSync(dossier)).toEqual(['config.yaml']);
  });
});

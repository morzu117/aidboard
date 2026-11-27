import { execFileSync } from 'node:child_process';
import * as fichiers from 'node:fs/promises';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  comparerEmpreintes,
  empreinteEnvironnement,
  entreesGelees,
} from '../../src/daemon/boucle/controles.js';
import { commitFile, makeOriginAndClone, sh } from '../helpers/git.js';

let dossier: string;
let home: string;

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), 'aid-relecture-controles-'));
  home = join(dossier, 'home');
  mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('AID_HOME', join(dossier, 'aid-home'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dossier, { recursive: true, force: true });
});

function ecrire(fichier: string, contenu: string) {
  const chemin = join(home, fichier);
  mkdirSync(dirname(chemin), { recursive: true });
  writeFileSync(chemin, contenu);
  return chemin;
}

test.each(['pnpm run gate', 'yarn gate', 'bun run gate'])(
  '%s gèle le script appelé dans package.json',
  async (commande) => {
    const { clone } = makeOriginAndClone(dossier);
    commitFile(clone, 'agent.yml', `gates: { gate: "${commande}" }\n`);
    commitFile(clone, 'package.json', '{"scripts":{"gate":"echo avant"}}\n');
    const go = sh(clone, 'rev-parse', 'HEAD');
    commitFile(clone, 'package.json', '{"scripts":{"gate":"echo après"}}\n');
    const tete = sh(clone, 'rev-parse', 'HEAD');

    expect(await entreesGelees(clone, go, tete)).toContainEqual(
      expect.objectContaining({ fichier: 'package.json' }),
    );
  },
);

test.each(['ci.sh', 'Makefile'])('./ci.sh && make check gèle %s', async (fichier) => {
  const { clone } = makeOriginAndClone(dossier);
  commitFile(clone, 'agent.yml', 'gates: { gate: "./ci.sh && make check" }\n');
  commitFile(clone, 'ci.sh', '#!/bin/sh\necho fictif\n');
  commitFile(clone, 'Makefile', 'check:\n\t@echo fictif\n');
  const go = sh(clone, 'rev-parse', 'HEAD');
  commitFile(clone, fichier, '# modification fictive\n');
  const tete = sh(clone, 'rev-parse', 'HEAD');

  expect(await entreesGelees(clone, go, tete)).toContainEqual(expect.objectContaining({ fichier }));
});

test.each(['allowedTools', 'enabledMcpjsonServers', 'disabledMcpjsonServers'])(
  'l’empreinte détecte %s à la racine de .claude.json',
  async (cle) => {
    const chemin = ecrire('.claude.json', '{}');
    const avant = await empreinteEnvironnement(home);
    ecrire('.claude.json', JSON.stringify({ [cle]: ['fictif'] }));

    expect(comparerEmpreintes(avant, await empreinteEnvironnement(home))).toContain(chemin);
  },
);

test('l’empreinte suit la cible de settings.json et relève le changement de contenu', async () => {
  const cible = ecrire('reglages-fictifs.json', '{"exemple":"avant"}');
  mkdirSync(join(home, '.claude'));
  symlinkSync(cible, join(home, '.claude/settings.json'));
  const avant = await empreinteEnvironnement(home);
  ecrire('reglages-fictifs.json', '{"exemple":"apres"}');

  expect(comparerEmpreintes(avant, await empreinteEnvironnement(home))).not.toEqual([]);
});

test.each(['.claude/hooks/x.sh', '.codex/AGENTS.md', '.npmrc'])(
  'l’empreinte détecte un changement de %s',
  async (fichier) => {
    const chemin = ecrire(fichier, '# avant\n');
    const avant = await empreinteEnvironnement(home);
    ecrire(fichier, '# après\n');
    expect(comparerEmpreintes(avant, await empreinteEnvironnement(home))).toContain(chemin);
  },
);

test.each(['hook', 'statusLine'])('l’empreinte suit le script nommé par %s', async (type) => {
  const script = ecrire('scripts/fictif.sh', '# avant\n');
  const commande = { type: 'command', command: `sh "${script}"` };
  const reglages =
    type === 'hook' ? { hooks: { Stop: [{ hooks: [commande] }] } } : { statusLine: commande };
  ecrire('.claude/settings.json', JSON.stringify(reglages));
  const avant = await empreinteEnvironnement(home);
  ecrire('scripts/fictif.sh', '# après\n');

  expect(comparerEmpreintes(avant, await empreinteEnvironnement(home))).toContain(script);
});

test.each([
  '.codex/sessions/session.jsonl',
  '.codex/archived_sessions/session.jsonl',
  '.codex/log/journal.log',
  '.codex/auth.json',
])('l’empreinte ignore %s', async (fichier) => {
  const avant = await empreinteEnvironnement(home);
  ecrire(fichier, '{}\n');

  expect(comparerEmpreintes(avant, await empreinteEnvironnement(home))).toEqual([]);
});

test('une boucle de liens symboliques laisse le relevé se terminer', async () => {
  mkdirSync(join(home, '.claude'));
  symlinkSync('cycle-fictif.json', join(home, '.claude/settings.json'));
  symlinkSync('settings.json', join(home, '.claude/cycle-fictif.json'));
  const surveille = ecrire('.gitconfig', '# avant\n');
  const avant = await empreinteEnvironnement(home);
  ecrire('.gitconfig', '# après\n');

  expect(comparerEmpreintes(avant, await empreinteEnvironnement(home))).toContain(surveille);
}, 2_000);

test('l’empreinte marque un lien sortant et relève son texte sans ouvrir sa cible', async () => {
  const cible = join(dossier, 'reglages-hors-home.json');
  const autreCible = join(dossier, 'autres-reglages-hors-home.json');
  const lien = join(home, '.claude', 'settings.json');
  mkdirSync(dirname(lien));
  writeFileSync(cible, '{}\n');
  writeFileSync(autreCible, '{}\n');
  symlinkSync(cible, lien);
  const ouvrir = vi.fn(fichiers.open);
  const relever = () => empreinteEnvironnement(home, { ...fichiers, open: ouvrir });

  const avant = await relever();
  writeFileSync(cible, '{"modifie":true}\n');
  expect(await relever()).toEqual(avant);
  rmSync(lien);
  symlinkSync(autreCible, lien);
  const apres = await relever();

  expect(ouvrir).not.toHaveBeenCalled();
  expect(comparerEmpreintes(avant, apres)).toEqual([lien]);
  expect(avant[lien]).toMatch(/sortant/i);
  expect(apres[lien]).toMatch(/sortant/i);
});

test('un FIFO dans un dossier relevé ne bloque pas l’empreinte', async () => {
  const ordinaire = ecrire('.claude/commands/fictif.md', '# Fictif\n');
  const fifo = join(dirname(ordinaire), 'fifo-fictif');
  execFileSync('mkfifo', [fifo]);

  const debut = performance.now();
  const empreinte = await empreinteEnvironnement(home);
  expect(performance.now() - debut).toBeLessThan(1_000);
  expect(empreinte).toHaveProperty([ordinaire]);
}, 1_000);

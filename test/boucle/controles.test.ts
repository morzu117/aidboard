import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  avertissements,
  comparerEmpreintes,
  empreinteEnvironnement,
  entreesGelees,
  invaliderSiTeteBouge,
  processusDansWorktree,
} from '../../src/daemon/boucle/controles.js';

function ecrire(racine: string, fichier: string, contenu: string): void {
  const chemin = join(racine, fichier);
  mkdirSync(dirname(chemin), { recursive: true });
  writeFileSync(chemin, contenu);
}

describe('contrôles du diff depuis le GO', () => {
  let depot: string;

  function git(...args: string[]): string {
    return execFileSync(
      'git',
      [
        '-c',
        'user.name=Personne fictive',
        '-c',
        'user.email=fictif@example.com',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { cwd: depot, encoding: 'utf8' },
    ).trim();
  }

  function commiter(fichiers: Record<string, string>): string {
    for (const [fichier, contenu] of Object.entries(fichiers)) ecrire(depot, fichier, contenu);
    git('add', '--all');
    git('commit', '-qm', 'Changement fictif');
    return git('rev-parse', 'HEAD');
  }

  beforeEach(() => {
    depot = mkdtempSync(join(tmpdir(), 'aid-boucle-controles-'));
    git('init', '-q');
  });

  afterEach(() => {
    rmSync(depot, { recursive: true, force: true });
  });

  it('relève les entrées gelées et la configuration de projet avec une raison', async () => {
    const config = 'export default { test: { setupFiles: ["./test/preparation.ts"] } };';
    const go = commiter({
      'agent.yml': 'gates: { gate: "npm run gate" }\n',
      'package.json': '{"scripts":{"gate":"vitest run"}}\n',
      'vitest.config.ts': config,
      'test/preparation.ts': 'export {};\n',
      'package-lock.json': '{"lockfileVersion":3,"packages":{}}\n',
      'src/fictif.ts': 'export const valeur = 1;\n',
    });
    const tete = commiter({
      'agent.yml': 'gates: { gate: "npm run test" }\n',
      'package.json': '{"scripts":{"gate":"vitest run test/fictif.test.ts"}}\n',
      'vitest.config.ts': `${config}\n// Réglage fictif\n`,
      'test/preparation.ts': 'export const prepare = true;\n',
      'package-lock.json': '{"lockfileVersion":3,"requires":true,"packages":{}}\n',
      'src/.claude/settings.json': '{}\n',
      'src/CLAUDE.md': '# Consignes fictives\n',
      'src/AGENTS.md': '# Consignes fictives\n',
      '.mcp.json': '{"mcpServers":{}}\n',
      'src/.mcp.json': '{"mcpServers":{}}\n',
      '.github/workflows/fictif.yml': 'name: Vérification fictive\n',
      'src/fictif.ts': 'export const valeur = 2;\n',
    });
    commiter({ 'agent.yml': 'gates: { gate: "npm run gate" }\n' });
    ecrire(depot, 'test/preparation.ts', 'export {};\n');

    const attendus = [
      'agent.yml',
      'package.json',
      'vitest.config.ts',
      'test/preparation.ts',
      'package-lock.json',
      'src/.claude/settings.json',
      'src/CLAUDE.md',
      'src/AGENTS.md',
      '.mcp.json',
      'src/.mcp.json',
      '.github/workflows/fictif.yml',
    ];
    const entrees = await entreesGelees(depot, go, tete);

    expect(entrees).toHaveLength(attendus.length);
    for (const fichier of attendus) {
      expect(entrees).toContainEqual(
        expect.objectContaining({ fichier, raison: expect.stringMatching(/\S/) }),
      );
    }
  });

  it('classe les réglages d’éditeur, de shell et de sous-modules en avertissements', async () => {
    const go = commiter({
      'package.json': '{"description":"Avant","scripts":{"gate":"vitest run"}}\n',
    });
    const tete = commiter({
      'package.json': '{"description":"Après","scripts":{"gate":"vitest run"}}\n',
      '.vscode/tasks.json': '{"version":"2.0.0","tasks":[]}\n',
      '.envrc': 'export EXEMPLE=1\n',
      '.gitmodules': '# Exemple sans sous-module\n',
    });

    expect(await entreesGelees(depot, go, tete)).toEqual([]);
    const alertes = await avertissements(depot, go, tete);
    expect(alertes).toHaveLength(3);
    for (const fichier of ['.vscode/tasks.json', '.envrc', '.gitmodules']) {
      expect(alertes).toContainEqual(
        expect.objectContaining({ fichier, raison: expect.stringMatching(/\S/) }),
      );
    }
  });

  it('signale en avertissement un script npm étranger à la commande du gate', async () => {
    const go = commiter({
      'agent.yml': 'gates: { gate: "npm run gate" }\n',
      'package.json': '{"scripts":{"gate":"vitest run","postinstall":"echo avant"}}\n',
    });
    const tete = commiter({
      'package.json': '{"scripts":{"gate":"vitest run","postinstall":"echo apres"}}\n',
    });

    expect(await entreesGelees(depot, go, tete)).toEqual([]);
    expect(await avertissements(depot, go, tete)).toEqual([
      expect.objectContaining({ fichier: 'package.json', raison: expect.stringMatching(/\S/) }),
    ]);
  });
});

describe('empreinte de l’environnement', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'aid-boucle-home-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('ne relève aucun écart entre deux relevés identiques', async () => {
    ecrire(home, '.claude/settings.json', '{}\n');
    const avant = await empreinteEnvironnement(home, fs);
    const apres = await empreinteEnvironnement(home, fs);

    expect(comparerEmpreintes(avant, apres)).toEqual([]);
  });

  it('relève par chemin les réglages modifiés, la mémoire ajoutée et le réglage supprimé', async () => {
    const worktree = join(home, 'projet-fictif');
    const projet = join('.claude', 'projects', worktree.replace(/[^a-zA-Z0-9]/g, '-'));
    const memoire = join(projet, 'memory', 'MEMORY.md');
    ecrire(home, '.claude/settings.json', '{"mode":"avant"}\n');
    ecrire(home, '.bashrc', 'export EXEMPLE=1\n');
    ecrire(home, '.gitconfig', '# Initial\n');
    const avant = await empreinteEnvironnement(home, fs, { worktree });

    ecrire(home, '.claude/settings.json', '{"mode":"apres"}\n');
    ecrire(home, '.bashrc', 'export EXEMPLE=2\n');
    ecrire(home, memoire, '# Exemple\n');
    ecrire(home, join(projet, 'notes.txt'), 'Hors liste\n');
    rmSync(join(home, '.gitconfig'));
    const apres = await empreinteEnvironnement(home, fs, { worktree });

    expect([...comparerEmpreintes(avant, apres)].sort()).toEqual(
      ['.claude/settings.json', '.bashrc', '.gitconfig', memoire]
        .map((fichier) => join(home, fichier))
        .sort(),
    );
  });

  it('inclut les autres réglages du home explicitement nommés par DM67', async () => {
    const fichiers = [
      '.claude.json',
      '.codex/config.toml',
      '.zshrc',
      'Library/LaunchAgents/exemple.plist',
      '.claude/settings.local.json',
      '.claude/commands/exemple.md',
      '.claude/agents/exemple.md',
      '.claude/skills/exemple/SKILL.md',
      '.claude/plugins/exemple/config.json',
      '.claude/CLAUDE.md',
    ];
    const avant = await empreinteEnvironnement(home, fs);
    for (const fichier of fichiers) ecrire(home, fichier, 'Exemple\n');
    const apres = await empreinteEnvironnement(home, fs);

    expect([...comparerEmpreintes(avant, apres)].sort()).toEqual(
      fichiers.map((fichier) => join(home, fichier)).sort(),
    );
  });
});

describe('processus du worktree', () => {
  it('retient la racine et les descendants, en respectant la frontière du chemin', async () => {
    const racine = mkdtempSync(join(tmpdir(), 'aid-boucle-processus-'));
    try {
      const worktree = join(racine, 'sujet');
      const sousDossier = join(worktree, 'src');
      const voisin = join(racine, 'sujet-voisin');
      mkdirSync(sousDossier, { recursive: true });
      mkdirSync(voisin);
      const pids = await processusDansWorktree(worktree, {
        lister: async () => [
          { pid: 123, cwd: worktree },
          { pid: 124, cwd: sousDossier },
          { pid: 125, cwd: voisin },
          { pid: 126, cwd: racine },
        ],
      });

      expect([...pids].sort((a, b) => a - b)).toEqual([123, 124]);
    } finally {
      rmSync(racine, { recursive: true, force: true });
    }
  });
});

describe('invalidation par la tête', () => {
  const tete = 'a'.repeat(40);
  const gate = { tete, issue: 'pass' } as const;
  const revue = { tete, issue: 'pass' } as const;

  it('écarte les résultats du gate et de la revue obtenus sur une tête précédente', () => {
    expect(invaliderSiTeteBouge({ gate, revue }, 'b'.repeat(40))).toEqual({
      gate: null,
      revue: null,
    });
  });

  it('conserve le résultat correspondant à la tête courante', () => {
    expect(invaliderSiTeteBouge({ gate, revue: { ...revue, tete: 'b'.repeat(40) } }, tete)).toEqual(
      { gate, revue: null },
    );
  });
});

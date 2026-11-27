import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runDoctor, type Probes } from '../../src/cli/commands/doctor.js';
import { WorkspaceQueue } from '../../src/daemon/actions/queue.js';
import { ServiceBoucle } from '../../src/daemon/boucle/service.js';
import { openDb } from '../../src/daemon/db.js';
import { EventStore } from '../../src/daemon/events/store.js';
import { MemoryMirror } from '../../src/daemon/memory/mirror.js';
import { MemoryService } from '../../src/daemon/memory/service.js';
import { MemoryStore } from '../../src/daemon/memory/store.js';
import { resolvePaths } from '../../src/daemon/paths.js';
import { seedTopic } from '../helpers/daemon.js';
import { commitFile, makeOriginAndClone, sh } from '../helpers/git.js';
import { poserOrigineBoucle, poserTemoinGitBoucle } from './temoin-git.js';

let racine: string;
let home: string;

beforeEach(() => {
  racine = mkdtempSync(join(tmpdir(), 'aid-relecture5-'));
  home = join(racine, 'home');
  mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
  vi.stubEnv('AID_HOME', join(home, 'aid'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(racine, { recursive: true, force: true });
});

describe('origines et configuration Git de la boucle', () => {
  const sujet = 'tp_1';
  let depot: string;
  let db: ReturnType<typeof openDb>;
  let memoire: MemoryService;
  let service: ServiceBoucle;

  beforeEach(() => {
    const { clone } = makeOriginAndClone(racine, { name: 'depot-fictif' });
    commitFile(
      clone,
      'agent.yml',
      'project: { namespace: aid }\nphases: [plan, dev, review]\ngates: { gate: "exit 0" }\n',
    );
    sh(clone, 'push', '-q', 'origin', 'main');
    depot = join(racine, 'sujet-fictif');
    sh(clone, 'worktree', 'add', '-qb', 'feat/s', depot, 'main');
    poserOrigineBoucle(depot);

    db = openDb(join(racine, 'etat.db'));
    seedTopic(db);
    db.prepare('DELETE FROM agents').run();
    db.prepare('UPDATE workspaces SET root = ?, worktrees_dir = ?').run(clone, racine);
    db.prepare('UPDATE topics SET worktree = ? WHERE id = ?').run(depot, sujet);
    const miroir = new MemoryMirror(join(racine, 'memoire'));
    vi.spyOn(miroir, 'scheduleCommit').mockImplementation(() => {});
    memoire = new MemoryService({
      store: new MemoryStore(db),
      mirror: miroir,
      events: new EventStore(db),
      queue: new WorkspaceQueue(),
    });
  });

  afterEach(async () => {
    try {
      await service?.fermer();
    } finally {
      db?.close();
    }
  });

  function ouvrirService(observation: 'commandes' | 'config') {
    const temoin = poserTemoinGitBoucle(racine, depot, observation);
    vi.stubEnv('PATH', temoin.chemin);
    service = new ServiceBoucle({
      db,
      memory: memoire,
      agents: {
        lancer: async ({ genre, role }) => ({ genre, modele: 'fictif', sessionId: role }),
        arreter: async () => {},
        ecrire: async () => {},
      },
    });
    return temoin;
  }

  test.each([
    'h:x@[autre.exemple]:z',
    'u@exemple.test:x@[autre.exemple]:z',
    'ssh://exemple.test/x@[autre.exemple]/z',
    'ssh://exemple.test/x%40%5Bautre%20x%5D/z',
    'u@exemple.test:a%20b.git',
    'alias:a[b].git',
  ])('refuse %s avec un 409 avant tout ls-remote', async (origine) => {
    sh(depot, 'config', '--local', 'remote.origin.url', origine);
    const temoin = ouvrirService('commandes');
    const [resultat] = await Promise.allSettled([service.lancer(sujet)]);

    expect.soft(temoin.lire().filter(({ commande }) => commande.includes('ls-remote'))).toEqual([]);
    expect(resultat).toMatchObject({ status: 'rejected', reason: { status: 409 } });
  });

  test.each([
    ['https://exemple.test/a%20b.git', 'https://exemple.test/a%20b.git'],
    ['https://exemple.test/x[1].git', 'https://exemple.test/x[1].git'],
    ['https://u@exemple.test/x.git', 'https://u@exemple.test/x.git'],
    ['https://exemple.test:8443/x.git', 'https://exemple.test:8443/x.git'],
    ['ssh://u@exemple.test:2222/x.git', 'ssh://u@exemple.test:2222/x.git'],
    ['exemple-alias:equipe/x.git', 'exemple-alias:equipe/x.git'],
    ['HTTPS://exemple.test/x.git', 'https://exemple.test/x.git'],
  ])('accepte %s et transmet son URL à ls-remote après --', async (origine, attendue) => {
    sh(depot, 'config', '--local', 'remote.origin.url', origine);
    const temoin = ouvrirService('commandes');
    await service.lancer(sujet);

    expect(service.lire(sujet).phase).toBe('plan');
    expect(
      temoin.lire().flatMap(({ commande }) => {
        const distante = commande.indexOf('ls-remote');
        return distante < 0 ? [] : [commande.slice(distante)];
      }),
    ).toEqual([['ls-remote', '--exit-code', '--', attendue, 'refs/heads/main']]);
  });

  const configurations = [
    { variable: 'GIT_CONFIG_GLOBAL', valeur: 'config-relative', fichier: 'config-relative' },
    { variable: 'XDG_CONFIG_HOME', valeur: 'xdg-relatif', fichier: 'xdg-relatif/git/config' },
  ] as const;

  async function demarrerDeveloppement() {
    await service.lancer(sujet);
    await service.traiterEvenementAgent('plan', {
      type: 'turn_end',
      texteFinal: 'Ajouter une note.',
    });
    await service.go(sujet);
    expect(service.lire(sujet).phase).toBe('dev');
    commitFile(depot, 'note.md', 'Note fictive.');
    await memoire.put('aid/dev-handoff/s', 'Note ajoutée.', { kind: 'create' }, { author: 'test' });
  }

  test.each(configurations)(
    'ignore $variable relatif dans la configuration et dans l’empreinte',
    async ({ variable, valeur, fichier }) => {
      const exclusions = join(home, 'exclusions-fictives');
      writeFileSync(exclusions, 'artefact-fictif\n');
      const contenu = `[core]\n  excludesFile = ${exclusions}\n`;
      mkdirSync(dirname(join(depot, fichier)), { recursive: true });
      commitFile(depot, fichier, contenu);

      vi.stubEnv('GIT_CONFIG_GLOBAL', undefined);
      vi.stubEnv(variable, valeur);
      const temoin = ouvrirService('config');
      await demarrerDeveloppement();
      // Une modification commitée laisse le worktree propre.
      commitFile(depot, fichier, contenu + '# Modification fictive.\n');
      await service.traiterEvenementAgent('dev', { type: 'turn_end' });

      const lectures = temoin.lire().filter(({ commande }) => commande.includes('status'));
      expect(lectures.length).toBeGreaterThan(0);
      for (const { config } of lectures) {
        expect.soft(config).not.toContain(`core.excludesfile=${exclusions}\n`);
      }
      expect(service.lire(sujet).phase).toBe('revue');
    },
    20_000,
  );

  test.each(configurations)(
    'conserve $variable absolu dans la configuration',
    async ({ variable, valeur, fichier }) => {
      const exclusions = join(home, 'exclusions-fictives');
      const config = join(home, fichier);
      mkdirSync(dirname(config), { recursive: true });
      writeFileSync(exclusions, 'artefact-fictif\n');
      writeFileSync(config, `[core]\n  excludesFile = ${exclusions}\n`);

      vi.stubEnv('GIT_CONFIG_GLOBAL', undefined);
      vi.stubEnv(variable, join(home, valeur));
      const temoin = ouvrirService('config');
      await demarrerDeveloppement();
      writeFileSync(join(depot, 'artefact-fictif'), 'Fichier ignoré.');
      await service.traiterEvenementAgent('dev', { type: 'turn_end' });

      const lectures = temoin.lire().filter(({ commande }) => commande.includes('status'));
      expect(lectures.length).toBeGreaterThan(0);
      for (const { config } of lectures) {
        expect.soft(config).toContain(`core.excludesfile=${exclusions}\n`);
      }
      expect(service.lire(sujet).phase).toBe('revue');
    },
    20_000,
  );
});

describe('OpenSSH dans aid doctor', () => {
  async function lireDoctor(versionSsh: string | null) {
    const sortie: string[] = [];
    const sondes: Probes = {
      nodeVersion: 'v22.12.0',
      platform: 'darwin',
      procVersion: null,
      has: (binaire) => ['git', 'bash'].includes(binaire) || (binaire === 'ssh' && !!versionSsh),
      version: async (binaire, args) => {
        if (binaire === 'git') return 'git version 2.54.0';
        if (binaire === 'ssh' && args.length === 1 && args[0] === '-V') return versionSsh;
        return null;
      },
      loadPty: async () => null,
      loadSqlite: async () => null,
      homeMode: () => 0o40700,
      port: async () => ({ port: 4870, state: 'libre' }),
      artefactsPort: async () => ({ port: 4880, state: 'libre' }),
      claudeHooks: () => true,
      memoryHealth: async () => null,
      mcpRegistration: () => false,
      structural: async () => null,
      install: () => ({ mode: 'repo', version: null }),
      mesh: async () => null,
      swairm: async () => null,
      modeHost: async () => null,
    };
    await runDoctor(resolvePaths(join(home, 'aid')), sondes, (ligne) => sortie.push(ligne));
    return sortie.join('\n');
  }

  test('affiche un avertissement avec la version OpenSSH 9.5', async () => {
    const sortie = await lireDoctor('OpenSSH_9.5p1, LibreSSL 3.3.6');
    expect(sortie).toMatch(/^\s*⚠[^\n]*OpenSSH[^\n]*9\.5(?:p\d+)?\b/im);
  });

  test('affiche OpenSSH 9.6 sans avertissement', async () => {
    const sortie = await lireDoctor('OpenSSH_9.6p1, LibreSSL 3.3.6');
    expect(sortie).toMatch(/^\s*✓[^\n]*OpenSSH[^\n]*9\.6(?:p\d+)?\b/im);
  });

  test('signale que ssh est absent', async () => {
    const sortie = await lireDoctor(null);
    expect(sortie).toMatch(
      /(?:ssh[^\n]*(?:absent|introuvable|non installé)|(?:absent|introuvable|non installé)[^\n]*ssh)/i,
    );
  });
});

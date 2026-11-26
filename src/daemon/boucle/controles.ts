import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { basename, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { git } from '../git/exec.js';

export function gitSujet(depot: string, args: string[]) {
  return git(
    depot,
    ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args],
    10_000,
  );
}

async function lireGit(depot: string, args: string[]): Promise<string> {
  const resultat = await gitSujet(depot, args);
  if (!resultat.ok) throw new Error('Impossible de relever les entrées du gate');
  return resultat.stdout;
}

async function lireBlob(depot: string, commit: string, fichier: string) {
  const objet = `${commit}:${fichier}`;
  const existe = await gitSujet(depot, ['cat-file', '-e', '--end-of-options', objet]);
  return existe.ok ? lireGit(depot, ['show', '--end-of-options', objet]) : undefined;
}

type Scripts = Record<string, string | undefined>;

function scripts(contenu: string | undefined): Scripts {
  return contenu === undefined
    ? {}
    : ((JSON.parse(contenu) as { scripts?: Scripts }).scripts ?? {});
}

function scriptsDuGate(commande: string, avant: Scripts): Set<string> {
  const noms = new Set<string>();
  function relever(texte: string) {
    const appels = texte.matchAll(
      /\bnpm\s+(?:--?\S+\s+)*(?:run(?:-script)?\s+(?:--?\S+\s+)*([\w:.-]+)|test\b|start\b)/g,
    );
    for (const [appel, nom = appel.trim().split(/\s+/).at(-1)!] of appels) {
      for (const cle of [nom, `pre${nom}`, `post${nom}`]) {
        if (noms.has(cle)) continue;
        noms.add(cle);
        if (Object.hasOwn(avant, cle) && avant[cle]) relever(avant[cle]);
      }
    }
  }
  relever(commande);
  return noms;
}

function configTest(fichier: string): boolean {
  return (
    /^(?:vitest(?:\.[\w-]+)?|vite|jest|playwright|cypress|karma|ava)\.(?:config|workspace)\./.test(
      basename(fichier),
    ) || /^(?:\.mocharc|\.vitest|\.jestrc)(?:\.|$)/.test(basename(fichier))
  );
}

interface Constat {
  fichier: string;
  raison: string;
}

export async function releverDiff(depot: string, go: string, tete: string) {
  if (go === tete && /^[a-f0-9]{40}$/.test(go)) return { entrees: [], alertes: [] };
  const [base, arrivee] = await Promise.all(
    [go, tete].map((revision) =>
      /^[a-f0-9]{40}$/.test(revision)
        ? revision
        : lireGit(depot, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]),
    ),
  );
  const fichiers = (
    await lireGit(depot, [
      'diff',
      '--no-ext-diff',
      '--no-renames',
      '--name-only',
      '-z',
      '--end-of-options',
      base!,
      arrivee!,
      '--',
    ])
  )
    .split('\0')
    .filter(Boolean);
  const entrees: Constat[] = [];
  const alertes: Constat[] = [];
  if (!fichiers.length) return { entrees, alertes };

  const configs = (
    await lireGit(depot, ['ls-tree', '-r', '--name-only', '-z', '--end-of-options', base!])
  )
    .split('\0')
    .filter(configTest);
  const preparations = new Set<string>();
  for (const config of configs) {
    const source = (await lireBlob(depot, base!, config)) ?? '';
    for (const [, valeur] of source.matchAll(
      /\b(?:setupFiles|globalSetup|globalTeardown)\s*:\s*(\[[^\]]*\]|['"][^'"]+['"])/g,
    )) {
      for (const [, chemin] of valeur!.matchAll(/['"]([^'"]+)['"]/g)) {
        preparations.add(posix.normalize(chemin!));
        preparations.add(posix.join(posix.dirname(config), chemin!));
      }
    }
  }

  for (const fichier of fichiers) {
    const nom = basename(fichier);
    const segments = fichier.split('/');
    if (segments.includes('.claude') || ['.mcp.json', 'CLAUDE.md', 'AGENTS.md'].includes(nom)) {
      entrees.push({ fichier, raison: 'Configuration de projet des agents' });
    } else if (
      segments.some((segment) =>
        ['.github', '.circleci', '.buildkite', '.woodpecker', '.azure-pipelines'].includes(segment),
      ) ||
      /^(?:\.gitlab-ci\.yml|\.travis\.yml|Jenkinsfile|azure-pipelines\.ya?ml|\.drone\.yml|\.woodpecker\.ya?ml)$/.test(
        nom,
      )
    ) {
      entrees.push({ fichier, raison: 'Configuration de CI' });
    } else if (
      nom === 'agent.yml' ||
      configTest(fichier) ||
      preparations.has(fichier) ||
      /^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|\.npmrc)$/.test(
        nom,
      )
    ) {
      entrees.push({ fichier, raison: 'Entrée gelée du gate' });
    } else if (segments.includes('.vscode') || ['.envrc', '.gitmodules'].includes(nom)) {
      alertes.push({ fichier, raison: 'Configuration chargée par l’outillage local' });
    } else if (nom === 'package.json') {
      const [contenuAvant, contenuApres, manifeste] = await Promise.all([
        lireBlob(depot, base!, fichier),
        lireBlob(depot, arrivee!, fichier),
        lireBlob(depot, base!, 'agent.yml'),
      ]);
      const avant = scripts(contenuAvant);
      const apres = scripts(contenuApres);
      const commande =
        (parse(manifeste ?? '') as { gates?: { gate?: string } } | null)?.gates?.gate ?? '';
      const geles = scriptsDuGate(commande, avant);
      const changes = [...new Set([...Object.keys(avant), ...Object.keys(apres)])].filter(
        (cle) =>
          Object.getOwnPropertyDescriptor(avant, cle)?.value !==
          Object.getOwnPropertyDescriptor(apres, cle)?.value,
      );
      if (changes.some((cle) => geles.has(cle))) {
        entrees.push({ fichier, raison: 'Script npm du gate modifié' });
      }
      if (changes.some((cle) => !geles.has(cle))) {
        alertes.push({ fichier, raison: 'Script npm hors gate modifié' });
      }
    }
  }
  return { entrees, alertes };
}

export async function entreesGelees(depot: string, go: string, tete: string): Promise<Constat[]> {
  return (await releverDiff(depot, go, tete)).entrees;
}

export async function avertissements(depot: string, go: string, tete: string): Promise<Constat[]> {
  return (await releverDiff(depot, go, tete)).alertes;
}

const cheminsHome = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude.json',
  '.claude/CLAUDE.md',
  '.claude/commands',
  '.claude/agents',
  '.claude/skills',
  '.claude/plugins',
  '.codex/config.toml',
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.profile',
  '.zshrc',
  '.zprofile',
  '.zshenv',
  '.zlogin',
  '.config/fish/config.fish',
  '.gitconfig',
  '.config/git/config',
  'Library/LaunchAgents',
];

export type EmpreinteEnvironnement = Record<string, string>;

function objetJson(valeur: unknown): Record<string, unknown> {
  return valeur !== null && typeof valeur === 'object' && !Array.isArray(valeur)
    ? (valeur as Record<string, unknown>)
    : {};
}

const clesProjetClaude = new Set([
  'mcpServers',
  'allowedTools',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
]);

function projeterConfigClaude(contenu: string): string {
  const { mcpServers, projects } = objetJson(JSON.parse(contenu));
  const projets = Object.fromEntries(
    Object.entries(objetJson(projects)).flatMap(([nom, projet]) => {
      const reglages = Object.entries(objetJson(projet)).filter(([cle]) =>
        clesProjetClaude.has(cle),
      );
      return reglages.length ? [[nom, Object.fromEntries(reglages)]] : [];
    }),
  );
  return JSON.stringify({ mcpServers, projects: projets }, (_cle, valeur: unknown) =>
    valeur !== null && typeof valeur === 'object' && !Array.isArray(valeur)
      ? Object.fromEntries(
          Object.keys(valeur)
            .sort()
            .map((cle) => [cle, objetJson(valeur)[cle]]),
        )
      : valeur,
  );
}

export async function empreinteEnvironnement(
  home: string,
  fichiers = fs,
): Promise<EmpreinteEnvironnement> {
  const racine = await fichiers.realpath(home);
  const empreinte: EmpreinteEnvironnement = {};
  const descendants: { chemin: string; nom: string }[] = [];

  async function inspecter(chemin: string, nom: string, parcourir: boolean) {
    try {
      const meta = await fichiers.lstat(chemin);
      const droits = `${meta.mode}:${meta.uid}:${meta.gid}`;
      if (meta.isSymbolicLink()) {
        const cible = await fichiers.readlink(chemin);
        empreinte[nom] = `lien:${droits}:${createHash('sha256').update(cible).digest('hex')}`;
      } else if (meta.isDirectory()) {
        if (parcourir) {
          for (const enfant of await fichiers.readdir(chemin)) {
            descendants.push({ chemin: join(chemin, enfant), nom: join(nom, enfant) });
          }
        }
        return true;
      } else if (meta.isFile() && parcourir) {
        const fichier = await fichiers.open(
          chemin,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const hash = createHash('sha256');
          if (chemin === join(racine, '.claude.json')) {
            hash.update(projeterConfigClaude(await fichier.readFile('utf8')));
            empreinte[nom] = `projection:${hash.digest('hex')}`;
            return false;
          }
          const tampon = Buffer.allocUnsafe(Math.max(4096, Math.min(meta.size, 64 * 1024)));
          for (;;) {
            const { bytesRead } = await fichier.read(tampon);
            if (!bytesRead) break;
            hash.update(tampon.subarray(0, bytesRead));
          }
          empreinte[nom] = `fichier:${droits}:${meta.size}:${meta.mtimeMs}:${hash.digest('hex')}`;
        } finally {
          await fichier.close();
        }
      } else if (parcourir) {
        empreinte[nom] = `spécial:${droits}`;
      }
    } catch (erreur) {
      if ((erreur as NodeJS.ErrnoException).code !== 'ENOENT') empreinte[nom] = 'illisible';
    }
    return false;
  }

  async function relever(cheminRelatif: string, parcourir: boolean) {
    const segments = cheminRelatif.split('/');
    let chemin = '';
    for (const [indice, segment] of segments.entries()) {
      chemin = join(chemin, segment);
      const dernier = indice === segments.length - 1;
      if (!(await inspecter(join(racine, chemin), join(home, chemin), dernier && parcourir)))
        return false;
    }
    return true;
  }

  await Promise.all(cheminsHome.map((chemin) => relever(chemin, true)));
  const projets = '.claude/projects';
  if (await relever(projets, false)) {
    try {
      const noms = await fichiers.readdir(join(racine, projets));
      for (let indice = 0; indice < noms.length; indice += 16) {
        await Promise.all(
          noms.slice(indice, indice + 16).map(async (projet) => {
            const chemin = join(projets, projet);
            if (await inspecter(join(racine, chemin), join(home, chemin), false))
              await inspecter(join(racine, chemin, 'memory'), join(home, chemin, 'memory'), true);
          }),
        );
      }
    } catch (erreur) {
      if ((erreur as NodeJS.ErrnoException).code !== 'ENOENT')
        empreinte[join(home, projets)] = 'illisible';
    }
  }
  let indice = 0;
  while (indice < descendants.length) {
    const lot = descendants.slice(indice, indice + 16);
    indice += lot.length;
    await Promise.all(lot.map(({ chemin, nom }) => inspecter(chemin, nom, true)));
  }
  return empreinte;
}

export function comparerEmpreintes(
  avant: EmpreinteEnvironnement,
  apres: EmpreinteEnvironnement,
): string[] {
  return [...new Set([...Object.keys(avant), ...Object.keys(apres)])]
    .filter((chemin) => avant[chemin] !== apres[chemin])
    .sort();
}

interface Processus {
  pid: number;
  cwd: string;
}

async function listerProcessus(): Promise<Processus[]> {
  if (process.platform === 'linux') {
    const pids = (await fs.readdir('/proc')).filter((nom) => /^\d+$/.test(nom));
    const processus: Processus[] = [];
    for (const pid of pids) {
      try {
        const cwd = await fs.readlink(join('/proc', pid, 'cwd'));
        processus.push({ pid: Number(pid), cwd });
      } catch (erreur) {
        if (
          !['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(
            (erreur as NodeJS.ErrnoException).code ?? '',
          )
        )
          throw erreur;
      }
    }
    return processus;
  }

  const { stdout } = await promisify(execFile)(
    'lsof',
    ['-nP', '-a', '-u', String(process.getuid?.()), '-d', 'cwd', '-F0pn'],
    {
      timeout: 5_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  let pid = 0;
  const processus: Processus[] = [];
  for (const champ of stdout.split('\0')) {
    const ligne = champ.replace(/^\n/, '');
    if (ligne.startsWith('p')) pid = Number(ligne.slice(1));
    if (ligne.startsWith('n') && pid > 0) processus.push({ pid, cwd: ligne.slice(1) });
  }
  return processus;
}

export async function processusDansWorktree(
  worktree: string,
  { lister = listerProcessus }: { lister?: () => Promise<Processus[]> } = {},
): Promise<number[]> {
  // Un relevé peut utiliser le chemin d'origine ou celui résolu par le noyau.
  const racines = [resolve(worktree), await fs.realpath(worktree)];
  return (await lister())
    .filter(({ cwd }) => {
      if (!isAbsolute(cwd)) return false;
      return racines.some((racine) => {
        const chemin = relative(racine, cwd);
        return chemin !== '..' && !chemin.startsWith(`..${sep}`) && !isAbsolute(chemin);
      });
    })
    .map(({ pid }) => pid);
}

export function invaliderSiTeteBouge<G extends { tete: string }, R extends { tete: string }>(
  { gate, revue }: { gate: G | null; revue: R | null },
  tete: string,
): { gate: G | null; revue: R | null } {
  return { gate: gate?.tete === tete ? gate : null, revue: revue?.tete === tete ? revue : null };
}

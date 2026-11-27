import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { basename, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { gitBoucle } from './git.js';

export function gitSujet(depot: string, args: string[]) {
  return gitBoucle(depot, args).then(
    (stdout) => ({ ok: true, stdout: stdout.replace(/\s+$/, '') }),
    () => ({ ok: false, stdout: '' }),
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
      /\b(npm|pnpm|yarn|bun)\s+(?:--?\S+\s+)*(?:run(?:-script)?\s+(?:--?\S+\s+)*)?([\w:.-]+)/g,
    );
    for (const [appel, outil, nom] of appels) {
      if (
        !nom ||
        (outil === 'npm' && !/\brun(?:-script)?\s/.test(appel) && !['test', 'start'].includes(nom))
      )
        continue;
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

function fichiersNommes(commande: string): string[] {
  const fichiers = new Set(
    [...commande.matchAll(/(?:^|[\s"';&|])\.\/([^\s"';&|]+)/g)].map(([, chemin]) =>
      posix.normalize(chemin!),
    ),
  );
  if (/(?:^|[\s;&|])(?:g?make)(?=\s|$)/.test(commande))
    for (const fichier of ['GNUmakefile', 'makefile', 'Makefile']) fichiers.add(fichier);
  for (const [, chemin] of commande.matchAll(
    /(?:^|[\s;&|])(?:(?:ba|z|da)?sh|node|python3?|ruby|perl)\s+['"]?([\w./-]+\.[\w.-]+)/g,
  ))
    fichiers.add(posix.normalize(chemin!));
  for (const [, chemin] of commande.matchAll(/(?:^|\s)(?:-f\s+|--file=)([^\s;&|]+)/g))
    fichiers.add(posix.normalize(chemin!));
  return [...fichiers];
}

async function commandeGate(depot: string, go: string): Promise<string> {
  const manifeste = await lireBlob(depot, go, 'agent.yml');
  return (parse(manifeste ?? '') as { gates?: { gate?: string } } | null)?.gates?.gate ?? '';
}

function configurationAgent(fichier: string): boolean {
  return (
    fichier.split('/').some((segment) => ['.claude', '.codex'].includes(segment)) ||
    ['.mcp.json', 'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md'].includes(basename(fichier))
  );
}

function configTest(fichier: string): boolean {
  return (
    /^(?:vitest(?:\.[\w-]+)?|vite|jest|playwright|cypress|karma|ava)\.(?:config|workspace)\./.test(
      basename(fichier),
    ) || /^(?:\.mocharc|\.vitest|\.jestrc)(?:\.|$)/.test(basename(fichier))
  );
}

function configurationCi(fichier: string): boolean {
  return (
    fichier
      .split('/')
      .some((segment) =>
        ['.github', '.circleci', '.buildkite', '.woodpecker', '.azure-pipelines'].includes(segment),
      ) ||
    /^(?:\.gitlab-ci\.yml|\.travis\.yml|Jenkinsfile|azure-pipelines\.ya?ml|\.drone\.yml|\.woodpecker\.ya?ml)$/.test(
      basename(fichier),
    )
  );
}

async function fichiersGeles(depot: string, go: string, commande: string): Promise<Set<string>> {
  const scriptsRacine = scripts(await lireBlob(depot, go, 'package.json'));
  const commandes = [commande];
  for (const nom of scriptsDuGate(commande, scriptsRacine)) {
    const script = Object.getOwnPropertyDescriptor(scriptsRacine, nom)?.value as unknown;
    if (typeof script === 'string') commandes.push(script);
  }
  const fichiers = new Set(commandes.flatMap(fichiersNommes));
  const configs = (
    await lireGit(depot, ['ls-tree', '-r', '--name-only', '-z', '--end-of-options', go])
  )
    .split('\0')
    .filter(configTest);
  for (const config of configs) {
    const source = (await lireBlob(depot, go, config)) ?? '';
    for (const [, valeur] of source.matchAll(
      /\b(?:setupFiles|globalSetup|globalTeardown)\s*:\s*(\[[^\]]*\]|['"][^'"]+['"])/g,
    )) {
      for (const [, chemin] of valeur!.matchAll(/['"]([^'"]+)['"]/g)) {
        fichiers.add(posix.normalize(chemin!));
        fichiers.add(posix.join(posix.dirname(config), chemin!));
      }
    }
  }
  return fichiers;
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

  const commande = await commandeGate(depot, base!);
  const nommes = await fichiersGeles(depot, base!, commande);
  for (const fichier of fichiers) {
    const nom = basename(fichier);
    const segments = fichier.split('/');
    if (configurationAgent(fichier)) {
      entrees.push({ fichier, raison: 'Configuration de projet des agents' });
    } else if (configurationCi(fichier)) {
      entrees.push({ fichier, raison: 'Configuration de CI' });
    } else if (
      nom === 'agent.yml' ||
      configTest(fichier) ||
      nommes.has(fichier) ||
      fichier.startsWith('node_modules/.bin/') ||
      /^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|\.npmrc)$/.test(
        nom,
      )
    ) {
      entrees.push({ fichier, raison: 'Entrée gelée du gate' });
    } else if (segments.includes('.vscode') || ['.envrc', '.gitmodules'].includes(nom)) {
      alertes.push({ fichier, raison: 'Configuration chargée par l’outillage local' });
    } else if (nom === 'package.json') {
      const [contenuAvant, contenuApres] = await Promise.all([
        lireBlob(depot, base!, fichier),
        lireBlob(depot, arrivee!, fichier),
      ]);
      const avant = scripts(contenuAvant);
      const apres = scripts(contenuApres);
      const geles = scriptsDuGate(commande, avant);
      const changes = [...new Set([...Object.keys(avant), ...Object.keys(apres)])].filter(
        (cle) =>
          Object.getOwnPropertyDescriptor(avant, cle)?.value !==
          Object.getOwnPropertyDescriptor(apres, cle)?.value,
      );
      if (changes.some((cle) => geles.has(cle))) {
        entrees.push({ fichier, raison: 'Script du gate modifié' });
      }
      if (changes.some((cle) => !geles.has(cle))) {
        alertes.push({ fichier, raison: 'Script hors gate modifié' });
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

const cheminsCodex = new Set([
  'config.toml',
  'AGENTS.md',
  'AGENTS.override.md',
  'prompts',
  'rules',
  'skills',
  'plugins',
  'hooks.json',
  'hooks',
]);

const cheminsHome = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude.json',
  '.claude/CLAUDE.md',
  '.claude/commands',
  '.claude/agents',
  '.claude/skills',
  '.claude/hooks',
  ...[...cheminsCodex].map((chemin) => '.codex/' + chemin),
  '.npmrc',
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
  const config = objetJson(JSON.parse(contenu));
  const { projects } = config;
  const reglages = Object.fromEntries(
    Object.entries(config).filter(([cle]) => clesProjetClaude.has(cle)),
  );
  const projets = Object.fromEntries(
    Object.entries(objetJson(projects)).flatMap(([nom, projet]) => {
      const reglages = Object.entries(objetJson(projet)).filter(([cle]) =>
        clesProjetClaude.has(cle),
      );
      return reglages.length ? [[nom, Object.fromEntries(reglages)]] : [];
    }),
  );
  return JSON.stringify({ ...reglages, projects: projets }, (_cle, valeur: unknown) =>
    valeur !== null && typeof valeur === 'object' && !Array.isArray(valeur)
      ? Object.fromEntries(
          Object.keys(valeur)
            .sort()
            .map((cle) => [cle, objetJson(valeur)[cle]]),
        )
      : valeur,
  );
}

function dansRacine(racine: string, chemin: string): boolean {
  const relatif = relative(racine, chemin);
  return relatif !== '..' && !relatif.startsWith(`..${sep}`) && !isAbsolute(relatif);
}

const constatHomeTropGros = 'Empreinte du home : trop gros';
const limitesHome = { entrees: 4096, octets: 64 * 1024 * 1024 };

function collecteurEmpreinte(
  racine: string,
  fichiers = fs,
  budget?: { entrees: number; octets: number },
) {
  const empreinte: EmpreinteEnvironnement = Object.create(null) as EmpreinteEnvironnement;
  const profondeurMax = 32;

  function compter(type: 'entrees' | 'octets', quantite: number): boolean {
    if (!budget) return true;
    if (Object.hasOwn(empreinte, constatHomeTropGros)) return false;
    if (budget[type] >= quantite) {
      budget[type] -= quantite;
      return true;
    }
    empreinte[constatHomeTropGros] = 'trop gros';
    return false;
  }

  // Résout les composants un par un, sans demander au système de suivre un lien sortant.
  async function localiser(
    chemin: string,
    liens: string[],
    profondeur = 0,
  ): Promise<string | undefined> {
    if (!dansRacine(racine, chemin) || profondeur >= profondeurMax) return undefined;
    return suivre(racine, relative(racine, chemin).split(sep), liens, profondeur);
  }

  async function suivre(
    parent: string,
    segments: string[],
    liens: string[],
    profondeur: number,
  ): Promise<string | undefined> {
    let courant = parent;
    for (const segment of segments) {
      if (!segment || segment === '.') continue;
      courant = join(courant, segment);
      if (!dansRacine(racine, courant)) {
        liens.push('lien sortant');
        return undefined;
      }
      if (!(await fichiers.lstat(courant)).isSymbolicLink()) continue;
      const lien = await fichiers.readlink(courant);
      const cible = resolve(courant, '..', lien);
      // Un lien absolu qui sort de la racine reste hors périmètre, même si sa cible existe.
      const interne = dansRacine(racine, cible);
      liens.push(`${interne ? 'lien' : 'lien sortant'}:${lien}`);
      if (!interne || profondeur >= profondeurMax) return undefined;
      const absolu = isAbsolute(lien);
      if (absolu && lien !== racine && !lien.startsWith(racine + sep)) {
        liens.push('lien sortant');
        return undefined;
      }
      const morceaux = (absolu ? lien.slice(racine.length) : lien).split(sep);
      const resolu = await suivre(
        absolu ? racine : resolve(courant, '..'),
        morceaux,
        liens,
        profondeur + 1,
      );
      if (!resolu) return undefined;
      courant = resolu;
    }
    return courant;
  }

  async function relever(
    chemin: string,
    nom: string,
    options: {
      projeter?: (texte: string) => string;
      lire?: (texte: string) => void;
      exclure?: (nom: string) => boolean;
      exclureCible?: (chemin: string) => boolean;
      fichierSeul?: boolean;
      profondeur?: number;
      lister?: (noms: string[]) => void;
    } = {},
  ): Promise<void> {
    const { projeter, lire, exclure, exclureCible, fichierSeul, profondeur = 0, lister } = options;
    if (exclure?.(nom) || profondeur >= profondeurMax || !compter('entrees', 1)) return;
    const liens: string[] = [];
    let valeur: string | undefined;
    try {
      const cible = await localiser(chemin, liens);
      if (!cible || exclureCible?.(cible)) return;
      const meta = await fichiers.lstat(cible);
      const droits = `${meta.mode}:${meta.uid}:${meta.gid}`;
      if (meta.isDirectory()) {
        if (fichierSeul) return;
        let enfants: string[] = [];
        if (budget) {
          for await (const enfant of await fichiers.opendir(cible)) {
            if (!compter('entrees', 1)) return;
            enfants.push(enfant.name);
          }
        } else {
          enfants = await fichiers.readdir(cible);
        }
        if (lister) return lister(enfants);
        const releverEnfant = (enfant: string) =>
          relever(join(cible, enfant), join(nom, enfant), {
            exclure,
            exclureCible,
            profondeur: profondeur + 1,
          });
        if (budget && profondeur === 0) {
          for (let indice = 0; indice < enfants.length; indice += 8) {
            if (!compter('entrees', 0)) break;
            await Promise.all(enfants.slice(indice, indice + 8).map(releverEnfant));
          }
        } else {
          for (const enfant of enfants) {
            if (!compter('entrees', 0)) break;
            await releverEnfant(enfant);
          }
        }
      } else if (meta.isFile() && !lister) {
        if (budget && meta.size > budget.octets) {
          compter('octets', meta.size);
          return;
        }
        if (process.platform === 'linux' && (await fichiers.statfs(cible)).type === 0x9fa0) {
          valeur = 'fichier spécial de procfs';
          return;
        }
        const fichier = await fichiers.open(
          cible,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const ouvert = await fichier.stat();
          if (!ouvert.isFile() || ouvert.ino !== meta.ino || ouvert.dev !== meta.dev) {
            valeur = 'modifié pendant le relevé';
            return;
          }
          if (!compter('octets', ouvert.size)) return;
          const hash = createHash('sha256');
          if (projeter || lire) {
            const tampon = Buffer.alloc(ouvert.size);
            let lus = 0;
            while (lus < tampon.length) {
              const { bytesRead } = await fichier.read(tampon, lus, tampon.length - lus);
              if (!bytesRead) break;
              lus += bytesRead;
            }
            const contenu = tampon.toString('utf8', 0, lus);
            lire?.(contenu);
            if (projeter) {
              valeur = `projection:${hash.update(projeter(contenu)).digest('hex')}`;
              return;
            }
            hash.update(contenu);
          } else {
            const tampon = Buffer.allocUnsafe(Math.min(512 * 1024, ouvert.size));
            for (let restant = ouvert.size; restant > 0;) {
              const { bytesRead } = await fichier.read(tampon, 0, Math.min(restant, tampon.length));
              if (!bytesRead) break;
              hash.update(tampon.subarray(0, bytesRead));
              restant -= bytesRead;
            }
          }
          valeur = `fichier:${droits}:${meta.size}:${meta.mtimeMs}:${hash.digest('hex')}`;
        } finally {
          await fichier.close();
        }
      } else if (!lister) {
        valeur = `spécial:${droits}`;
      }
    } catch (erreur) {
      if (!['ENOENT', 'ENOTDIR'].includes((erreur as NodeJS.ErrnoException).code ?? ''))
        valeur = 'illisible';
    } finally {
      if (liens.length) empreinte[nom] = JSON.stringify([...liens, valeur]);
      else if (valeur !== undefined) empreinte[nom] = valeur;
    }
  }
  return { empreinte, relever };
}

function scriptsClaude(contenu: string, racine: string): string[] {
  let config: Record<string, unknown>;
  try {
    config = objetJson(JSON.parse(contenu));
  } catch {
    return [];
  }
  const { hooks, statusLine } = config;
  const commandes: string[] = [];
  function parcourir(valeur: unknown) {
    if (Array.isArray(valeur)) return valeur.forEach(parcourir);
    const objet = objetJson(valeur);
    if (typeof objet.command === 'string') commandes.push(objet.command);
    else Object.values(objet).forEach(parcourir);
  }
  parcourir(hooks);
  parcourir(statusLine);
  return commandes.flatMap((commande) =>
    [...commande.matchAll(/"([^"]+)"|'([^']+)'|([^\s;&|]+)/g)].flatMap(
      ([, double, simple, mot]) => {
        const argument = (double ?? simple ?? mot ?? '').replace(
          /^(?:~|\$HOME|\$\{HOME\})(?=\/)/,
          racine,
        );
        return argument.includes('/') || /\.[\w-]+$/.test(argument)
          ? [resolve(racine, argument)]
          : [];
      },
    ),
  );
}

// Les répertoires de configuration peuvent contenir des fichiers générés localement.
function fichierVolatil(nom: string): boolean {
  return (
    /^(?:\.git|\.cache|cache|tmp|logs?|sessions|archived_sessions|shell_snapshots|thread-writer-locks|downloads?|models_cache\.json|installation_id|auth\.json|credentials\.json|package-lock\.json\.lock)$/i.test(
      nom,
    ) || /(?:\.(?:sqlite\d*|db)(?:-(?:wal|shm|journal))?|\.(?:lock|log)|[-_]lock)$/i.test(nom)
  );
}

function installationsClaude(contenu: string) {
  const { plugins } = objetJson(JSON.parse(contenu));
  return Object.entries(objetJson(plugins))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([nom, installations]) =>
        [
          nom,
          (Array.isArray(installations) ? installations : []).flatMap((installation: unknown) => {
            const { installPath, scope, version, projectPath } = objetJson(installation);
            return typeof installPath === 'string'
              ? [{ installPath, scope, version, projectPath }]
              : [];
          }),
        ] as const,
    );
}

export async function empreinteEnvironnement(
  home: string,
  fichiers = fs,
  { worktree }: { worktree?: string } = {},
): Promise<EmpreinteEnvironnement> {
  const racine = await fichiers.realpath(home);
  const { empreinte, relever } = collecteurEmpreinte(racine, fichiers, { ...limitesHome });
  const scripts = new Set<string>();
  const codex = join(racine, '.codex');
  const exclureCibleCodex = (cible: string) => {
    if (!dansRacine(codex, cible)) return false;
    const [racineCodex, ...descendants] = relative(codex, cible).split(sep);
    return !cheminsCodex.has(racineCodex ?? '') || descendants.some(fichierVolatil);
  };
  for (const chemin of cheminsHome) {
    await relever(join(racine, chemin), join(home, chemin), {
      ...(chemin === '.claude.json' && { projeter: projeterConfigClaude }),
      ...(chemin.startsWith('.claude/settings') && {
        lire: (contenu: string) => {
          for (const script of scriptsClaude(contenu, racine))
            if (dansRacine(racine, script)) scripts.add(script);
        },
      }),
      ...(chemin.startsWith('.codex/') && {
        exclure: (nom: string) => relative(join(home, chemin), nom).split(sep).some(fichierVolatil),
        exclureCible: exclureCibleCodex,
      }),
    });
  }
  const dossierPlugins = '.claude/plugins';
  const registre = join(dossierPlugins, 'installed_plugins.json');
  const plugins = new Set<string>();
  await relever(join(racine, registre), join(home, registre), {
    fichierSeul: true,
    projeter: (contenu) => {
      const installations = installationsClaude(contenu);
      for (const [, versions] of installations)
        for (const { installPath } of versions)
          if (
            isAbsolute(installPath) &&
            dansRacine(racine, installPath) &&
            resolve(installPath) !== racine
          )
            plugins.add(resolve(installPath));
      return JSON.stringify(installations);
    },
  });
  for (const plugin of plugins)
    await relever(plugin, join(home, relative(racine, plugin)), {
      exclure: (nom) =>
        relative(join(home, relative(racine, plugin)), nom)
          .split(sep)
          .some(fichierVolatil),
    });
  // Les installations locales historiques peuvent avoir leur manifeste directement sous plugins/.
  const pluginsLocaux: string[] = [];
  const dossiersGeres = new Set(['marketplaces', 'synced', 'data', 'mcpb', '.trash']);
  await relever(join(racine, dossierPlugins), join(home, dossierPlugins), {
    lister: (enfants) => {
      for (const enfant of enfants)
        if (!dossiersGeres.has(enfant) && !fichierVolatil(enfant)) pluginsLocaux.push(enfant);
    },
  });
  for (const plugin of pluginsLocaux) {
    for (const manifeste of ['config.json', '.claude-plugin/plugin.json']) {
      const chemin = join(dossierPlugins, plugin, manifeste);
      await relever(join(racine, chemin), join(home, chemin), { fichierSeul: true });
    }
  }
  if (worktree) {
    const projet = (await fichiers.realpath(worktree)).replace(/[^a-zA-Z0-9]/g, '-');
    const chemin = join('.claude', 'projects', projet, 'memory');
    await relever(join(racine, chemin), join(home, chemin));
  }
  for (const script of scripts)
    await relever(script, join(home, relative(racine, script)), {
      fichierSeul: true,
      exclureCible: exclureCibleCodex,
    });
  return empreinte;
}

export async function empreinteMetadonnees(depot: string): Promise<EmpreinteEnvironnement> {
  const racine = await fs.realpath(depot);
  const { empreinte, relever } = collecteurEmpreinte(racine);
  const dotGit = join(racine, '.git');
  const meta = await fs.lstat(dotGit);
  if (!meta.isDirectory()) {
    await relever(dotGit, '.git', { exclure: (nom) => nom !== '.git' });
    if (!meta.isFile()) return empreinte;
  }
  const commun = await lireGit(depot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const local = await lireGit(depot, ['rev-parse', '--absolute-git-dir']);
  for (const dossier of new Set([commun, local])) {
    const racineGit = await fs.realpath(dossier);
    const git = collecteurEmpreinte(racineGit);
    for (const fichier of ['config', 'config.worktree', 'hooks', 'info'])
      await git.relever(
        join(racineGit, fichier),
        join(dossier === commun ? '.git' : '.git/worktree', fichier),
      );
    Object.assign(empreinte, git.empreinte);
  }
  return empreinte;
}

export async function empreinteDepot(depot: string, go: string): Promise<EmpreinteEnvironnement> {
  const racine = await fs.realpath(depot);
  const { empreinte, relever } = collecteurEmpreinte(racine);
  const commande = await commandeGate(depot, go);
  const candidats = await fichiersGeles(depot, go, commande);
  candidats.add('node_modules/.bin');
  if ((await fs.lstat(join(racine, '.git'))).isFile()) await relever(join(racine, '.git'), '.git');
  const fichiers = (
    await lireGit(depot, [
      'status',
      '--porcelain',
      '-z',
      '--no-renames',
      '--ignored',
      '--untracked-files=all',
      '--',
      ':(glob)**/.claude',
      ':(glob)**/.claude/**',
      ':(glob)**/.codex',
      ':(glob)**/.codex/**',
      ':(glob)**/.mcp.json',
      ':(glob)**/CLAUDE.md',
      ':(glob)**/CLAUDE.local.md',
      ':(glob)**/AGENTS.md',
      ':(glob)**/.npmrc',
      ':(glob)**/agent.yml',
      ':(glob)**/package.json',
      ':(glob)**/*lock*',
      ':(glob)**/*config.*',
      ':(glob)**/.mocharc*',
      ':(glob)**/.vitest*',
      ':(glob)**/.jestrc*',
      ':(glob)**/*workspace.*',
      ':(glob)**/.github/**',
      ':(glob)**/.circleci/**',
      ':(glob)**/.buildkite/**',
      ':(glob)**/.woodpecker/**',
      ':(glob)**/.azure-pipelines/**',
      ':(glob)**/.gitlab-ci.yml',
      ':(glob)**/.travis.yml',
      ':(glob)**/Jenkinsfile',
      ':(glob)**/azure-pipelines.y*ml',
      ':(glob)**/.drone.yml',
      ':(glob)**/.woodpecker.yml',
    ])
  )
    .split('\0')
    .filter(Boolean);
  for (const entree of fichiers) {
    const fichier = entree.slice(3);
    if (
      configurationAgent(fichier) ||
      configurationCi(fichier) ||
      configTest(fichier) ||
      /^(?:agent\.yml|package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|\.npmrc)$/.test(
        basename(fichier),
      )
    ) {
      candidats.add(fichier);
      empreinte[fichier] = entree.slice(0, 2);
    }
  }
  for (const fichier of candidats) {
    const statut = empreinte[fichier];
    await relever(join(racine, fichier), fichier);
    if (statut) empreinte[fichier] = JSON.stringify([statut, empreinte[fichier]]);
  }
  return empreinte;
}

export function constatsEmpreinteHome(empreinte: EmpreinteEnvironnement): string[] {
  return Object.hasOwn(empreinte, constatHomeTropGros) ? [constatHomeTropGros] : [];
}

export function comparerEmpreintes(
  avant: EmpreinteEnvironnement,
  apres: EmpreinteEnvironnement,
): string[] {
  const depassement = [...constatsEmpreinteHome(avant), ...constatsEmpreinteHome(apres)];
  if (depassement.length) return [constatHomeTropGros];
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

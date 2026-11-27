import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const variablesGate = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TERM',
  'TZ',
  'CI',
]);

export function environnementGate(temporaire?: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([nom]) => variablesGate.has(nom) || nom.startsWith('LC_'),
      ),
    ),
    ...(temporaire && { TMPDIR: temporaire }),
  };
}

const protectionsGit = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'protocol.ext.allow=never',
];

function executerGit(
  depot: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout: number,
  entree?: string,
): Promise<string> {
  return new Promise((resoudre, rejeter) => {
    const enfant = execFile(
      'git',
      [...protectionsGit, ...args],
      {
        cwd: depot,
        env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        timeout,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024 * 1024,
      },
      (erreur, stdout) => (erreur ? rejeter(erreur) : resoudre(stdout)),
    );
    enfant.stdin?.on('error', rejeter);
    enfant.stdin?.end(entree);
  });
}

export function gitBoucle(depot: string, args: string[], entree?: string): Promise<string> {
  const lectureLongue =
    (args[0] === 'worktree' && args[1] === 'add') ||
    (args[0] === 'status' && args.some((arg) => /^--ignored(?:=|$)/.test(arg)));
  return executerGit(
    depot,
    ['-c', 'credential.helper=', '-c', 'core.sshCommand=false', ...args],
    environnementGate(),
    lectureLongue ? 60_000 : 10_000,
    entree,
  );
}

const hote = '[a-zA-Z0-9.][a-zA-Z0-9.-]*';
const utilisateur = '[a-zA-Z0-9_][a-zA-Z0-9_.-]*';
const adressesDistantes = [
  new RegExp(`^https://${hote}/.+$`),
  new RegExp(`^ssh://(?:${utilisateur}@)?${hote}(?::[0-9]+)?/.+$`),
  new RegExp(`^${utilisateur}@${hote}:.+$`),
];

export async function lireBaseDistante(depot: string, base: string): Promise<string> {
  const valeur = await gitBoucle(depot, [
    'config',
    '--local',
    '--null',
    '--get',
    'remote.origin.url',
  ]);
  const adresse = valeur.slice(0, -1);
  if (/[\p{Cc}\s]/u.test(adresse) || !adressesDistantes.some((forme) => forme.test(adresse))) {
    throw new Error('Adresse distante non autorisée');
  }
  const temporaire = await mkdtemp(join(tmpdir(), 'aid-git-distant-'));
  try {
    // Conserver les identifiants et la config utilisateur sans hériter du dépôt courant.
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(temporaire) };
    for (const nom of [
      'GIT_DIR',
      'GIT_COMMON_DIR',
      'GIT_WORK_TREE',
      'GIT_CONFIG',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_PARAMETERS',
    ] as const)
      delete env[nom];
    return await executerGit(
      temporaire,
      [
        '-c',
        'protocol.file.allow=never',
        'ls-remote',
        '--exit-code',
        '--',
        adresse,
        `refs/heads/${base}`,
      ],
      env,
      10_000,
    );
  } finally {
    await rm(temporaire, { recursive: true, force: true });
  }
}

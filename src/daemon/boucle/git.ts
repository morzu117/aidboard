import { execFile } from 'node:child_process';

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
    { ...environnementGate(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    lectureLongue ? 60_000 : 10_000,
    entree,
  );
}

export function lireBaseDistante(depot: string, base: string): Promise<string> {
  return executerGit(
    depot,
    ['ls-remote', '--exit-code', 'origin', `refs/heads/${base}`],
    process.env,
    10_000,
  );
}

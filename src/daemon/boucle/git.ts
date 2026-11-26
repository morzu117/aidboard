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

export function gitBoucle(depot: string, args: string[], entree?: string): Promise<string> {
  return new Promise((resoudre, rejeter) => {
    const enfant = execFile(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'credential.helper=',
        '-c',
        'core.sshCommand=false',
        '-c',
        'protocol.ext.allow=never',
        ...args,
      ],
      {
        cwd: depot,
        env: { ...environnementGate(), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        timeout: 10_000,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024 * 1024,
      },
      (erreur, stdout) => (erreur ? rejeter(erreur) : resoudre(stdout)),
    );
    enfant.stdin?.on('error', rejeter);
    enfant.stdin?.end(entree);
  });
}

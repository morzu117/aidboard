import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';

export interface GitResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };

export const GIT_ENV_LECTURE = { ...GIT_ENV, GIT_OPTIONAL_LOCKS: '0' };

export const GIT_ENV_DECOUVERTE = {
  GIT_DIR: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_WORK_TREE: undefined,
};

export const OPTIONS_GIT_SUJET = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];

interface GitSujet {
  args: string[];
  env: NodeJS.ProcessEnv;
}

const contexteGit = new AsyncLocalStorage<{
  db: Db;
  sujets: Map<string, Promise<GitSujet>>;
}>();

export function avecGitSujets<T>(db: Db, executer: () => T): T {
  return contexteGit.run({ db, sujets: new Map() }, executer);
}

export async function verifierGitSujet(cwd: string): Promise<GitSujet | undefined> {
  const contexte = contexteGit.getStore();
  if (!contexte) return undefined;
  const enCours = contexte.sujets.get(cwd);
  if (enCours) return enCours;
  const depot = contexte.db
    .prepare(
      'SELECT w.root FROM topics t JOIN workspaces w ON w.id = t.workspace_id WHERE t.worktree = ? LIMIT 1',
    )
    .get(cwd) as { root: string } | undefined;
  if (!depot) return undefined;
  const verification = resoudreGitSujet(cwd, depot.root);
  contexte.sujets.set(cwd, verification);
  return verification;
}

export async function environnementScriptGitSujet(cwd: string, env: NodeJS.ProcessEnv) {
  if (!(await verifierGitSujet(cwd))) return env;
  // Les scripts peuvent changer de worktree. Seuls les réglages suivent leurs appels Git.
  return {
    ...env,
    ...GIT_ENV_DECOUVERTE,
    GIT_CONFIG_PARAMETERS: [
      env.GIT_CONFIG_PARAMETERS,
      "'core.fsmonitor=false' 'core.hooksPath=/dev/null'",
    ]
      .filter(Boolean)
      .join(' '),
  };
}

async function resoudreGitSujet(cwd: string, depot: string): Promise<GitSujet> {
  const options = ['rev-parse', '--path-format=absolute'];
  const [attendu, trouve] = await Promise.all([
    executerGit(depot, [...OPTIONS_GIT_SUJET, ...options, '--git-common-dir'], undefined, true),
    executerGit(
      cwd,
      [...OPTIONS_GIT_SUJET, ...options, '--git-common-dir', '--git-dir'],
      undefined,
      true,
      GIT_ENV_DECOUVERTE,
    ),
  ]);
  const [commun, gitDir, surplus] = trouve.stdout.split('\n');
  const [racine, communReel, dossier] = await Promise.all(
    [attendu.stdout, commun, gitDir].map((p) =>
      p ? realpath(p).catch(() => undefined) : undefined,
    ),
  );
  if (
    !attendu.ok ||
    !trouve.ok ||
    surplus !== undefined ||
    !racine ||
    communReel !== racine ||
    !dossier
  ) {
    throw new AidHttpError(
      409,
      'GIT_COMMUN_INATTENDU : répertoire Git commun différent du dépôt du sujet',
      {
        code: 'GIT_COMMUN_INATTENDU',
      },
    );
  }
  return {
    args: [...OPTIONS_GIT_SUJET, `--git-dir=${dossier}`, `--work-tree=${cwd}`],
    env: { ...GIT_ENV_DECOUVERTE, GIT_COMMON_DIR: racine },
  };
}

// Liste positive : les écritures et les sous-commandes inconnues gardent leur environnement.
function estLecture(args: string[]): boolean {
  // Les diff de livraison précisent leurs réglages avant la sous-commande.
  while (args[0] === '-c' && args.length > 2) args = args.slice(2);
  return (
    [
      'rev-parse',
      'show-ref',
      'rev-list',
      'for-each-ref',
      'log',
      'status',
      'show',
      'diff',
      'diff-tree',
      'merge-base',
      'ls-remote',
    ].includes(args[0] ?? '') ||
    (args[0] === 'symbolic-ref' &&
      (args.length === 3 || args.length === 4) &&
      args[1] === '--quiet' &&
      (args.length === 3 || args[2] === '--short')) ||
    (args[0] === 'remote' && args[1] === 'get-url') ||
    (args[0] === 'worktree' && args[1] === 'list') ||
    (args[0] === 'stash' && args[1] === 'list') ||
    (args[0] === 'config' &&
      args.length === 2 &&
      (args[1] === 'user.name' || args[1] === 'user.email'))
  );
}

export async function git(cwd: string, args: string[], timeout?: number): Promise<GitResult> {
  const sujet = await verifierGitSujet(cwd);
  return executerGit(
    cwd,
    sujet ? [...sujet.args, ...args] : args,
    timeout,
    estLecture(args),
    sujet?.env,
  );
}

// Jamais de shell : execFile avec un tableau d'arguments.
function executerGit(
  cwd: string,
  args: string[],
  timeout: number | undefined,
  lecture: boolean,
  env?: NodeJS.ProcessEnv,
): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout,
        env: { ...process.env, ...(lecture ? GIT_ENV_LECTURE : GIT_ENV), ...env },
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: number | string }).code ?? null) : 0;
        resolve({
          ok: !err,
          code: typeof code === 'number' ? code : null,
          // Fin seulement : `status --porcelain` (11.7) commence parfois une ligne par une
          // espace significative (colonne d'index vide) — un .trim() plein la mangeait et
          // décalait tout le parsing en largeur fixe d'un caractère.
          stdout: String(stdout).replace(/\s+$/, ''),
          stderr: String(stderr).trim(),
        });
      },
    );
  });
}

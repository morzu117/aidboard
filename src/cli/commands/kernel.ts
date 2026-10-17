import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { packageRoot } from '../version.js';

export interface KernelPaths {
  sourceDir: string;
  targetDir: string;
  claudeCommandsDir: string;
}

export function defaultKernelPaths(env: NodeJS.ProcessEnv = process.env): KernelPaths {
  const home = env.HOME ?? homedir();
  return {
    sourceDir: join(packageRoot(), 'kernel'),
    targetDir: join(home, '.agent-kernel'),
    claudeCommandsDir: join(home, '.claude', 'commands'),
  };
}

export interface KernelInstallResult {
  written: string[];
  removed: string[];
  syncCommandWritten: boolean;
}

function listFilesRecursive(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full, base));
    else out.push(relative(base, full));
  }
  return out;
}

function differs(a: string, b: string): boolean {
  if (!existsSync(b)) return true;
  return !readFileSync(a).equals(readFileSync(b));
}

// Chantier 09 (DS1) : aucun clone git séparé — aid matérialise kernel/ (embarqué dans le
// package publié) vers ~/.agent-kernel. Idempotent, et nettoie ce qu'une version plus
// récente du contenu a retiré (un simple cp -r laisserait traîner les fichiers disparus).
export function kernelInstall(
  paths: KernelPaths,
  opts: { check?: boolean } = {},
): KernelInstallResult {
  const sourceFiles = listFilesRecursive(paths.sourceDir);
  const targetFiles = listFilesRecursive(paths.targetDir);
  const toWrite = sourceFiles.filter((rel) =>
    differs(join(paths.sourceDir, rel), join(paths.targetDir, rel)),
  );
  const toRemove = targetFiles.filter((rel) => !sourceFiles.includes(rel));

  const syncRel = join('commands', 'sync.md');
  const syncSrc = join(paths.sourceDir, syncRel);
  const syncDst = join(paths.claudeCommandsDir, 'sync.md');
  const syncCommandWritten = existsSync(syncSrc) && differs(syncSrc, syncDst);

  if (!opts.check) {
    for (const rel of toWrite) {
      const dst = join(paths.targetDir, rel);
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, readFileSync(join(paths.sourceDir, rel)));
    }
    for (const rel of toRemove) rmSync(join(paths.targetDir, rel));
    if (syncCommandWritten) {
      mkdirSync(paths.claudeCommandsDir, { recursive: true });
      writeFileSync(syncDst, readFileSync(syncSrc));
    }
  }
  return { written: toWrite, removed: toRemove, syncCommandWritten };
}

/** `aid kernel install [--check]` */
export function runKernel(
  action: string,
  args: string[],
  paths: KernelPaths = defaultKernelPaths(),
  out: (l: string) => void = console.log,
): number {
  if (action !== 'install') {
    console.error(`aid kernel : action inconnue « ${action} » (install)`);
    return 1;
  }
  const check = args.includes('--check');
  try {
    const r = kernelInstall(paths, { check });
    if (r.written.length === 0 && r.removed.length === 0 && !r.syncCommandWritten) {
      out(`✓ ${paths.targetDir} déjà à jour`);
      return 0;
    }
    const verb = check ? 'à écrire' : 'écrit(s)';
    if (r.written.length > 0)
      out(`✓ ${r.written.length} fichier(s) ${verb} dans ${paths.targetDir}`);
    if (r.removed.length > 0) {
      out(
        `✓ ${r.removed.length} fichier(s) ${check ? 'à retirer' : 'retiré(s)'} (disparus du noyau)`,
      );
    }
    if (r.syncCommandWritten) {
      out(
        `✓ commande /sync ${check ? 'à installer' : 'installée'} dans ${paths.claudeCommandsDir}`,
      );
    }
    return 0;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}

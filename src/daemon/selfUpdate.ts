import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { assetName, currentServer, serverDir } from './install.js';
import { newerThan, type Release } from './releaseCheck.js';

const run = promisify(execFile);

export interface PullAndBuildResult {
  ok: boolean;
  step?: 'pull' | 'build';
  error?: string;
}

export type BuildFn = (repoDir: string) => Promise<void>;

export const npmRunBuild: BuildFn = async (repoDir) => {
  await run('npm', ['run', 'build'], {
    cwd: repoDir,
    timeout: 180_000,
    maxBuffer: 10 * 1024 * 1024,
  });
};

/**
 * `git pull --ff-only` puis build. Fast-forward only : un pull qui écraserait du travail local non
 * commité ou divergent est refusé par git lui-même, jamais contourné ici.
 */
export async function pullAndBuild(
  repoDir: string,
  branch = 'main',
  build: BuildFn = npmRunBuild,
): Promise<PullAndBuildResult> {
  try {
    await run('git', ['pull', '--ff-only', 'origin', branch], { cwd: repoDir, timeout: 60_000 });
  } catch (err) {
    return { ok: false, step: 'pull', error: (err as Error).message };
  }
  try {
    await build(repoDir);
  } catch (err) {
    return { ok: false, step: 'build', error: (err as Error).message };
  }
  return { ok: true };
}

/** Ce qu'il faut pour lancer un daemon : quel Node, quel build (13.5, DR8). */
export interface Launch {
  execPath: string;
  entry: string;
}

/** Le Node et le build de CE process — en mode release, ceux de l'archive qui tourne. */
export function currentLaunch(): Launch {
  return { execPath: process.execPath, entry: realpathSync(process.argv[1] ?? '') };
}

/**
 * Processus détaché, indépendant du daemon courant : attend que `pid` meure puis relance
 * `launch.entry daemon` avec `launch.execPath` — jamais `process.execPath` implicite : après
 * une mise à jour en mode release, c'est le Node de la nouvelle archive qu'il faut (DR8). Doit survivre à l'exit du process qui l'a lancé — c'est ce qui permet au
 * daemon de repartir tout seul après s'être arrêté pour charger le nouveau build.
 */
export function spawnRespawnWatcher(pid: number, launch: Launch, home: string): void {
  const code = `
    const pid = ${pid};
    const sab = new SharedArrayBuffer(4);
    const ia = new Int32Array(sab);
    while (true) {
      try { process.kill(pid, 0); } catch { break; }
      Atomics.wait(ia, 0, 0, 150);
    }
    const { spawn } = require('node:child_process');
    const child = spawn(${JSON.stringify(launch.execPath)}, [${JSON.stringify(launch.entry)}, 'daemon'], {
      detached: true,
      stdio: 'ignore',
      env: Object.assign({}, process.env, { AID_HOME: ${JSON.stringify(home)} }),
    });
    child.unref();
  `;
  const watcher = spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' });
  watcher.unref();
}

export type InstallStep = 'download' | 'verify' | 'extract' | 'switch';
export type InstallReleaseResult =
  { ok: true; launch: Launch; dir: string } | { ok: false; step: InstallStep; error: string };

const SEMVER_DIR = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function download(url: string, to: string, fetchFn: typeof fetch): Promise<void> {
  const res = await fetchFn(url, {
    headers: { 'user-agent': 'aidboard' },
    signal: AbortSignal.timeout(10 * 60_000),
    redirect: 'follow',
  });
  if (!res.ok || !res.body) throw new Error(`${url} : réponse ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as WebReadableStream), createWriteStream(to));
}

/**
 * Remplace `current` par un lien vers `version`, atomiquement (rename d'un lien temporaire) :
 * à aucun moment `current` ne manque ni ne pointe sur une version incomplète (DR7).
 */
export function switchCurrent(home: string, version: string): void {
  const dir = serverDir(home);
  if (!existsSync(join(dir, version, 'bin', 'aid'))) {
    throw new Error(`version ${version} absente de ${dir}`);
  }
  const tmp = join(dir, `.current-${process.pid}`);
  rmSync(tmp, { force: true });
  symlinkSync(version, tmp);
  renameSync(tmp, join(dir, 'current'));
}

/** Les versions présentes sous ~/.aid/server, la plus récente d'abord. */
export function installedServers(home: string): string[] {
  let names: string[];
  try {
    names = readdirSync(serverDir(home));
  } catch {
    return [];
  }
  return names
    .filter((n) => SEMVER_DIR.test(n) && existsSync(join(serverDir(home), n, 'bin', 'aid')))
    .sort((a, b) => (newerThan(a, b) ? 1 : newerThan(b, a) ? -1 : 0));
}

/**
 * Télécharge, vérifie, extrait, bascule (DR7). Chaque étape qui échoue laisse `current` et le
 * daemon courant intacts, avec l'étape fautive dans le résultat — comme pullAndBuild.
 */
export async function installRelease(
  release: Release,
  home: string,
  opts: {
    fetchFn?: typeof fetch;
    log?: (line: string) => void;
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
  } = {},
): Promise<InstallReleaseResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const log = opts.log ?? (() => undefined);
  const root = serverDir(home);
  const dir = join(root, release.version);
  const partial = join(root, `${release.version}.partial`);
  const fail = (step: InstallStep, error: string): InstallReleaseResult => {
    rmSync(partial, { recursive: true, force: true });
    log(`release ${release.version} : échec (${step}) : ${error}`);
    return { ok: false, step, error };
  };

  if (!existsSync(join(dir, 'bin', 'aid'))) {
    let name: string;
    try {
      name = assetName(release.version, opts.platform, opts.arch);
    } catch (err) {
      return fail('download', (err as Error).message);
    }
    const url = release.assets[name];
    const sumsUrl = release.assets['SHA256SUMS'];
    if (!url) return fail('download', `aucun asset ${name} dans la release ${release.version}`);
    if (!sumsUrl) return fail('download', `aucun SHA256SUMS dans la release ${release.version}`);
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true, mode: 0o700 });
    const archive = join(partial, name);
    const sums = join(partial, 'SHA256SUMS');
    log(`release ${release.version} : téléchargement de ${name}`);
    try {
      await download(url, archive, fetchFn);
      await download(sumsUrl, sums, fetchFn);
    } catch (err) {
      return fail('download', (err as Error).message);
    }
    const expected = readFileSync(sums, 'utf8')
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .find(([, n]) => n === name)?.[0];
    if (!expected) return fail('verify', `${name} absent de SHA256SUMS`);
    const actual = await sha256File(archive);
    if (actual !== expected) {
      return fail(
        'verify',
        `somme SHA-256 de ${name} incorrecte (attendu ${expected}, obtenu ${actual})`,
      );
    }
    const extracted = join(partial, 'x');
    mkdirSync(extracted);
    try {
      await run('tar', ['xzf', archive, '-C', extracted], { timeout: 5 * 60_000 });
    } catch (err) {
      return fail('extract', (err as Error).message);
    }
    for (const must of ['bin/aid', 'node/bin/node', 'dist/cli/aid.js']) {
      if (!existsSync(join(extracted, must))) return fail('extract', `${must} absent de l'archive`);
    }
    rmSync(dir, { recursive: true, force: true });
    renameSync(extracted, dir);
    rmSync(partial, { recursive: true, force: true });
  } else {
    log(`release ${release.version} : déjà présente, bascule seulement`);
  }
  try {
    switchCurrent(home, release.version);
  } catch (err) {
    return { ok: false, step: 'switch', error: (err as Error).message };
  }
  log(`release ${release.version} : current → ${release.version}`);
  return {
    ok: true,
    dir,
    launch: {
      execPath: join(dir, 'node', 'bin', 'node'),
      entry: join(dir, 'dist', 'cli', 'aid.js'),
    },
  };
}

/** Garde `current` et les `keep` versions les plus récentes ; supprime le reste (DR4). Rend les versions supprimées. */
export function pruneServers(home: string, keep = 2): string[] {
  const current = currentServer(home)?.version;
  const kept = new Set<string>(current ? [current] : []);
  for (const v of installedServers(home)) {
    if (kept.size >= keep) break;
    kept.add(v);
  }
  const removed: string[] = [];
  for (const v of installedServers(home)) {
    if (kept.has(v)) continue;
    rmSync(join(serverDir(home), v), { recursive: true, force: true });
    removed.push(v);
  }
  return removed;
}

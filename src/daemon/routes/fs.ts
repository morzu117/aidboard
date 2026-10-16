import { type Dirent } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { FsListing, FsEntry } from '../../shared/fs.js';
import { AidHttpError } from '../errors.js';

const Query = Type.Object(
  { path: Type.Optional(Type.String({ minLength: 1 })), hidden: Type.Optional(Type.Boolean()) },
  { additionalProperties: false },
);

const MAX_ENTRIES = 1000;

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Un dépôt principal a un dossier `.git` ; un worktree lié n'a qu'un fichier, il ne compte pas. */
const isRepoRoot = (p: string) => isDir(join(p, '.git'));

export async function listDirectories(
  wanted: string | undefined,
  showHidden: boolean,
  home: string = homedir(),
): Promise<FsListing> {
  const target = wanted ?? home;
  if (!isAbsolute(target)) throw new AidHttpError(422, `${target} n'est pas un chemin absolu`);
  let path: string;
  try {
    path = await realpath(target);
  } catch {
    throw new AidHttpError(404, `${target} est introuvable`);
  }
  if (!(await isDir(path))) throw new AidHttpError(422, `${path} n'est pas un dossier`);
  let dirents: Dirent[];
  try {
    dirents = await readdir(path, { withFileTypes: true });
  } catch {
    throw new AidHttpError(403, `${path} n'est pas lisible`);
  }
  const candidates = dirents
    .filter((d) => showHidden || !d.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const dirs: FsEntry[] = [];
  for (const d of candidates) {
    const full = join(path, d.name);
    // un lien symbolique vers un dossier se parcourt comme un dossier
    if (!(d.isDirectory() || (d.isSymbolicLink() && (await isDir(full))))) continue;
    dirs.push({ name: d.name, path: full, isRepo: false });
  }
  const truncated = dirs.length > MAX_ENTRIES;
  const entries = dirs.slice(0, MAX_ENTRIES);
  await Promise.all(
    entries.map(async (e) => {
      e.isRepo = await isRepoRoot(e.path);
    }),
  );
  const parent = dirname(path);
  return {
    path,
    parent: parent === path ? null : parent,
    home,
    isRepo: await isRepoRoot(path),
    entries,
    truncated,
  };
}

export function registerFsRoutes(app: FastifyInstance, deps: { home?: string } = {}): void {
  app.get('/api/fs/dirs', { schema: { querystring: Query } }, async (req) => {
    const q = req.query as { path?: string; hidden?: boolean };
    return listDirectories(q.path, q.hidden ?? false, deps.home);
  });
}

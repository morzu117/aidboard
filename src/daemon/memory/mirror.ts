import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { git, type GitResult } from '../git/exec.js';
import { assertMemSlug, isValidMemSlug } from './slug.js';

export type GitExec = (cwd: string, args: string[], timeout?: number) => Promise<GitResult>;
export type Logger = (line: string) => void;

export function machineName(): string {
  return (
    hostname()
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '-') || 'local'
  );
}

export interface MirrorSyncHealth {
  push: boolean;
  origin: boolean;
  // Comparaison avec la dernière référence récupérée ; null si elle est inconnue.
  ahead: number | null;
  behind: number | null;
  conflicts: string[];
}

// Parcourt un dossier de pages, par ordre de slug : un `.md` par page, chemin relatif sans extension = slug.
export function* walkMarkdown(root: string, dir = root): Iterable<{ slug: string; path: string }> {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) yield* walkMarkdown(root, path);
    else if (e.isFile() && e.name.endsWith('.md')) {
      yield { slug: relative(root, path).slice(0, -3).split(sep).join('/'), path };
    }
  }
}

// Le miroir est la source de vérité (DM1) : un fichier par page, un dépôt git à part des workspaces.
export class MemoryMirror {
  private pending: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  push = false;
  // Le service sérialise aussi le tirage avec les écritures de pages.
  synchronize: (action: () => Promise<void>) => Promise<void> = (action) => action();
  readonly pulledSlugs = new Set<string>();

  async syncHealth(): Promise<MirrorSyncHealth> {
    const origin = (await this.exec(this.root, ['remote', 'get-url', 'origin'])).ok;
    const health: MirrorSyncHealth = {
      push: this.push,
      origin,
      ahead: null,
      behind: null,
      conflicts: this.conflicts,
    };
    if (!origin) return health;
    const branch = await this.exec(this.root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!branch.ok) return health;
    // La santé ne déclenche ni réseau ni synchronisation du miroir.
    const counts = await this.exec(this.root, [
      'rev-list',
      '--left-right',
      '--count',
      `HEAD...refs/remotes/origin/${branch.stdout.trim()}`,
    ]);
    if (counts.ok && /^\d+\s+\d+$/.test(counts.stdout.trim())) {
      const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
      health.ahead = ahead!;
      health.behind = behind!;
    }
    return health;
  }

  get conflicts(): string[] {
    const marker = join(this.root, '.git', 'aid-memory-conflicts.json');
    try {
      const paths: unknown = JSON.parse(readFileSync(marker, 'utf8'));
      return Array.isArray(paths) && paths.every((path) => typeof path === 'string')
        ? paths
        : ['marqueur illisible'];
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : ['marqueur illisible'];
    }
  }

  async pull(): Promise<void> {
    await this.synchronize(async () => {
      await this.pullFromOrigin();
    });
  }

  private async pullFromOrigin(): Promise<boolean> {
    if (this.conflicts.length > 0) {
      this.log('miroir mémoire : conflit en attente, synchronisation arrêtée');
      return false;
    }
    if (!this.push) return false;
    if (!(await this.exec(this.root, ['remote', 'get-url', 'origin'])).ok) return false;
    const fail = (message: string) => {
      this.log(`miroir mémoire : ${message}`);
      return false;
    };
    const branch = await this.exec(this.root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!branch.ok) return fail('branche du miroir absente');
    const remote = `refs/remotes/origin/${branch.stdout}`;
    const before = await this.exec(this.root, ['rev-parse', '--verify', remote]);
    const fetched = await this.exec(this.root, ['fetch', '-q', 'origin'], 30_000);
    if (!fetched.ok) return fail(`git fetch a échoué : ${fetched.stderr}`);
    const after = await this.exec(this.root, ['rev-parse', '--verify', remote]);
    if (!after.ok) return true;
    if (await this.dirty()) return fail('fichiers non commités, tirage différé');
    const ff = await this.exec(this.root, ['merge', '--ff-only', remote]);
    if (!ff.ok) {
      // Garder le contenu exact du sommet local, même si plusieurs commits sont rejoués.
      const local = new Map<string, string>();
      for await (const page of this.readAll()) local.set(page.slug, page.text);
      const rebase = await this.exec(this.root, ['-c', 'rerere.enabled=false', 'rebase', remote]);
      if (!rebase.ok) {
        const unmerged = await this.exec(this.root, [
          'diff',
          '--name-only',
          '--diff-filter=U',
          '-z',
        ]);
        const paths = unmerged.ok ? unmerged.stdout.split('\0').filter(Boolean) : [];
        if (paths.length === 0) {
          await this.exec(this.root, ['rebase', '--abort']);
          return fail(`git rebase a échoué sans conflit : ${rebase.stderr}`);
        }
        const slugs = paths
          .filter((path) => path.endsWith('.md') && isValidMemSlug(path.slice(0, -3)))
          .map((path) => path.slice(0, -3));
        // Le marqueur survit au redémarrage ; aucune nouvelle tentative ne résout le conflit.
        writeFileSync(join(this.root, '.git', 'aid-memory-conflicts.json'), JSON.stringify(paths), {
          mode: 0o600,
        });
        const aborted = await this.exec(this.root, ['rebase', '--abort']);
        if (!aborted.ok) return fail(`git rebase --abort a échoué : ${aborted.stderr}`);
        const machine = machineName();
        for (const slug of slugs) {
          const text = local.get(slug);
          if (text !== undefined) {
            let copy = `${slug}.conflit-${machine}`;
            for (let suffix = 2; ; suffix++) {
              try {
                writeFileSync(join(this.root, `${copy}.md`), text, { mode: 0o600, flag: 'wx' });
                break;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                copy = `${slug}.conflit-${machine}-${suffix}`;
              }
            }
            if (isValidMemSlug(copy)) this.pulledSlugs.add(copy);
          }
          const restored = await this.exec(this.root, [
            'restore',
            '--source',
            remote,
            '--worktree',
            '--',
            `${slug}.md`,
          ]);
          if (!restored.ok) return fail(`copie distante du conflit : ${restored.stderr}`);
          this.pulledSlugs.add(slug);
        }
        return fail(`conflit en attente : ${paths.join(', ') || rebase.stderr}`);
      }
    }
    const changed = await this.exec(
      this.root,
      before.ok
        ? ['diff', '--name-only', '--no-renames', '-z', before.stdout, after.stdout]
        : ['ls-tree', '-r', '--name-only', '-z', after.stdout],
    );
    if (!changed.ok) return fail(`lecture des pages tirées : ${changed.stderr}`);
    for (const path of changed.stdout.split('\0')) {
      if (path.endsWith('.md') && isValidMemSlug(path.slice(0, -3))) {
        this.pulledSlugs.add(path.slice(0, -3));
      }
    }
    return true;
  }

  constructor(
    readonly root: string,
    private readonly exec: GitExec = git,
    private readonly log: Logger = (l) => console.error(l),
    private readonly debounceMs = 2000,
  ) {}

  async init(): Promise<void> {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    chmodSync(this.root, 0o700);
    if (!existsSync(join(this.root, '.git'))) {
      const r = await this.exec(this.root, ['init', '-q', '-b', 'main']);
      if (!r.ok) throw new Error(`git init du miroir mémoire : ${r.stderr}`);
    }
    const ignore = join(this.root, '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, '', { mode: 0o600 });
    // un commit a besoin d'une identité ; celle du poste si elle existe, sinon une locale au dépôt
    for (const [key, value] of [
      ['user.name', 'A-I-D'],
      ['user.email', 'aid@localhost'],
    ] as const) {
      if (!(await this.exec(this.root, ['config', key])).ok) {
        await this.exec(this.root, ['config', key, value]);
      }
    }
    // Un dépôt neuf peut avancer vers origin sans fabriquer un historique concurrent.
    const unborn = !(await this.exec(this.root, ['rev-parse', '--verify', 'HEAD'])).ok;
    if (unborn && readFileSync(ignore, 'utf8') === '') rmSync(ignore);
    await this.pull();
    if (!existsSync(ignore)) writeFileSync(ignore, '', { mode: 0o600 });
  }

  pathOf(slug: string): string {
    assertMemSlug(slug);
    return join(this.root, `${slug}.md`);
  }

  async write(slug: string, text: string): Promise<void> {
    const path = this.pathOf(slug);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { mode: 0o600 });
  }

  async remove(slug: string): Promise<void> {
    rmSync(this.pathOf(slug), { force: true });
  }

  // Les écritures d'une rafale partent dans un seul commit.
  scheduleCommit(message: string): void {
    this.pending.push(message);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.debounceMs);
    this.timer.unref();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length > 0) {
      const messages = this.pending;
      this.pending = [];
      this.chain = this.chain.then(() => this.commit(messages));
    }
    await this.chain;
  }

  private async commit(messages: string[]): Promise<void> {
    await this.synchronize(() => this.commitAndPush(messages));
  }

  private async commitAndPush(messages: string[]): Promise<void> {
    if (this.conflicts.length > 0) return this.log('miroir mémoire : conflit en attente');
    const add = await this.exec(this.root, ['add', '-A']);
    if (!add.ok) return this.log(`miroir mémoire : git add a échoué : ${add.stderr}`);
    if ((await this.exec(this.root, ['diff', '--cached', '--quiet'])).ok) return;
    const message =
      messages.length === 1
        ? messages[0]!
        : `mem: ${messages.length} pages\n\n${messages.join('\n')}`;
    const commit = await this.exec(this.root, ['commit', '-q', '-m', message]);
    if (!commit.ok) return this.log(`miroir mémoire : git commit a échoué : ${commit.stderr}`);
    await this.pushFromOrigin();
  }

  // DM1 : `memory.git.push` ; jamais bloquant, l'échec est journalisé.
  async pushIfConfigured(): Promise<void> {
    await this.synchronize(() => this.pushFromOrigin());
  }

  private async pushFromOrigin(): Promise<void> {
    if (!this.push) return;
    if (!(await this.exec(this.root, ['remote', 'get-url', 'origin'])).ok) return;
    if (!(await this.pullFromOrigin())) return;
    if (!(await this.exec(this.root, ['rev-parse', '--verify', '@{upstream}'])).ok) {
      const first = await this.exec(this.root, ['push', '-q', '-u', 'origin', 'HEAD']);
      if (!first.ok) this.log(`miroir mémoire : git push a échoué : ${first.stderr}`);
      return;
    }
    const r = await this.exec(this.root, ['push', '-q']);
    if (!r.ok) this.log(`miroir mémoire : git push a échoué : ${r.stderr}`);
  }

  // Fichiers non commités : ce que `aid doctor` signale.
  async dirty(): Promise<boolean> {
    const r = await this.exec(this.root, ['status', '--porcelain']);
    return r.ok && r.stdout !== '';
  }

  async *readAll(): AsyncIterable<{ slug: string; text: string }> {
    if (!existsSync(this.root)) return;
    for (const f of walkMarkdown(this.root)) {
      if (!isValidMemSlug(f.slug)) {
        this.log(`miroir mémoire : ${f.path} ignoré, slug invalide`);
        continue;
      }
      yield { slug: f.slug, text: readFileSync(f.path, 'utf8') };
    }
  }
}

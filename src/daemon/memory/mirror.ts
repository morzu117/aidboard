import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { git, type GitResult } from '../git/exec.js';
import { assertMemSlug, isValidMemSlug } from './slug.js';

export type GitExec = (cwd: string, args: string[]) => Promise<GitResult>;
export type Logger = (line: string) => void;

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
    const add = await this.exec(this.root, ['add', '-A']);
    if (!add.ok) return this.log(`miroir mémoire : git add a échoué : ${add.stderr}`);
    if ((await this.exec(this.root, ['diff', '--cached', '--quiet'])).ok) return;
    const message =
      messages.length === 1
        ? messages[0]!
        : `mem: ${messages.length} pages\n\n${messages.join('\n')}`;
    const commit = await this.exec(this.root, ['commit', '-q', '-m', message]);
    if (!commit.ok) return this.log(`miroir mémoire : git commit a échoué : ${commit.stderr}`);
    await this.pushIfConfigured();
  }

  // DM1 : `memory.git.push` ; jamais bloquant, l'échec est journalisé.
  async pushIfConfigured(): Promise<void> {
    if (!this.push) return;
    if (!(await this.exec(this.root, ['remote', 'get-url', 'origin'])).ok) return;
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

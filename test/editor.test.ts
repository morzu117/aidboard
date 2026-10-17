import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test } from 'vitest';
import {
  defaultEditor,
  diffCommand,
  editorCommand,
  onPath,
  openDiffInEditor,
  openInEditor,
} from '../src/daemon/actions/editor.js';
import { commitFile, sh } from './helpers/git.js';
import { waitFor } from './helpers/daemon.js';
import { type Ctx, makeTopic, postAction, setupWorkspace } from './helpers/topics.js';

const FAKE = join(import.meta.dirname, 'fixtures/fake-editor.sh');
const out = join(mkdtempSync(join(tmpdir(), 'aid-ed-')), 'argv.txt');
const ORIGINAL_PATH = process.env.PATH;
let c: Ctx;
afterEach(async () => {
  delete process.env.FAKE_EDITOR_OUT;
  process.env.PATH = ORIGINAL_PATH;
  rmSync(out, { force: true });
  await c?.t.d.stop();
});

test('éditeur par défaut selon la plateforme et la présence de code', () => {
  expect(defaultEditor('darwin', true)).toEqual(['code', '{path}']);
  expect(defaultEditor('darwin', false)).toEqual(['open', '-a', 'Visual Studio Code', '{path}']);
  expect(defaultEditor('linux', false)).toEqual(['xdg-open', '{path}']);
  expect(defaultEditor('linux', true)).toEqual(['code', '{path}']);
});

test('une commande configurée prime sur la détection', () => {
  expect(editorCommand(['vim', '{path}'], 'darwin')).toEqual(['vim', '{path}']);
});

test('onPath trouve un exécutable et pas un absent', () => {
  expect(onPath('bash', '/bin:/usr/bin')).toBe(true);
  expect(onPath('nexiste-pas-du-tout', '/bin:/usr/bin')).toBe(false);
});

test('un chemin avec espaces, point-virgule et $() arrive intact en un seul argument', async () => {
  process.env.FAKE_EDITOR_OUT = out;
  const path = '/tmp/a b;c$(touch /tmp/pwned-aid)`x`';
  await openInEditor([FAKE, '--nouvelle-fenetre', '{path}'], path);
  await waitFor(() => existsSync(out), 3000, 'argv écrit');
  expect(readFileSync(out, 'utf8').split('\n').slice(0, 2)).toEqual(['--nouvelle-fenetre', path]);
  expect(existsSync('/tmp/pwned-aid')).toBe(false);
});

test('un éditeur introuvable rejette', async () => {
  await expect(openInEditor(['/nexiste/pas/editeur', '{path}'], '/tmp')).rejects.toThrow(/ENOENT/);
  await expect(openInEditor([], '/tmp')).rejects.toThrow();
});

test('editor.open : 204 et le worktree est passé à l’éditeur configuré', async () => {
  process.env.FAKE_EDITOR_OUT = out;
  c = await setupWorkspace({ editor: [FAKE, '{path}'] });
  const { wt, topicId } = await makeTopic(c);
  const r = await postAction(c, topicId, 'editor.open');
  expect(r.statusCode).toBe(204);
  await waitFor(() => existsSync(out), 3000, 'argv écrit');
  expect(readFileSync(out, 'utf8').trim()).toBe(wt);
});

test('editor.open avec un éditeur introuvable : 422 qui nomme la commande et le réglage', async () => {
  c = await setupWorkspace({ editor: ['/nexiste/pas/editeur', '{path}'] });
  const { topicId } = await makeTopic(c);
  const r = await postAction(c, topicId, 'editor.open');
  expect(r.statusCode).toBe(422);
  expect(r.json().error).toContain('/nexiste/pas/editeur');
  expect(r.json().error).toContain('config.yaml');
});

test('editor.open sur un worktree disparu : 409', async () => {
  c = await setupWorkspace({ editor: [FAKE, '{path}'] });
  const { wt, topicId } = await makeTopic(c);
  rmSync(wt, { recursive: true, force: true });
  expect((await postAction(c, topicId, 'editor.open')).statusCode).toBe(409);
});

// 11.11 (D32)

test('diffCommand : connu seulement pour « code », null pour tout autre éditeur', () => {
  expect(diffCommand(['code', '{path}'])).toEqual(['code', '--diff', '{before}', '{after}']);
  expect(diffCommand(['vim', '{path}'])).toBeNull();
  expect(diffCommand([])).toBeNull();
});

test('openDiffInEditor : avant et après arrivent chacun en un seul argument', async () => {
  process.env.FAKE_EDITOR_OUT = out;
  await openDiffInEditor([FAKE, '--diff', '{before}', '{after}'], '/tmp/a v;ant', '/tmp/apr$(x)es');
  await waitFor(() => existsSync(out), 3000, 'argv écrit');
  expect(readFileSync(out, 'utf8').split('\n').slice(0, 3)).toEqual([
    '--diff',
    '/tmp/a v;ant',
    '/tmp/apr$(x)es',
  ]);
});

test('editeur.ouvrir-fichier : chemin précis transmis par variable, résolu sous le worktree', async () => {
  process.env.FAKE_EDITOR_OUT = out;
  c = await setupWorkspace({ editor: [FAKE, '{path}'] });
  const { wt, topicId } = await makeTopic(c);
  commitFile(wt, 'a.ts', 'contenu\n');
  const r = await postAction(c, topicId, 'editeur.ouvrir-fichier', { path: 'a.ts' });
  expect(r.statusCode).toBe(204);
  await waitFor(() => existsSync(out), 3000, 'argv écrit');
  expect(readFileSync(out, 'utf8').trim()).toBe(realpathSync(join(wt, 'a.ts')));
});

test('editeur.ouvrir-fichier : chemin manquant (422), hors du worktree (422), introuvable (404)', async () => {
  c = await setupWorkspace({ editor: [FAKE, '{path}'] });
  const { topicId } = await makeTopic(c);
  expect((await postAction(c, topicId, 'editeur.ouvrir-fichier', {})).statusCode).toBe(422);
  expect(
    (
      await postAction(c, topicId, 'editeur.ouvrir-fichier', {
        path: '../../../../../../../../../../../../../../../../../../../../etc/passwd',
      })
    ).statusCode,
  ).toBe(422);
  expect(
    (await postAction(c, topicId, 'editeur.ouvrir-fichier', { path: 'nexiste-pas.ts' })).statusCode,
  ).toBe(404);
});

test('diff.ouvrir : repli déclaré, ouvre le worktree (aucun visualiseur multi-fichiers en app)', async () => {
  process.env.FAKE_EDITOR_OUT = out;
  c = await setupWorkspace({ editor: [FAKE, '{path}'] });
  const { wt, topicId } = await makeTopic(c);
  const r = await postAction(c, topicId, 'diff.ouvrir', { hash: 'peu-importe' });
  expect(r.statusCode).toBe(204);
  await waitFor(() => existsSync(out), 3000, 'argv écrit');
  expect(readFileSync(out, 'utf8').trim()).toBe(wt);
});

test('diff.ouvrir-fichier : éditeur sans diff natif connu, repli sur le fichier courant', async () => {
  process.env.FAKE_EDITOR_OUT = out;
  c = await setupWorkspace({ editor: [FAKE, '{path}'] });
  const { wt, topicId } = await makeTopic(c);
  commitFile(wt, 'a.txt', 'v1\n');
  const hash = sh(wt, 'rev-parse', 'HEAD');
  commitFile(wt, 'a.txt', 'v2\n', 'maj a.txt');
  const r = await postAction(c, topicId, 'diff.ouvrir-fichier', { hash, path: 'a.txt' });
  expect(r.statusCode).toBe(204);
  await waitFor(() => existsSync(out), 3000, 'argv écrit');
  expect(readFileSync(out, 'utf8').trim()).toBe(realpathSync(join(wt, 'a.txt')));
});

test('diff.ouvrir-fichier : éditeur « code », diff natif avec le contenu avant/après extrait du commit', async () => {
  const codeDir = mkdtempSync(join(tmpdir(), 'aid-code-'));
  copyFileSync(FAKE, join(codeDir, 'code'));
  chmodSync(join(codeDir, 'code'), 0o755);
  process.env.PATH = `${codeDir}${delimiter}${process.env.PATH ?? ''}`;
  process.env.FAKE_EDITOR_OUT = out;
  c = await setupWorkspace({ editor: ['code', '{path}'] });
  const { wt, topicId } = await makeTopic(c);
  // Fichier ajouté par ce commit : rien à sa révision parente, « avant » est donc vide.
  commitFile(wt, 'nouveau.txt', 'contenu ajouté\n');
  const hash = sh(wt, 'rev-parse', 'HEAD');
  commitFile(wt, 'nouveau.txt', 'contenu modifié\n', 'modif nouveau.txt');

  const r = await postAction(c, topicId, 'diff.ouvrir-fichier', { hash, path: 'nouveau.txt' });
  expect(r.statusCode).toBe(204);
  await waitFor(() => existsSync(out), 3000, 'argv écrit');
  const argv = readFileSync(out, 'utf8').split('\n');
  expect(argv[0]).toBe('--diff');
  expect(readFileSync(argv[1]!, 'utf8')).toBe('');
  // fileAtRevision réutilise git() (exec.ts), qui rogne la fin de la sortie : un fichier
  // dont le contenu finit par \n revient sans lui — cosmétique, sans conséquence sur le diff.
  expect(readFileSync(argv[2]!, 'utf8')).toBe('contenu ajouté');
});

test('diff.ouvrir-fichier : hash ou chemin manquant (422), chemin hors du worktree (422)', async () => {
  c = await setupWorkspace({ editor: [FAKE, '{path}'] });
  const { wt, topicId } = await makeTopic(c);
  commitFile(wt, 'a.txt', 'v1\n');
  const hash = sh(wt, 'rev-parse', 'HEAD');
  expect((await postAction(c, topicId, 'diff.ouvrir-fichier', { path: 'a.txt' })).statusCode).toBe(
    422,
  );
  expect((await postAction(c, topicId, 'diff.ouvrir-fichier', { hash })).statusCode).toBe(422);
  expect(
    (await postAction(c, topicId, 'diff.ouvrir-fichier', { hash, path: '../../etc/passwd' }))
      .statusCode,
  ).toBe(422);
});

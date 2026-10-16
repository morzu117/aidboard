import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  defaultEditor,
  editorCommand,
  onPath,
  openInEditor,
} from '../src/daemon/actions/editor.js';
import { waitFor } from './helpers/daemon.js';
import { type Ctx, makeTopic, postAction, setupWorkspace } from './helpers/topics.js';

const FAKE = join(import.meta.dirname, 'fixtures/fake-editor.sh');
const out = join(mkdtempSync(join(tmpdir(), 'aid-ed-')), 'argv.txt');
let c: Ctx;
afterEach(async () => {
  delete process.env.FAKE_EDITOR_OUT;
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

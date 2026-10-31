import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { parseGitStatus, stripUserinfo } from '../src/daemon/remote/git.js';
import type { GitCommitDetail, ServerGitLog, ServerGitStatus } from '../src/shared/git.js';
import type { Server, ServerStatus } from '../src/shared/model.js';
import { FAKE_SSH, startTestDaemon, type TestDaemon } from './helpers/daemon.js';
import { commitFile, makeOriginAndClone, sh } from './helpers/git.js';

let t: TestDaemon | undefined;
afterEach(async () => {
  await t?.d.stop();
  t = undefined;
});

const get = (url: string) => t!.d.app.inject({ method: 'GET', url, headers: t!.headers });
const post = (url: string, payload: Record<string, unknown> = {}) =>
  t!.d.app.inject({ method: 'POST', url, headers: t!.headers, payload });
const q = (p: string) => encodeURIComponent(p);
/** Corps d'une poussée confirmée : la carte porte le commit affiché. */
const oui = (repo: string) => ({ confirm: true, head: sh(repo, 'rev-parse', 'HEAD') });

async function create(body: Record<string, unknown> = {}): Promise<Server> {
  const r = await t!.d.app.inject({
    method: 'POST',
    url: '/api/servers',
    headers: t!.headers,
    payload: {
      name: 'vps-ovh',
      mode: 'ssh_alias',
      target: 'vps',
      workdir: '~/proj',
      allowedDirs: ['~/proj'],
      ...body,
    },
  });
  expect(r.statusCode).toBe(201);
  return r.json<Server>();
}

/** Le « serveur » est la machine de test (faux ssh) : `~/proj` cloné de `~/origin.git`. */
function depot(home: string): { origin: string; clone: string } {
  return makeOriginAndClone(home, { name: 'proj' });
}

/** Un autre poste fait avancer `origin/main` (clone hors des dossiers autorisés). */
function avancerOrigin(home: string, origin: string, name = 'distant.txt', content = 'd\n'): void {
  const other = join(home, 'ailleurs');
  if (existsSync(other)) sh(other, 'pull', '-q', 'origin', 'main');
  else sh(home, 'clone', '-q', origin, other);
  commitFile(other, name, content, `distant ${name}`);
  sh(other, 'push', '-q', 'origin', 'main');
}

const status = async (s: Server, path?: string) =>
  (
    await get(`/api/servers/${s.id}/git/status${path ? `?path=${q(path)}` : ''}`)
  ).json<ServerGitStatus>();

test('F.2 : état du dépôt du workdir — branche, modifiés, avance / retard sur origin, fetch', async () => {
  t = await startTestDaemon();
  const { origin, clone } = depot(t.home);
  const s = await create();
  let st = await status(s);
  expect(st.resolved).toBe(realpathSync(clone));
  expect(st.repos).toEqual([]);
  expect(st.repo).toEqual({
    root: realpathSync(clone),
    branch: 'main',
    head: sh(clone, 'rev-parse', 'HEAD'),
    changes: 0,
    origin: true,
    upstream: 'origin/main',
    aheadBehind: { ahead: 0, behind: 0 },
    operation: null,
  });

  commitFile(clone, 'a.txt', 'a\n');
  writeFileSync(join(clone, 'nouveau.txt'), 'n');
  writeFileSync(join(clone, 'README.md'), 'changé\n');
  avancerOrigin(t.home, origin);
  st = await status(s);
  // pas encore de fetch : le retard n'est pas connu du serveur
  expect(st.repo).toMatchObject({ changes: 2, aheadBehind: { ahead: 1, behind: 0 } });

  const f = await post(`/api/servers/${s.id}/git/fetch`);
  expect(f.statusCode).toBe(200);
  expect(f.json<ServerGitStatus>().repo).toMatchObject({ aheadBehind: { ahead: 1, behind: 1 } });
  // fetch ne touche ni à la branche ni à l'arbre de travail
  expect(readFileSync(join(clone, 'README.md'), 'utf8')).toBe('changé\n');
  expect(existsSync(join(clone, 'distant.txt'))).toBe(false);
});

test('F.2 : branche jamais poussée, HEAD détachée, dépôt sans origin ni commit', async () => {
  t = await startTestDaemon();
  const { clone } = depot(t.home);
  const s = await create({ allowedDirs: ['~/proj', '~/vide'] });
  sh(clone, 'checkout', '-q', '-b', 'nouvelle');
  commitFile(clone, 'n1.txt', '1\n');
  commitFile(clone, 'n2.txt', '2\n');
  expect((await status(s)).repo).toMatchObject({
    branch: 'nouvelle',
    upstream: null,
    aheadBehind: { ahead: 2, behind: 0 },
  });

  sh(clone, 'checkout', '-q', '--detach');
  expect((await status(s)).repo).toMatchObject({ branch: null, upstream: null });

  mkdirSync(join(t.home, 'vide'));
  sh(join(t.home, 'vide'), 'init', '-q', '-b', 'main');
  expect((await status(s, '~/vide')).repo).toMatchObject({
    branch: 'main',
    head: null,
    origin: false,
    aheadBehind: null,
  });
  const log = (await get(`/api/servers/${s.id}/git/log?path=${q('~/vide')}`)).json<ServerGitLog>();
  expect(log.commits).toEqual([]);
});

test('F.2 : dossier non Git — dépôts détectés dans les dossiers autorisés, masqués et lourds exclus', async () => {
  t = await startTestDaemon();
  const { clone } = depot(t.home);
  const zone = join(t.home, 'zone');
  for (const d of [
    'app1',
    'a/b/app2',
    'node_modules/dep',
    '.password-store',
    'x/y/z/w/profond',
    'rien',
  ]) {
    mkdirSync(join(zone, d), { recursive: true });
    if (d !== 'rien') sh(join(zone, d), 'init', '-q');
  }
  const s = await create({ workdir: '~/zone', allowedDirs: ['~/proj', '~/zone'] });
  const st = await status(s);
  expect(st.repo).toBeNull();
  expect(st.resolved).toBe(realpathSync(zone));
  const z = realpathSync(zone);
  expect(st.repos).toEqual([realpathSync(clone), join(z, 'a/b/app2'), join(z, 'app1')].sort());
  // journal, détail, écritures : refus net hors dépôt
  const log = await get(`/api/servers/${s.id}/git/log`);
  expect(log.statusCode).toBe(409);
  expect(log.json().error).toContain('pas un dépôt Git');
  expect((await post(`/api/servers/${s.id}/git/fetch`)).statusCode).toBe(409);
});

test('F.2 : un dépôt dont la racine sort des dossiers autorisés n’est jamais lu', async () => {
  t = await startTestDaemon();
  depot(t.home);
  mkdirSync(join(t.home, 'proj', 'src'));
  const s = await create({ workdir: '~/proj/src', allowedDirs: ['~/proj/src'] });
  const st = await status(s);
  expect(st.repo).toBeNull();
  const log = await get(`/api/servers/${s.id}/git/log`);
  expect(log.statusCode).toBe(409);
});

test('F.2 : périmètre de F.1 — hors dossiers autorisés et masqués refusés avant git', async () => {
  t = await startTestDaemon();
  depot(t.home);
  mkdirSync(join(t.home, 'proj', '.ssh'));
  mkdirSync(join(t.home, 'dehors'));
  const s = await create();
  expect((await get(`/api/servers/${s.id}/git/status?path=${q('~/dehors')}`)).statusCode).toBe(403);
  expect((await get(`/api/servers/${s.id}/git/log?path=${q('~/proj/.ssh')}`)).statusCode).toBe(403);
  expect((await post(`/api/servers/${s.id}/git/fetch`, { path: '~/dehors' })).statusCode).toBe(403);
  expect((await get(`/api/servers/${s.id}/git/status?path=relatif`)).statusCode).toBe(400);
  expect(
    (await get(`/api/servers/${s.id}/git/status?path=${q('~/proj/README.md')}`)).statusCode,
  ).toBe(400);
  expect((await get(`/api/servers/srv_inconnu/git/status`)).statusCode).toBe(404);
});

test('F.2 : journal — toutes les branches ou la branche seule, commits hors HEAD atténués, WIP', async () => {
  t = await startTestDaemon();
  const { clone } = depot(t.home);
  sh(clone, 'checkout', '-q', '-b', 'autre');
  commitFile(clone, 'autre.txt', 'x\n', 'sur autre');
  const autre = sh(clone, 'rev-parse', 'HEAD');
  sh(clone, 'checkout', '-q', 'main');
  commitFile(clone, 'main.txt', 'y\n', 'sur main');
  const s = await create();

  const all = (await get(`/api/servers/${s.id}/git/log`)).json<ServerGitLog>();
  expect(all.scope).toBe('all');
  expect(all.dirty).toBe(false);
  expect(all.truncated).toBe(false);
  expect(all.live).toEqual({
    aheadBehind: { ahead: 1, behind: 0 },
    rebaseInProgress: false,
    onTopicBranch: true,
    headBranch: 'main',
  });
  const by = new Map(all.commits.map((c) => [c.message, c]));
  expect([...by.keys()].sort()).toEqual(['initial', 'sur autre', 'sur main']);
  expect(by.get('sur autre')).toMatchObject({ hash: autre, inHead: false, refs: ['autre'] });
  expect(by.get('sur main')!.inHead).toBe(true);
  expect(by.get('sur main')!.refs).toContain('HEAD -> main');
  expect(by.get('initial')).toMatchObject({ inHead: true, author: 'test' });
  expect(by.get('initial')!.refs).toContain('origin/main');
  expect(by.get('sur main')!.parents).toEqual([by.get('initial')!.hash]);

  writeFileSync(join(clone, 'wip.txt'), 'w');
  const branch = (await get(`/api/servers/${s.id}/git/log?scope=branch`)).json<ServerGitLog>();
  expect(branch.scope).toBe('branch');
  expect(branch.dirty).toBe(true);
  expect(branch.commits.map((c) => c.message)).toEqual(['sur main', 'initial']);
  expect(branch.commits.every((c) => c.inHead)).toBe(true);
  expect((await get(`/api/servers/${s.id}/git/log?scope=tout`)).statusCode).toBe(400);
});

test('F.2 : détail d’un commit — fichiers et compteurs, premier commit, hash inconnu ou invalide', async () => {
  t = await startTestDaemon();
  const { clone } = depot(t.home);
  commitFile(clone, 'a.txt', 'un\ndeux\n');
  commitFile(clone, 'b.txt', 'b\n');
  writeFileSync(join(clone, 'a.txt'), 'un\n3\n4\n');
  sh(clone, 'rm', '-q', 'b.txt');
  writeFileSync(join(clone, 'mon fichier.bin'), Buffer.from([0, 1, 2]));
  // noms des anciennes sentinelles du script : jamais pris pour une section
  writeFileSync(join(clone, 'fin'), 'f\n');
  writeFileSync(join(clone, 'inhead'), 'i\n');
  writeFileSync(join(clone, 'numstat'), 'n\n');
  sh(clone, 'add', '-A');
  sh(clone, 'commit', '-q', '-m', 'mélange', '-m', 'corps du message');
  const head = sh(clone, 'rev-parse', 'HEAD');
  const s = await create();

  const d = (await get(`/api/servers/${s.id}/git/commits/${head}`)).json<GitCommitDetail>();
  expect(d).toMatchObject({
    hash: head,
    message: 'mélange',
    body: 'corps du message',
    inHead: true,
  });
  expect(d.refs).toContain('HEAD -> main');
  const files = new Map(d.files.map((f) => [f.path, f]));
  expect(files.get('a.txt')).toEqual({ path: 'a.txt', status: 'M', additions: 2, deletions: 1 });
  expect(files.get('b.txt')).toEqual({ path: 'b.txt', status: 'D', additions: 0, deletions: 1 });
  expect(files.get('mon fichier.bin')).toEqual({
    path: 'mon fichier.bin',
    status: 'A',
    additions: null,
    deletions: null,
  });

  for (const name of ['fin', 'inhead', 'numstat'])
    expect(files.get(name)).toEqual({ path: name, status: 'A', additions: 1, deletions: 0 });
  expect(d.files).toHaveLength(6);

  const initial = sh(clone, 'rev-list', '--max-parents=0', 'HEAD');
  const root = (
    await get(`/api/servers/${s.id}/git/commits/${initial.slice(0, 10)}`)
  ).json<GitCommitDetail>();
  expect(root).toMatchObject({ hash: initial, parents: [], message: 'initial' });
  expect(root.files).toEqual([{ path: 'README.md', status: 'A', additions: 1, deletions: 0 }]);

  expect((await get(`/api/servers/${s.id}/git/commits/${'0'.repeat(40)}`)).statusCode).toBe(404);
  for (const bad of ['--output=x', 'HEAD', 'main', '1234;touch pwned'])
    expect((await get(`/api/servers/${s.id}/git/commits/${q(bad)}`)).statusCode).toBe(400);
  expect(existsSync(join(clone, 'pwned'))).toBe(false);
  expect(existsSync(join(clone, 'x'))).toBe(false);
});

test('F.2 : pousser — confirmation exigée, refusé sans avance (D33), jamais de force ni de -u', async () => {
  t = await startTestDaemon();
  const { origin, clone } = depot(t.home);
  const s = await create();
  const url = `/api/servers/${s.id}/git/push`;

  expect((await post(url)).statusCode).toBe(400);
  const rien = await post(url, oui(clone));
  expect(rien.statusCode).toBe(422);
  expect(rien.json().error).toContain('rien à pousser');

  commitFile(clone, 'a.txt', 'a\n');
  const before = sh(origin, 'rev-parse', 'main');
  const nope = await post(url, { confirm: false });
  expect(nope.statusCode).toBe(400);
  expect(sh(origin, 'rev-parse', 'main')).toBe(before);

  const ok = await post(url, oui(clone));
  expect(ok.statusCode).toBe(200);
  expect(sh(origin, 'rev-parse', 'main')).toBe(sh(clone, 'rev-parse', 'HEAD'));
  expect(ok.json<ServerGitStatus>().repo).toMatchObject({ aheadBehind: { ahead: 0, behind: 0 } });

  // branche jamais poussée : créée sur origin, configuration du dépôt inchangée
  const config = readFileSync(join(clone, '.git', 'config'), 'utf8');
  sh(clone, 'checkout', '-q', '-b', 'nouvelle');
  commitFile(clone, 'n.txt', 'n\n');
  const neuve = await post(url, oui(clone));
  expect(neuve.statusCode).toBe(200);
  expect(sh(origin, 'rev-parse', 'nouvelle')).toBe(sh(clone, 'rev-parse', 'HEAD'));
  expect(readFileSync(join(clone, '.git', 'config'), 'utf8')).toBe(config);
  expect(neuve.json<ServerGitStatus>().repo).toMatchObject({
    upstream: 'origin/nouvelle',
    aheadBehind: { ahead: 0, behind: 0 },
  });
});

test('F.2 : la confirmation porte sur le commit affiché — HEAD a bougé, refus', async () => {
  t = await startTestDaemon();
  const { origin, clone } = depot(t.home);
  const s = await create();
  commitFile(clone, 'a.txt', 'a\n');
  const affiche = oui(clone);
  commitFile(clone, 'b.txt', 'b\n');
  const before = sh(origin, 'rev-parse', 'main');
  for (const op of ['push', 'sync']) {
    const r = await post(`/api/servers/${s.id}/git/${op}`, affiche);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain('a changé depuis l’affichage');
    const sansHead = await post(`/api/servers/${s.id}/git/${op}`, { confirm: true });
    expect(sansHead.statusCode).toBe(400);
    const court = await post(`/api/servers/${s.id}/git/${op}`, { confirm: true, head: 'abcd' });
    expect(court.statusCode).toBe(400);
  }
  expect(sh(origin, 'rev-parse', 'main')).toBe(before);
});

test('F.2 : branche et tag du même nom — jamais de branche parasite `heads/…`', async () => {
  t = await startTestDaemon();
  const { origin, clone } = depot(t.home);
  sh(clone, 'tag', 'main');
  const s = await create();
  expect((await status(s)).repo).toMatchObject({ branch: 'main', upstream: 'origin/main' });
  commitFile(clone, 'a.txt', 'a\n');
  expect((await post(`/api/servers/${s.id}/git/push`, oui(clone))).statusCode).toBe(200);
  expect(sh(origin, 'rev-parse', 'refs/heads/main')).toBe(sh(clone, 'rev-parse', 'HEAD'));
  expect(sh(origin, 'for-each-ref', '--format=%(refname)', 'refs/heads/')).toBe('refs/heads/main');
});

test('F.2 : poussée refusée par un hook — message de git, sans identifiants', async () => {
  t = await startTestDaemon();
  const { clone } = depot(t.home);
  const hook = join(clone, '.git', 'hooks', 'pre-push');
  writeFileSync(
    hook,
    "#!/bin/sh\necho 'remote: refusé par https://moi:p@ss@h.example/x.git' >&2\nexit 1\n",
  );
  chmodSync(hook, 0o755);
  commitFile(clone, 'a.txt', 'a\n');
  const s = await create();
  const r = await post(`/api/servers/${s.id}/git/push`, oui(clone));
  expect(r.statusCode).toBe(502);
  expect(r.json().error).toMatch(/^poussée impossible : /);
  expect(r.json().error).not.toBe('poussée impossible : Done');
  expect(r.body).not.toContain('p@ss');
  expect(r.body).not.toContain('moi:');
});

test('F.2 : pousser quand origin a avancé — refus, rien de forcé', async () => {
  t = await startTestDaemon();
  const { origin, clone } = depot(t.home);
  const s = await create();
  avancerOrigin(t.home, origin);
  const distant = sh(origin, 'rev-parse', 'main');
  commitFile(clone, 'local.txt', 'l\n');
  const r = await post(`/api/servers/${s.id}/git/push`, oui(clone));
  expect(r.statusCode).toBe(409);
  expect(r.json().error).toContain('Synchroniser d’abord');
  expect(sh(origin, 'rev-parse', 'main')).toBe(distant);
});

test('F.2 : HEAD détachée, opération en cours, pas d’origin — refus avant tout push', async () => {
  t = await startTestDaemon();
  const { clone } = depot(t.home);
  const s = await create();
  const url = `/api/servers/${s.id}/git/push`;
  commitFile(clone, 'a.txt', 'a\n');
  sh(clone, 'checkout', '-q', '--detach');
  expect((await post(url, oui(clone))).json().error).toContain('HEAD détachée');
  sh(clone, 'checkout', '-q', 'main');
  writeFileSync(join(clone, '.git', 'MERGE_HEAD'), sh(clone, 'rev-parse', 'HEAD'));
  const merge = await post(url, oui(clone));
  expect(merge.statusCode).toBe(409);
  expect(merge.json().error).toContain('merge en cours');
  expect((await status(s)).repo!.operation).toBe('merge');
  rmSync(join(clone, '.git', 'MERGE_HEAD'));
  sh(clone, 'remote', 'remove', 'origin');
  const sans = await post(url, oui(clone));
  expect(sans.statusCode).toBe(409);
  expect(sans.json().error).toContain('pas de remote origin');
});

test('F.2 : synchroniser — fetch, rebase sur origin, poussée ; linéaire, sans force', async () => {
  t = await startTestDaemon();
  const { origin, clone } = depot(t.home);
  const s = await create();
  const url = `/api/servers/${s.id}/git/sync`;
  expect((await post(url)).statusCode).toBe(400);
  expect((await post(url, oui(clone))).statusCode).toBe(422);

  avancerOrigin(t.home, origin);
  commitFile(clone, 'local.txt', 'l\n');
  writeFileSync(join(clone, 'non-suivi.txt'), 'gardé');
  const r = await post(url, oui(clone));
  expect(r.statusCode).toBe(200);
  expect(r.json<ServerGitStatus>().repo).toMatchObject({
    aheadBehind: { ahead: 0, behind: 0 },
    operation: null,
  });
  expect(sh(origin, 'rev-parse', 'main')).toBe(sh(clone, 'rev-parse', 'HEAD'));
  expect(sh(clone, 'log', '--format=%s', '-3').split('\n')).toEqual([
    'ajout local.txt',
    'distant distant.txt',
    'initial',
  ]);
  expect(readFileSync(join(clone, 'non-suivi.txt'), 'utf8')).toBe('gardé');
});

test('F.2 : synchroniser — conflit annulé, modifications suivies refusées, rien ne change', async () => {
  t = await startTestDaemon();
  const { origin, clone } = depot(t.home);
  const s = await create();
  const url = `/api/servers/${s.id}/git/sync`;
  avancerOrigin(t.home, origin, 'README.md', 'distant\n');
  const distant = sh(origin, 'rev-parse', 'main');
  commitFile(clone, 'README.md', 'local\n');
  const head = sh(clone, 'rev-parse', 'HEAD');

  const conflit = await post(url, oui(clone));
  expect(conflit.statusCode).toBe(409);
  expect(conflit.json().error).toContain('conflit avec origin/main (README.md)');
  expect(sh(clone, 'rev-parse', 'HEAD')).toBe(head);
  expect(existsSync(join(clone, '.git', 'rebase-merge'))).toBe(false);
  expect(readFileSync(join(clone, 'README.md'), 'utf8')).toBe('local\n');
  expect(sh(origin, 'rev-parse', 'main')).toBe(distant);
  expect((await status(s)).repo!.operation).toBeNull();

  writeFileSync(join(clone, 'README.md'), 'en cours\n');
  const sale = await post(url, oui(clone));
  expect(sale.statusCode).toBe(409);
  expect(sale.json().error).toContain('modifications suivies non commitées');
  expect(sh(clone, 'rev-parse', 'HEAD')).toBe(head);
  expect(readFileSync(join(clone, 'README.md'), 'utf8')).toBe('en cours\n');
});

test('F.2 : synchroniser — modifications seulement indexées, rebase en échec hors conflit', async () => {
  t = await startTestDaemon();
  const { origin, clone } = depot(t.home);
  const s = await create();
  const url = `/api/servers/${s.id}/git/sync`;
  avancerOrigin(t.home, origin, 'arrive.txt', 'distant\n');
  commitFile(clone, 'local.txt', 'l\n');
  const head = sh(clone, 'rev-parse', 'HEAD');

  writeFileSync(join(clone, 'README.md'), 'indexé\n');
  sh(clone, 'add', 'README.md');
  const indexe = await post(url, oui(clone));
  expect(indexe.statusCode).toBe(409);
  expect(indexe.json().error).toContain('modifications suivies non commitées');
  sh(clone, 'reset', '-q', '--hard');

  // un non-suivi du nom d'un fichier arrivé d'origin : le rebase refuse de l'écraser
  writeFileSync(join(clone, 'arrive.txt'), 'à moi\n');
  const bloque = await post(url, oui(clone));
  expect(bloque.statusCode).toBe(502);
  expect(bloque.json().error).toMatch(/^rebase impossible : /);
  expect(sh(clone, 'rev-parse', 'HEAD')).toBe(head);
  expect(existsSync(join(clone, '.git', 'rebase-merge'))).toBe(false);
  expect(existsSync(join(clone, '.git', 'rebase-apply'))).toBe(false);
  expect(readFileSync(join(clone, 'arrive.txt'), 'utf8')).toBe('à moi\n');
});

test('F.2 : enregistrements forgés — racine hors du dossier autorisé, refus du daemon', () => {
  const server = { id: 'srv_x' } as Server;
  const forge = (recs: string[]) => ({
    code: 0,
    stdout: ['', 'aid-fs', ...recs, ''].join('\0'),
    stderr: '',
    durationMs: 1,
    timedOut: false,
    truncated: false,
  });
  const kv = ['fait', 'br\tmain', 'hd\t', 'og\t', 'up\t', 'ab\t', 'op\t', 'ch\t0'];
  expect(() =>
    parseGitStatus(server, '~/p', forge(['ok', '/srv/p', '/srv/p', 'depot', '/srv', ...kv])),
  ).toThrow('hors des dossiers autorisés');
  expect(() =>
    parseGitStatus(server, '~/p', forge(['ok', '/srv/p', '/srv/p', 'depot', '/srv/autre', ...kv])),
  ).toThrow('hors des dossiers autorisés');
  expect(() =>
    parseGitStatus(
      server,
      '~/p',
      forge(['ok', '/srv/p/.ssh', '/srv/p', 'depot', '/srv/p/.ssh', ...kv]),
    ),
  ).toThrow();
  expect(
    parseGitStatus(server, '~/p', forge(['ok', '/srv/p/a', '/srv/p', 'depot', '/srv/p', ...kv]))
      .repo,
  ).toMatchObject({ root: '/srv/p', branch: 'main', head: null, aheadBehind: null });
  // candidats : sous la base et hors dossier masqué seulement
  const cands = parseGitStatus(
    server,
    '~/p',
    forge([
      'ok',
      '/srv/p',
      '/srv/p',
      'pasgit',
      'cand\t/srv/p\t/srv/p/app',
      'cand\t/srv/p\t/srv/autre',
      'cand\t/srv/p\t/srv/p/.password-store',
      'cand\t/srv/p\t/srv/p/a\tb',
    ]),
  );
  expect(cands.repos).toEqual(['/srv/p/a\tb', '/srv/p/app']);
});

test('F.2 : une écriture Git à la fois par serveur', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aid-d-'));
  t = await startTestDaemon(home, {
    remote: { ssh: FAKE_SSH, env: { ...process.env, FAKE_SSH_HOME: home, FAKE_SSH_DELAY: '1' } },
  });
  depot(home);
  const s = await create();
  const [a, b] = await Promise.all([
    post(`/api/servers/${s.id}/git/fetch`),
    post(`/api/servers/${s.id}/git/fetch`),
  ]);
  expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
  expect((await post(`/api/servers/${s.id}/git/fetch`)).statusCode).toBe(200);
});

test('F.2 : variables GIT_* héritées du profil ignorées', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aid-d-'));
  t = await startTestDaemon(home, {
    remote: {
      ssh: FAKE_SSH,
      env: { ...process.env, FAKE_SSH_HOME: home, GIT_DIR: '/nulle/part', GIT_WORK_TREE: '/' },
    },
  });
  const { clone } = depot(home);
  const s = await create();
  expect((await status(s)).repo).toMatchObject({ root: realpathSync(clone), branch: 'main' });
});

test('F.2 : identifiants d’URL jamais renvoyés, serveur injoignable', async () => {
  t = await startTestDaemon();
  const { clone } = depot(t.home);
  sh(clone, 'remote', 'set-url', 'origin', 'https://moi:jeton-secret@127.0.0.1:9/x.git');
  const s = await create();
  const st = await get(`/api/servers/${s.id}/git/status`);
  expect(st.body).not.toContain('jeton-secret');
  const f = await post(`/api/servers/${s.id}/git/fetch`);
  expect(f.statusCode).toBe(502);
  expect(f.json().error).toMatch(/^fetch impossible : /);
  expect(f.body).not.toContain('jeton-secret');

  expect(stripUserinfo("fatal: unable to access 'https://moi:jeton@h.example/r.git/'")).toBe(
    "fatal: unable to access 'https://h.example/r.git/'",
  );
  expect(stripUserinfo('ssh://git@h.example:22/r.git et https://h.example/x')).toBe(
    'ssh://h.example:22/r.git et https://h.example/x',
  );
  expect(stripUserinfo('https://moi:p@ss@h.example/r.git')).toBe('https://h.example/r.git');
});

test('F.2 : serveur injoignable pendant une écriture — 502 et état injoignable', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aid-d-'));
  t = await startTestDaemon(home, {
    remote: { ssh: FAKE_SSH, env: { ...process.env, FAKE_SSH_HOME: home, FAKE_SSH_FAIL: '1' } },
  });
  const s = await create();
  const r = await post(`/api/servers/${s.id}/git/push`, { confirm: true, head: 'a'.repeat(40) });
  expect(r.statusCode).toBe(502);
  expect(r.json().error).toContain('vps-ovh ne répond pas');
  const statuses = (await get('/api/servers/status')).json<ServerStatus[]>();
  expect(statuses.find((x) => x.serverId === s.id)?.state).toBe('unreachable');
});

/**
 * Review complète : un `git` du serveur qui fait une action de plus avant la vraie commande — un agent qui
 * commite pendant le fetch, une annulation de rebase qui échoue. Posé par le profil distant, devant le PATH.
 */
async function avecGitDuServeur(script: string): Promise<{ home: string }> {
  const home = mkdtempSync(join(tmpdir(), 'aid-d-'));
  const bin = join(home, 'faux-bin');
  mkdirSync(bin);
  const vrai = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nVRAI='${vrai}'\n${script}\nexec "$VRAI" "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  writeFileSync(join(home, '.profile'), `PATH='${bin}':"$PATH"\nexport PATH\n`);
  t = await startTestDaemon(home, {
    remote: { ssh: FAKE_SSH, env: { ...process.env, FAKE_SSH_HOME: home } },
  });
  return { home };
}

const COMMIT_PENDANT_FETCH = `case " $* " in *" fetch "*) "$VRAI" -c user.name=agent -c user.email=agent@x commit -q --allow-empty -m "agent pendant le fetch" ;; esac`;

test('review complète : pousser envoie le commit confirmé, pas un commit arrivé pendant l’écriture', async () => {
  const { home } = await avecGitDuServeur(COMMIT_PENDANT_FETCH);
  const { origin, clone } = depot(home);
  const s = await create();
  commitFile(clone, 'local.txt', 'l\n');
  const confirme = sh(clone, 'rev-parse', 'HEAD');
  const r = await post(`/api/servers/${s.id}/git/sync`, oui(clone));
  expect(r.statusCode).toBe(200);
  // l'agent a commité pendant le fetch : origin reçoit le commit confirmé, rien de plus
  expect(sh(origin, 'rev-parse', 'main')).toBe(confirme);
  expect(sh(clone, 'log', '-1', '--format=%s')).toBe('agent pendant le fetch');
});

test('review complète : synchroniser — HEAD a bougé pendant le fetch, rebase refusé, rien ne change', async () => {
  const { home } = await avecGitDuServeur(COMMIT_PENDANT_FETCH);
  const { origin, clone } = depot(home);
  const s = await create();
  avancerOrigin(home, origin);
  const distant = sh(origin, 'rev-parse', 'main');
  commitFile(clone, 'local.txt', 'l\n');
  const r = await post(`/api/servers/${s.id}/git/sync`, oui(clone));
  expect(r.statusCode).toBe(409);
  expect(r.json().error).toContain('a changé depuis l’affichage');
  expect(sh(origin, 'rev-parse', 'main')).toBe(distant);
  expect(sh(clone, 'log', '-1', '--format=%s')).toBe('agent pendant le fetch');
});

test('review complète : synchroniser — annulation du rebase en échec, dit tel quel', async () => {
  const { home } = await avecGitDuServeur(`case " $* " in *" rebase --abort "*) exit 1 ;; esac`);
  const { origin, clone } = depot(home);
  const s = await create();
  avancerOrigin(home, origin, 'README.md', 'distant\n');
  commitFile(clone, 'README.md', 'local\n');
  const r = await post(`/api/servers/${s.id}/git/sync`, oui(clone));
  expect(r.statusCode).toBe(409);
  expect(r.json().error).toBe(
    'rebase en échec et non annulé sur le serveur : à terminer sur place',
  );
});

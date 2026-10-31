import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  ENTRIES_MAX,
  HIDDEN_CASE,
  HIDDEN_PAIR_CASE,
  HIDDEN_PATTERNS,
  isHidden,
  parsePreview,
  PREVIEW_MAX,
  readCommand,
} from '../src/daemon/remote/files.js';
import { type ExecResult, remoteExec } from '../src/daemon/remote/transport.js';
import type {
  Server,
  ServerFilePreview,
  ServerFsListing,
  ServerStatus,
} from '../src/shared/model.js';
import { FAKE_SSH, startTestDaemon, type TestDaemon } from './helpers/daemon.js';

let t: TestDaemon | undefined;
afterEach(async () => {
  await t?.d.stop();
  t = undefined;
});

const get = (url: string) => t!.d.app.inject({ method: 'GET', url, headers: t!.headers });
const q = (p: string) => encodeURIComponent(p);

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

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, stdio: 'ignore' },
  );
}

/** Le « serveur » est la machine de test (faux ssh, HOME = AID_HOME temporaire) : un dépôt `~/proj`. */
function projet(home: string): string {
  const p = join(home, 'proj');
  mkdirSync(join(p, 'src'), { recursive: true });
  mkdirSync(join(p, 'node_modules', 'x'), { recursive: true });
  mkdirSync(join(p, '.ssh'));
  mkdirSync(join(home, 'dehors'));
  writeFileSync(join(home, 'dehors', 'note.txt'), 'hors périmètre');
  writeFileSync(join(p, 'README.md'), '# Projet\n');
  writeFileSync(join(p, 'src', 'index.ts'), 'export {};\n');
  writeFileSync(join(p, 'ancien.txt'), 'renommé\n');
  writeFileSync(join(p, '.env'), 'TOKEN=ne-doit-jamais-sortir');
  writeFileSync(join(p, 'id_ed25519'), 'clé');
  writeFileSync(join(p, '.ssh', 'config'), 'Host x');
  writeFileSync(join(p, '.gitignore'), 'node_modules\n');
  git(p, 'init', '-q');
  git(p, 'add', 'README.md', 'src', 'ancien.txt', '.gitignore');
  git(p, 'commit', '-q', '-m', 'init');
  writeFileSync(join(p, 'src', 'index.ts'), 'export const x = 1;\n');
  git(p, 'mv', 'ancien.txt', 'nouveau.txt');
  writeFileSync(join(p, 'mon fichier.txt'), 'espaces\n');
  mkdirSync(join(p, 'brouillons'));
  writeFileSync(join(p, 'brouillons', 'a.md'), 'a');
  writeFileSync(join(p, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x47]));
  writeFileSync(join(p, 'gros.log'), 'x'.repeat(PREVIEW_MAX + 1000));
  symlinkSync(join(home, 'dehors'), join(p, 'sortie'));
  symlinkSync('.env', join(p, 'lien'));
  return p;
}

test('F.1 : un niveau du workdir, trié, badges git, masqués et grisés (D78)', async () => {
  t = await startTestDaemon();
  const p = projet(t.home);
  const s = await create();
  const r = await get(`/api/servers/${s.id}/fs`);
  expect(r.statusCode).toBe(200);
  const l = r.json<ServerFsListing>();
  expect(l.path).toBe('~/proj');
  expect(l.resolved).toBe(realpathSync(p));
  expect(l.git).toBe(true);
  expect(l.truncated).toBe(false);
  const by = new Map(l.entries.map((e) => [e.name, e]));
  // dossiers d'abord ; un niveau seulement : rien de `src/` ni de `node_modules/`
  const kinds = l.entries.map((e) => e.kind);
  expect(kinds.lastIndexOf('dir')).toBeLessThan(kinds.indexOf('file'));
  expect(l.entries.some((e) => e.name.includes('/'))).toBe(false);
  expect(by.get('src')).toMatchObject({ kind: 'dir', git: 'M', heavy: false, hidden: false });
  expect(by.get('node_modules')).toMatchObject({ kind: 'dir', heavy: true, git: null });
  expect(by.get('brouillons')).toMatchObject({ kind: 'dir', git: '?' });
  expect(by.get('README.md')).toMatchObject({ kind: 'file', git: null });
  expect(by.get('mon fichier.txt')).toMatchObject({ kind: 'file', git: '?' });
  // renommage : le nouveau nom porte le badge, l'ancien chemin n'est pas une entrée
  expect(by.get('nouveau.txt')).toMatchObject({ git: 'M' });
  expect(by.has('ancien.txt')).toBe(false);
  expect(by.get('.env')).toMatchObject({ hidden: true });
  expect(by.get('id_ed25519')).toMatchObject({ hidden: true });
  expect(by.get('.ssh')).toMatchObject({ kind: 'dir', hidden: true });
  expect(by.get('sortie')).toMatchObject({ kind: 'dir', symlink: true });
  expect(by.get('lien')).toMatchObject({ kind: 'file', symlink: true, hidden: false });
});

test('F.1 : dossier entièrement non suivi, sous-dossier, dossier hors dépôt', async () => {
  t = await startTestDaemon();
  projet(t.home);
  const s = await create({ allowedDirs: ['~/proj', '~/dehors'] });
  const brouillons = (
    await get(`/api/servers/${s.id}/fs?path=${q('~/proj/brouillons')}`)
  ).json<ServerFsListing>();
  expect(brouillons.entries).toEqual([expect.objectContaining({ name: 'a.md', git: '?' })]);
  const src = (
    await get(`/api/servers/${s.id}/fs?path=${q('~/proj/src/')}`)
  ).json<ServerFsListing>();
  expect(src.entries).toEqual([expect.objectContaining({ name: 'index.ts', git: 'M' })]);
  const dehors = (
    await get(`/api/servers/${s.id}/fs?path=${q('~/dehors')}`)
  ).json<ServerFsListing>();
  expect(dehors.git).toBe(false);
  expect(dehors.entries).toEqual([expect.objectContaining({ name: 'note.txt', git: null })]);
});

test('F.1 : 403 hors des dossiers autorisés, symlinks et `..` compris', async () => {
  t = await startTestDaemon();
  projet(t.home);
  const s = await create();
  for (const path of ['~', '~/dehors', '/', '~/proj/sortie', '~/proj/../dehors']) {
    const r = await get(`/api/servers/${s.id}/fs?path=${q(path)}`);
    expect(r.statusCode, path).toBe(403);
    expect(r.json<{ error: string }>().error).toMatch(/hors des dossiers autorisés/);
  }
  const f = await get(`/api/servers/${s.id}/file?path=${q('~/proj/sortie/note.txt')}`);
  expect(f.statusCode).toBe(403);
  expect(f.body).not.toContain('hors périmètre');
});

test('F.1 : un fichier masqué n’est jamais lu, même derrière un lien', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aid-d-'));
  const log = join(home, 'ssh.log');
  t = await startTestDaemon(home, {
    remote: { ssh: FAKE_SSH, env: { ...process.env, FAKE_SSH_HOME: home, FAKE_SSH_LOG: log } },
  });
  projet(t.home);
  const s = await create();
  writeFileSync(log, '');
  // sans casse : sur un système de fichiers insensible (macOS), `.ENV` est `.env` (review F.1)
  const masques = ['~/proj/.env', '~/proj/id_ed25519', '~/proj/.ssh/config', '~/proj/.ENV'];
  for (const path of [...masques, '~/proj/ID_ED25519', '~/proj/.SSH/config']) {
    const r = await get(`/api/servers/${s.id}/file?path=${q(path)}`);
    expect(r.statusCode, path).toBe(403);
    expect(r.json<{ error: string }>().error).toMatch(/masqué/);
  }
  expect((await get(`/api/servers/${s.id}/fs?path=${q('~/proj/.ssh')}`)).statusCode).toBe(403);
  // refusés sur le nom, avant tout aller-retour
  expect(readFileSync(log, 'utf8')).toBe('');
  const lien = await get(`/api/servers/${s.id}/file?path=${q('~/proj/lien')}`);
  expect(lien.statusCode).toBe(403);
  expect(lien.body).not.toContain('ne-doit-jamais-sortir');
  // témoin : le journal du faux ssh est bien écrit quand un aller-retour a lieu
  expect(readFileSync(log, 'utf8')).toContain('realpath');
});

test('F.1 : nom masqué en majuscules résolu derrière un lien', async () => {
  t = await startTestDaemon();
  const p = projet(t.home);
  writeFileSync(join(p, 'ID_PROD'), 'clé de prod');
  symlinkSync('ID_PROD', join(p, 'alias'));
  const s = await create();
  const r = await get(`/api/servers/${s.id}/file?path=${q('~/proj/alias')}`);
  expect(r.statusCode).toBe(403);
  expect(r.body).not.toContain('clé de prod');
  const l = (await get(`/api/servers/${s.id}/fs`)).json<ServerFsListing>();
  expect(l.entries.find((e) => e.name === 'ID_PROD')?.hidden).toBe(true);
});

test('secrets : règle immuable, liste élargie (jetons, identifiants, .git/config)', async () => {
  t = await startTestDaemon();
  const p = projet(t.home);
  mkdirSync(join(p, '.aws'));
  writeFileSync(join(p, '.aws', 'credentials'), 'aws_secret_access_key=XYZ');
  writeFileSync(join(p, '.npmrc'), '//registry.npmjs.org/:_authToken=XYZ');
  writeFileSync(join(p, '.NETRC'), 'machine x password XYZ');
  writeFileSync(join(p, 'client_secret.json'), '{"k":"XYZ"}');
  mkdirSync(join(p, 'conf', 'gh'), { recursive: true });
  writeFileSync(join(p, 'conf', 'gh', 'hosts.yml'), 'oauth_token: XYZ');
  writeFileSync(join(p, 'conf', 'config'), 'ordinaire');
  git(p, 'remote', 'add', 'origin', 'https://jeton-XYZ@github.com/o/r.git');
  // `.git` autorisé lui-même : son `config` reste masqué
  const s = await create({ allowedDirs: ['~/proj', '~/proj/.git'] });
  for (const path of [
    '~/proj/.aws/credentials',
    '~/proj/.npmrc',
    '~/proj/.NETRC',
    '~/proj/client_secret.json',
    '~/proj/conf/gh/hosts.yml',
    '~/proj/.git/config',
    '~/proj/.git/CONFIG',
  ]) {
    const r = await get(`/api/servers/${s.id}/file?path=${q(path)}`);
    expect(r.statusCode, path).toBe(403);
    expect(r.json<{ error: string }>().error, path).toMatch(/masqué/);
    expect(r.body, path).not.toContain('XYZ');
  }
  expect((await get(`/api/servers/${s.id}/fs?path=${q('~/proj/.aws')}`)).statusCode).toBe(403);
  // un `config` ordinaire reste lisible ; la liste de `.git` signale le sien « masqué »
  const conf = await get(`/api/servers/${s.id}/file?path=${q('~/proj/conf/config')}`);
  expect(conf.json<ServerFilePreview>().content).toBe('ordinaire');
  const g = (await get(`/api/servers/${s.id}/fs?path=${q('~/proj/.git')}`)).json<ServerFsListing>();
  expect(g.entries.find((e) => e.name === 'config')?.hidden).toBe(true);
  expect(g.entries.find((e) => e.name === 'HEAD')?.hidden).toBe(false);
  // un lien vers le `config` de `.git` est refusé sur le chemin résolu
  symlinkSync('.git/config', join(p, 'lien-config'));
  const lien = await get(`/api/servers/${s.id}/file?path=${q('~/proj/lien-config')}`);
  expect(lien.statusCode).toBe(403);
  expect(lien.body).not.toContain('XYZ');
  // le script refuse lui-même, sur le serveur : le contenu ne traverse jamais ssh (le daemon revérifie ensuite)
  writeFileSync(join(p, 'ID_PROD'), 'XYZ');
  symlinkSync('ID_PROD', join(p, 'alias-maj'));
  for (const path of ['~/proj/lien-config', '~/proj/alias-maj', '~/proj/lien']) {
    const r = await remoteExec(s, readCommand(s, path), {
      ssh: FAKE_SSH,
      env: { ...process.env, FAKE_SSH_HOME: t.home },
    });
    expect(r.stdout, path).toContain('masque');
    expect(r.stdout, path).not.toMatch(/XYZ|ne-doit-jamais-sortir/);
  }
  const l = (await get(`/api/servers/${s.id}/fs`)).json<ServerFsListing>();
  for (const n of ['.aws', '.npmrc', '.NETRC', 'client_secret.json'])
    expect(l.entries.find((e) => e.name === n)?.hidden, n).toBe(true);
});

test('secrets : le `case` du script et la regex du daemon disent la même chose', () => {
  // un exemple par motif, en casse mêlée ; `*` remplacé par un fragment ordinaire
  const sample = (p: string) => p.replace(/\*/g, 'Ab').replace(/[a-z]/, (c) => c.toUpperCase());
  const names = HIDDEN_PATTERNS.filter((p) => !p.includes('/')).map(sample);
  const pairs = HIDDEN_PATTERNS.filter((p) => p.includes('/')).map(sample);
  const ordinaires = [
    'README.md',
    'PasswordInput.tsx',
    'credentials.ts',
    'forgot-password.html',
    'secrets.py',
    'tokens.json',
    'tokenizer.py',
    'config',
    'package.json',
    'main.rs',
  ];
  const ordinairesPaires = ['src/config', 'conf/hosts.yml', 'gh/config.yml', '.github/hosts.yml'];
  const run = (pattern: string, args: string[]) =>
    execFileSync(
      'sh',
      [
        '-c',
        `for n in "$@"; do case "$n" in ${pattern}) echo y ;; *) echo n ;; esac; done`,
        'sh',
        ...args,
      ],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n');
  const shNames = run(HIDDEN_CASE, [...names, ...ordinaires]);
  [...names, ...ordinaires].forEach((n, i) =>
    expect([n, shNames[i]], n).toEqual([n, isHidden(n) ? 'y' : 'n']),
  );
  expect(names.every((n) => isHidden(n))).toBe(true);
  expect(ordinaires.filter((n) => isHidden(n))).toEqual([]);
  const shPairs = run(HIDDEN_PAIR_CASE, [...pairs, ...ordinairesPaires]);
  [...pairs, ...ordinairesPaires].forEach((pp, i) => {
    const [parent = '', name = ''] = pp.split('/');
    expect([pp, shPairs[i]], pp).toEqual([pp, isHidden(name, parent) ? 'y' : 'n']);
  });
  expect(pairs.every((pp) => isHidden(pp.split('/')[1]!, pp.split('/')[0]!))).toBe(true);
});

test('secrets : le daemon revérifie le chemin résolu rendu par le script', () => {
  const s = { id: 'srv_x', allowedDirs: ['~'] } as Server;
  const sortie = (resolved: string, base: string): ExecResult => ({
    code: 0,
    stdout: `\0aid-fs\0ok\0${resolved}\0${base}\0${3}\0${0}\0XYZ`,
    stderr: '',
    durationMs: 1,
    timedOut: false,
    truncated: false,
  });
  // le dernier composant du dossier autorisé sert de parent au premier composant dessous
  for (const [resolved, base] of [
    ['/h/proj/.git/config', '/h/proj'],
    ['/h/proj/.git/config', '/h/proj/.git'],
    ['/h/repo.git/config', '/h'],
    ['/h/proj/.env', '/h/proj'],
  ] as const)
    expect(() => parsePreview(s, '~/x', sortie(resolved, base)), resolved).toThrow(/masqué/);
  // hors du dossier autorisé annoncé : refus, quoi qu'en dise le script
  expect(() => parsePreview(s, '~/x', sortie('/etc/hosts', '/h/proj'))).toThrow(
    /hors des dossiers/,
  );
  // au-dessus du dossier autorisé, un nom « masqué » ne compte pas
  expect(parsePreview(s, '~/x', sortie('/srv/id_app/a.txt', '/srv/id_app')).content).toBe('XYZ');
});

test('secrets : `.`, dépôt nu, dossier `gh` autorisé, faux positifs voulus', async () => {
  t = await startTestDaemon();
  const p = projet(t.home);
  mkdirSync(join(p, 'conf', 'gh'), { recursive: true });
  writeFileSync(join(p, 'conf', 'gh', 'hosts.yml'), 'oauth_token: XYZ');
  mkdirSync(join(p, 'nu.git'));
  writeFileSync(join(p, 'nu.git', 'config'), 'url = https://XYZ@h/r');
  writeFileSync(join(p, 'PasswordInput.tsx'), 'export {};');
  writeFileSync(join(p, 'tokens.json'), '{"couleur":"#fff"}');
  mkdirSync(join(p, 'locales'));
  writeFileSync(join(p, 'locales', 'auth.json'), '{"titre":"Connexion"}');
  const s = await create({ allowedDirs: ['~/proj', '~/proj/conf/gh'] });
  for (const path of [
    '~/proj/.git/./config',
    '~/proj/nu.git/config',
    '~/proj/conf/gh/hosts.yml',
    '~/proj/conf/gh/./hosts.yml',
  ]) {
    const r = await get(`/api/servers/${s.id}/file?path=${q(path)}`);
    expect(r.statusCode, path).toBe(403);
    expect(r.body, path).not.toContain('XYZ');
  }
  for (const path of ['~/proj/PasswordInput.tsx', '~/proj/tokens.json']) {
    const r = await get(`/api/servers/${s.id}/file?path=${q(path)}`);
    expect(r.statusCode, path).toBe(200);
  }
  // compromis assumé : `auth.json` (Composer) masque aussi un fichier de traduction du même nom
  expect(
    (await get(`/api/servers/${s.id}/file?path=${q('~/proj/locales/auth.json')}`)).statusCode,
  ).toBe(403);
});

test('F.1 : aucune injection par le chemin ni par un nom de fichier', async () => {
  t = await startTestDaemon();
  // un nom de fichier ne porte pas de `/` : témoin relatif, cherché partout où la commande a pu tourner
  const dir = join(t.home, "a'b $(touch pwned)");
  const nom = 'c`touch pwned`;d';
  mkdirSync(dir);
  writeFileSync(join(dir, nom), 'ok');
  const temoin = join(t.home, 'pwned-abs');
  const s = await create({ workdir: '~', allowedDirs: ['~'] });
  for (const path of [
    "~/a'b $(touch pwned)",
    `~/a'b $(touch pwned)/${nom}`,
    `~/x'; touch ${temoin}; '`,
    `~/$(touch ${temoin})`,
    '~/-n',
  ]) {
    const fs = await get(`/api/servers/${s.id}/fs?path=${q(path)}`);
    const file = await get(`/api/servers/${s.id}/file?path=${q(path)}`);
    expect([fs.statusCode, file.statusCode], path).not.toContain(502);
  }
  const l = await get(`/api/servers/${s.id}/fs?path=${q("~/a'b $(touch pwned)")}`);
  expect(l.json<ServerFsListing>().entries.map((e) => e.name)).toEqual([nom]);
  const f = await get(`/api/servers/${s.id}/file?path=${q(`~/a'b $(touch pwned)/${nom}`)}`);
  expect(f.json<ServerFilePreview>().content).toBe('ok');
  for (const where of [t.home, dir, process.cwd()])
    expect(existsSync(join(where, 'pwned')), where).toBe(false);
  expect(existsSync(temoin)).toBe(false);
});

test('F.1 : préfixe frère, ancêtre masqué, chemin absent hors périmètre', async () => {
  t = await startTestDaemon();
  projet(t.home);
  mkdirSync(join(t.home, 'proj-old'));
  mkdirSync(join(t.home, 'id_app', 'proj'), { recursive: true });
  writeFileSync(join(t.home, 'id_app', 'proj', 'a.txt'), 'lisible');
  const s = await create({ allowedDirs: ['~/proj', '~/id_app/proj/'] });
  expect((await get(`/api/servers/${s.id}/fs?path=${q('~/proj-old')}`)).statusCode).toBe(403);
  // `id_app` est au-dessus du dossier autorisé : il ne masque pas tout le projet
  const f = await get(`/api/servers/${s.id}/file?path=${q('~/id_app/proj/a.txt')}`);
  expect(f.statusCode).toBe(200);
  expect(f.json<ServerFilePreview>().content).toBe('lisible');
  expect((await get(`/api/servers/${s.id}/fs?path=${q('~/id_app')}`)).statusCode).toBe(403);
  // hors périmètre, la réponse ne dit pas si le chemin existe
  for (const path of ['~/dehors/note.txt', '~/dehors/absent', '/nulle/part']) {
    const r = await get(`/api/servers/${s.id}/file?path=${q(path)}`);
    expect(r.statusCode, path).toBe(403);
  }
  expect((await get(`/api/servers/${s.id}/file?path=${q('~/proj/absent')}`)).statusCode).toBe(404);
});

test('F.1 : permissions refusées, profil bavard, chemin vide, nom à tabulation', async () => {
  t = await startTestDaemon();
  const p = projet(t.home);
  writeFileSync(join(t.home, '.bash_profile'), 'echo "Bienvenue sur vps-ovh"\n');
  writeFileSync(join(p, 'ferme.txt'), 'x');
  chmodSync(join(p, 'ferme.txt'), 0o000);
  mkdirSync(join(p, 'clos'));
  chmodSync(join(p, 'clos'), 0o000);
  writeFileSync(join(p, 'a\tb.txt'), 'tab');
  const s = await create();
  try {
    const l = await get(`/api/servers/${s.id}/fs?path=`);
    expect(l.statusCode).toBe(200);
    expect(l.json<ServerFsListing>().path).toBe('~/proj');
    expect(l.json<ServerFsListing>().entries.map((e) => e.name)).toContain('a\tb.txt');
    const tab = await get(`/api/servers/${s.id}/file?path=${q('~/proj/a\tb.txt')}`);
    expect(tab.json<ServerFilePreview>().content).toBe('tab');
    for (const [url, re] of [
      [`/api/servers/${s.id}/file?path=${q('~/proj/ferme.txt')}`, /permissions/],
      [`/api/servers/${s.id}/fs?path=${q('~/proj/clos')}`, /permissions/],
    ] as const) {
      const r = await get(url);
      expect(r.statusCode, url).toBe(403);
      expect(r.json<{ error: string }>().error).toMatch(re);
    }
  } finally {
    chmodSync(join(p, 'clos'), 0o755);
  }
});

test('F.1 : le fsmonitor du dépôt n’est jamais lancé', async () => {
  t = await startTestDaemon();
  const p = projet(t.home);
  const temoin = join(t.home, 'fsmonitor-lance');
  git(p, 'config', 'core.fsmonitor', `touch ${temoin}; false`);
  const s = await create();
  const r = await get(`/api/servers/${s.id}/fs`);
  expect(r.statusCode).toBe(200);
  expect(r.json<ServerFsListing>().git).toBe(true);
  expect(existsSync(temoin)).toBe(false);
});

test('F.1 : aperçu texte, binaire non transmis, tronqué à 256 Kio', async () => {
  t = await startTestDaemon();
  const p = projet(t.home);
  const s = await create();
  const readme = await get(`/api/servers/${s.id}/file?path=${q('~/proj/README.md')}`);
  expect(readme.statusCode).toBe(200);
  expect(readme.json<ServerFilePreview>()).toMatchObject({
    path: '~/proj/README.md',
    resolved: realpathSync(join(p, 'README.md')),
    size: 9,
    binary: false,
    truncated: false,
    content: '# Projet\n',
  });
  const espaces = await get(`/api/servers/${s.id}/file?path=${q('~/proj/mon fichier.txt')}`);
  expect(espaces.json<ServerFilePreview>().content).toBe('espaces\n');
  const bin = (
    await get(`/api/servers/${s.id}/file?path=${q('~/proj/image.bin')}`)
  ).json<ServerFilePreview>();
  expect(bin).toMatchObject({ binary: true, content: null, size: 4, truncated: false });
  const gros = (
    await get(`/api/servers/${s.id}/file?path=${q('~/proj/gros.log')}`)
  ).json<ServerFilePreview>();
  expect(gros).toMatchObject({ truncated: true, size: PREVIEW_MAX + 1000 });
  expect(gros.content).toHaveLength(PREVIEW_MAX);
});

test('F.1 : chemins invalides, absents, mauvais type', async () => {
  t = await startTestDaemon();
  projet(t.home);
  const s = await create();
  const cases: Array<[string, number]> = [
    [`/api/servers/${s.id}/fs?path=${q('proj')}`, 400],
    [`/api/servers/${s.id}/fs?path=${q('~/proj\nx')}`, 400],
    [`/api/servers/${s.id}/fs?path=${q('~/proj/absent')}`, 404],
    [`/api/servers/${s.id}/fs?path=${q('~/proj/README.md')}`, 400],
    [`/api/servers/${s.id}/file?path=${q('~/proj/src')}`, 400],
    [`/api/servers/${s.id}/file`, 400],
    [`/api/servers/srv_inconnu/fs`, 404],
  ];
  for (const [url, code] of cases) expect((await get(url)).statusCode, url).toBe(code);
});

test('F.1 : un dossier trop grand est coupé au plafond', async () => {
  t = await startTestDaemon();
  const p = join(t.home, 'proj');
  mkdirSync(p);
  for (let i = 0; i <= ENTRIES_MAX; i++) writeFileSync(join(p, `f${i}`), '');
  const s = await create();
  const l = (await get(`/api/servers/${s.id}/fs`)).json<ServerFsListing>();
  expect(l.truncated).toBe(true);
  expect(l.entries).toHaveLength(ENTRIES_MAX);
  expect(l.git).toBe(false);
});

test('F.1 : serveur injoignable → 502 et pastille injoignable', async () => {
  t = await startTestDaemon(undefined, {
    remote: { ssh: FAKE_SSH, env: { ...process.env, FAKE_SSH_FAIL: '1' } },
  });
  const s = await create();
  const r = await get(`/api/servers/${s.id}/fs`);
  expect(r.statusCode).toBe(502);
  expect(r.json<{ error: string }>().error).toMatch(/vps-ovh ne répond pas : .*Connection refused/);
  const st = (await get('/api/servers/status')).json<ServerStatus[]>();
  expect(st.find((x) => x.serverId === s.id)?.state).toBe('unreachable');
});

test('F.1 : le git status ne réécrit pas l’index du dépôt (lecture seule)', async () => {
  t = await startTestDaemon();
  const p = projet(t.home);
  const s = await create();
  // stat d'un fichier suivi changé, contenu identique : un `git status` ordinaire rafraîchirait l'index
  utimesSync(join(p, 'README.md'), new Date(), new Date(Date.now() + 60_000));
  const avant = statSync(join(p, '.git', 'index')).mtimeMs;
  const r = await get(`/api/servers/${s.id}/fs`);
  expect(r.statusCode).toBe(200);
  expect(r.json<ServerFsListing>().entries.find((e) => e.name === 'README.md')?.git).toBeNull();
  expect(statSync(join(p, '.git', 'index')).mtimeMs).toBe(avant);
});

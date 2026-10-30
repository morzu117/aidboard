import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  ensureRelay,
  parseAlive,
  parseFini,
  RELAY_SCRIPT,
  relayAlive,
  relayAttach,
  relayStart,
  relayStop,
} from '../src/daemon/remote/relay.js';
import {
  killGroup,
  remoteExec,
  remoteSpawn,
  type TransportOptions,
} from '../src/daemon/remote/transport.js';
import { FAKE_SSH, waitFor } from './helpers/daemon.js';

/** Chantier 17 (R.2) : le relais tourne localement derrière le faux ssh (D79) ; jamais de vrai serveur. */
const FAKE_TMUX = resolve(__dirname, 'fixtures/fake-tmux.sh');
const AGENT = resolve(__dirname, 'fixtures/fake-line-agent.sh');
const SERVER = {
  mode: 'ssh_alias' as const,
  target: 'vps',
  sshOptions: null,
  loadProfile: false,
  shell: 'sh',
};

const nettoyages: (() => void)[] = [];
afterEach(() => {
  for (const n of nettoyages.splice(0).reverse()) n();
});

/** Tue un pid lu dans un fichier ; un fichier vide ou à moitié écrit ne doit jamais donner `kill(0)`. */
function tuer(fichier: string): void {
  try {
    const pid = parseInt(readFileSync(fichier, 'utf8'), 10);
    if (pid > 1) process.kill(pid, 'SIGKILL');
  } catch {
    // déjà mort, ou jamais lancé
  }
}

/** Un « serveur » neuf : HOME distant temporaire, faux tmux en tête du PATH (ou le vrai, isolé). */
function serveur(vraiTmux = false): { home: string; transport: TransportOptions } {
  const home = mkdtempSync(join(tmpdir(), 'aid-relay-'));
  const env: NodeJS.ProcessEnv = { ...process.env, FAKE_SSH_HOME: home };
  if (vraiTmux) {
    // socket tmux dans le dossier du test : jamais le serveur tmux de l'opérateur
    env.TMUX_TMPDIR = join(home, 'tmux');
    mkdirSync(env.TMUX_TMPDIR);
    delete env.TMUX;
  } else {
    const bin = join(home, 'faux-bin');
    mkdirSync(bin);
    symlinkSync(FAKE_TMUX, join(bin, 'tmux'));
    env.FAKE_TMUX_DIR = join(home, 'faux-tmux');
    mkdirSync(env.FAKE_TMUX_DIR);
    env.PATH = `${bin}:${process.env.PATH}`;
    // le shell de connexion distant relit /etc/profile, qui remet les dossiers système (et un vrai tmux)
    // devant : le profil du HOME distant remet le faux en tête, comme dans servers-connection.test.ts
    writeFileSync(join(home, '.profile'), `PATH='${bin}':"$PATH"\nexport PATH\n`);
  }
  const transport = { ssh: FAKE_SSH, env };
  nettoyages.push(() => {
    if (vraiTmux) {
      try {
        execFileSync('tmux', ['-L', 'aid-relay', 'kill-server'], { env, stdio: 'ignore' });
      } catch {
        // aucun serveur tmux lancé
      }
    } else {
      for (const f of readdirSync(env.FAKE_TMUX_DIR!)) tuer(join(env.FAKE_TMUX_DIR!, f));
    }
    const agents = join(home, '.aid-remote/agents');
    if (existsSync(agents)) for (const id of readdirSync(agents)) tuer(join(agents, id, 'apid'));
    rmSync(home, { recursive: true, force: true });
  });
  return { home, transport };
}

const exec = (transport: TransportOptions, cmd: string) =>
  remoteExec(SERVER, cmd, { ...transport, timeoutMs: 10_000 });

/** Un rattachement : ce qu'il a reçu, et sa fin (code, stderr). */
function attacher(transport: TransportOptions, id: string, offset: number) {
  const child = remoteSpawn(SERVER, relayAttach(id, offset), transport);
  const recu: Buffer[] = [];
  let err = '';
  child.stdout.on('data', (c: Buffer) => recu.push(c));
  child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
  const fin = new Promise<{ code: number | null; stderr: string }>((r) =>
    child.on('close', (code) => r({ code, stderr: err })),
  );
  nettoyages.push(() => killGroup(child, 'SIGKILL'));
  const texte = () => Buffer.concat(recu).toString('utf8');
  return {
    child,
    fin,
    texte,
    octets: () => Buffer.concat(recu).length,
    attendre: (motif: string) => waitFor(() => texte().includes(motif), 10_000, motif),
    ecrire: (ligne: string) => child.stdin.write(`${ligne}\n`),
  };
}

async function demarrer(transport: TransportOptions, id: string, cwd = '~', argv = [AGENT]) {
  const r = await exec(transport, relayStart(id, cwd, argv));
  expect(r.stderr).toBe('');
  expect(r).toMatchObject({ code: 0 });
  expect(r.stdout).toContain('aid-relay: démarré');
  // garde : jamais le serveur tmux de l'opérateur — le faux a bien enregistré la session
  const faux = transport.env?.FAKE_TMUX_DIR;
  if (faux) expect(existsSync(join(faux, `aid-${id}`))).toBe(true);
}

const alive = async (transport: TransportOptions, id: string) =>
  parseAlive((await exec(transport, relayAlive(id))).stdout);

/** `waitFor` n'attend pas une promesse : sondage d'`alive` jusqu'à l'état voulu. */
async function attendreEtat(transport: TransportOptions, id: string, state: string): Promise<void> {
  const debut = Date.now();
  while ((await alive(transport, id)).state !== state) {
    if (Date.now() - debut > 10_000) throw new Error(`délai dépassé : ${id} ${state}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('dépôt : déposé une fois, présent ensuite, redéposé s’il a changé', async () => {
  const { home, transport } = serveur();
  const fichier = join(home, '.aid-remote/aid-relay');
  expect(await ensureRelay(SERVER, transport)).toBe('depose');
  expect(readFileSync(fichier, 'utf8')).toBe(RELAY_SCRIPT);
  expect(statSync(fichier).mode & 0o777).toBe(0o700);
  expect(statSync(join(home, '.aid-remote')).mode & 0o077).toBe(0);
  expect(await ensureRelay(SERVER, transport)).toBe('present');

  writeFileSync(fichier, '#!/bin/sh\necho ancien\n');
  expect(await ensureRelay(SERVER, transport)).toBe('depose');
  expect(readFileSync(fichier, 'utf8')).toBe(RELAY_SCRIPT);
  expect((await exec(transport, 'sh ~/.aid-remote/aid-relay version')).stdout.trim()).toBe('1');
});

test('dépôt dont la somme reçue ne correspond pas : rien n’est publié', async () => {
  const { home, transport } = serveur();
  // un envoi tronqué donne une autre somme : simulée ici par un sha256sum qui ne reconnaît rien
  writeFileSync(join(home, 'faux-bin/sha256sum'), '#!/bin/sh\necho "0000  $1"\n', { mode: 0o755 });
  await expect(ensureRelay(SERVER, transport)).rejects.toThrow(/dépôt incomplet/);
  expect(readdirSync(join(home, '.aid-remote'))).toEqual([]);
});

test('dépôt impossible : l’erreur du serveur remonte', async () => {
  const { transport } = serveur();
  await expect(
    ensureRelay(SERVER, { ...transport, env: { ...transport.env, FAKE_SSH_FAIL: '1' } }),
  ).rejects.toThrow(/Connection refused/);
});

test('cycle complet : démarrage, coupure en plein tour, ré-attache à l’offset sans perte ni doublon, fin', async () => {
  const { home, transport } = serveur();
  await ensureRelay(SERVER, transport);
  mkdirSync(join(home, 'projet'));
  // argv qui passe par le shell distant puis par tmux : guillemets, $, ; et retours à la ligne (finaux
  // compris) restent littéraux
  await demarrer(transport, 'sa_1', '~/projet', [
    'sh',
    '-c',
    'pwd; echo "$1"; printf "[%s]\\n" "$2"; exec "$0"',
    AGENT,
    "l'a $HOME;",
    "x\ny'\n\n",
  ]);
  expect(await alive(transport, 'sa_1')).toEqual({ state: 'vivant' });

  const a = attacher(transport, 'sa_1', 0);
  await a.attendre(']');
  expect(a.texte().split('\n').slice(0, 6)).toEqual([
    join(home, 'projet'),
    "l'a $HOME;",
    '[x',
    "y'",
    '',
    ']',
  ]);
  a.ecrire('bonjour');
  await a.attendre('{"echo":"bonjour"}');
  a.ecrire('lent 6');
  await a.attendre('{"n":1}');

  // coupure : le ssh meurt, l'agent continue d'écrire
  killGroup(a.child, 'SIGKILL');
  await a.fin;
  const offset = a.octets();
  const out = join(home, '.aid-remote/agents/sa_1/out');
  await waitFor(() => readFileSync(out, 'utf8').includes('{"n":6}'), 10_000, 'fin du tour');
  expect(await alive(transport, 'sa_1')).toEqual({ state: 'vivant' });

  const b = attacher(transport, 'sa_1', offset);
  await b.attendre('{"n":6}');
  const total = a.texte() + b.texte();
  expect(total).toBe(readFileSync(out, 'utf8'));
  for (let n = 1; n <= 6; n++) expect(total.split(`{"n":${n}}\n`)).toHaveLength(2);

  // l'entrée passe par le nouveau rattachement ; la fin de l'agent termine attach en 0
  b.ecrire('quit');
  const fin = await b.fin;
  expect(fin.code).toBe(0);
  expect(parseFini(fin.stderr)).toBe(0);
  expect(await alive(transport, 'sa_1')).toEqual({ state: 'fini', code: 0 });

  expect((await exec(transport, relayStop('sa_1'))).code).toBe(0);
  expect(existsSync(join(home, '.aid-remote/agents/sa_1'))).toBe(false);
  expect(await alive(transport, 'sa_1')).toEqual({ state: 'inconnu' });
});

test('agent en échec : code de fin rendu par attach et alive ; répertoire absent : 126', async () => {
  const { transport } = serveur();
  await ensureRelay(SERVER, transport);
  await demarrer(transport, 'sa_2');
  const a = attacher(transport, 'sa_2', 0);
  a.ecrire('fail');
  const fin = await a.fin;
  expect(fin.code).toBe(0);
  expect(parseFini(fin.stderr)).toBe(3);
  expect(await alive(transport, 'sa_2')).toEqual({ state: 'fini', code: 3 });

  await demarrer(transport, 'sa_3', '~/nulle-part');
  expect(await alive(transport, 'sa_3')).toEqual({ state: 'fini', code: 126 });
});

test('session disparue (redémarrage du serveur) : perdu, attach rend la sortie restante puis 4', async () => {
  const { home, transport } = serveur();
  await ensureRelay(SERVER, transport);
  await demarrer(transport, 'sa_4');
  const a = attacher(transport, 'sa_4', 0);
  a.ecrire('avant');
  await a.attendre('{"echo":"avant"}');
  killGroup(a.child, 'SIGKILL');
  await a.fin;

  const d = join(home, '.aid-remote/agents/sa_4');
  // redémarrage : la session tmux et l'agent disparaissent sans que exit soit écrit
  execFileSync(FAKE_TMUX, ['kill-session', '-t', 'aid-sa_4'], { env: transport.env });
  process.kill(Number(readFileSync(join(d, 'apid'), 'utf8')), 'SIGKILL');
  await attendreEtat(transport, 'sa_4', 'perdu');

  const b = attacher(transport, 'sa_4', 0);
  const fin = await b.fin;
  expect(fin.code).toBe(4);
  expect(fin.stderr).toContain('aid-relay: perdu');
  expect(b.texte()).toContain('{"echo":"avant"}');
});

test('un seul rattachement à la fois : le nouveau remplace l’ancien', async () => {
  const { transport } = serveur();
  await ensureRelay(SERVER, transport);
  await demarrer(transport, 'sa_5');
  const a = attacher(transport, 'sa_5', 0);
  a.ecrire('un');
  await a.attendre('{"echo":"un"}');
  const b = attacher(transport, 'sa_5', a.octets());
  expect((await a.fin).code).not.toBe(0);
  b.ecrire('deux');
  await b.attendre('{"echo":"deux"}');
  expect(b.texte()).not.toContain('{"echo":"un"}');
});

test('start en échec (tmux refuse) : rien ne reste, la relance du même id repart', async () => {
  const { home, transport } = serveur();
  await ensureRelay(SERVER, transport);
  const r = await exec(
    { ...transport, env: { ...transport.env, FAKE_TMUX_FAIL: '1' } },
    relayStart('sa_7', '~', [AGENT]),
  );
  expect(r.code).toBe(7);
  expect(r.stderr).toContain('tmux new-session a échoué');
  expect(existsSync(join(home, '.aid-remote/agents/sa_7'))).toBe(false);
  await demarrer(transport, 'sa_7');
  // un second start du même id est refusé, sans toucher à l'agent en place
  const double = await exec(transport, relayStart('sa_7', '~', [AGENT]));
  expect(double.code).toBe(5);
  expect(await alive(transport, 'sa_7')).toEqual({ state: 'vivant' });
});

test('entrée fermée par le daemon : attach sort en 5 et libère sa place ; offset au-delà de la sortie : 8', async () => {
  const { home, transport } = serveur();
  await ensureRelay(SERVER, transport);
  await demarrer(transport, 'sa_8');
  const a = attacher(transport, 'sa_8', 0);
  a.ecrire('un');
  await a.attendre('{"echo":"un"}');
  a.child.stdin.end();
  expect((await a.fin).code).toBe(5);
  expect(existsSync(join(home, '.aid-remote/agents/sa_8/attach'))).toBe(false);
  expect(await alive(transport, 'sa_8')).toEqual({ state: 'vivant' });

  const b = attacher(transport, 'sa_8', a.octets() + 100);
  const fin = await b.fin;
  expect(fin.code).toBe(8);
  expect(fin.stderr).toContain('au-delà de la sortie');
});

test('identifiants : agent inconnu (3), identifiant ou offset refusés des deux côtés', async () => {
  const { transport } = serveur();
  await ensureRelay(SERVER, transport);
  const a = attacher(transport, 'sa_absent', 0);
  const fin = await a.fin;
  expect(fin.code).toBe(3);
  expect(fin.stderr).toContain('inconnu');
  expect(await alive(transport, 'sa_absent')).toEqual({ state: 'inconnu' });

  expect(() => relayAttach('../x', 0)).toThrow(/identifiant/);
  expect(() => relayAttach('sa_1', -1)).toThrow(/offset/);
  expect(() => relayStart('sa_1', '~', [])).toThrow(/vide/);
  const brut = await exec(transport, "sh ~/.aid-remote/aid-relay attach '../x' 0");
  expect(brut.code).toBe(2);
  expect(brut.stderr).toContain('identifiant invalide');
  expect(() => parseAlive('bash: aid-relay: not found')).toThrow(/illisible/);
});

const tmux = (() => {
  try {
    return execFileSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
})();

// Le vrai tmux, quand la machine l'a : la commande passée à `new-session` est la seule chose que le faux
// ne vérifie pas. Absent (CI) : le faux tmux ci-dessus couvre tout le reste.
test.skipIf(!tmux)('avec le vrai tmux : démarrage, écho, fin, environnement du start', async () => {
  const { home, transport } = serveur(true);
  await ensureRelay(SERVER, transport);
  const avec = (v: string) => ({ ...transport, env: { ...transport.env, AID_RELAY_ESSAI: v } });
  const argv = ['sh', '-c', 'echo "v=$AID_RELAY_ESSAI"; exec "$0"', AGENT];
  await demarrer(avec('un'), 'sa_6', '~', argv);
  // le serveur tmux est né avec v=un : le second agent doit voir l'environnement de son propre start
  await demarrer(avec('deux'), 'sa_9', '~', argv);
  const b = attacher(transport, 'sa_9', 0);
  await b.attendre('v=deux');

  const a = attacher(transport, 'sa_6', 0);
  await a.attendre('v=un');
  a.ecrire('réel');
  await a.attendre('{"echo":"réel"}');
  a.ecrire('quit');
  const fin = await a.fin;
  expect(parseFini(fin.stderr)).toBe(0);
  expect((await exec(transport, relayStop('sa_6'))).code).toBe(0);
  // cible exacte : sans session à lui, l'agent « sa_ » ne désigne pas aid-sa_9 par préfixe
  mkdirSync(join(home, '.aid-remote/agents/sa_'));
  expect(await alive(transport, 'sa_')).toEqual({ state: 'perdu' });
  expect((await exec(transport, relayStop('sa_'))).code).toBe(0);
  expect(await alive(transport, 'sa_9')).toEqual({ state: 'vivant' });
  expect((await exec(transport, relayStop('sa_9'))).code).toBe(0);
});

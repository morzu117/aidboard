import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TransportOptions } from '../../src/daemon/remote/transport.js';

/**
 * Chantier 18 : le labo serveur. Un conteneur Linux local avec un vrai sshd et un vrai tmux, joint par le
 * vrai `ssh` du poste sous une configuration du run (DL2) — jamais le `~/.ssh` de l'opérateur, son agent
 * ou son `known_hosts`. Le conteneur n'écoute que sur 127.0.0.1 (DL3).
 */
const DOSSIER = __dirname;
const FIXTURES = resolve(__dirname, '../fixtures');

/** Comptes du serveur (DL7) : alias ssh → utilisateur et shell de connexion. */
export const COMPTES = {
  'aid-labo': { user: 'aid', shell: 'bash', home: '/home/aid' },
  'aid-labo-zsh': { user: 'aidzsh', shell: 'zsh', home: '/home/aidzsh' },
  'aid-labo-dash': { user: 'aiddash', shell: 'dash', home: '/home/aiddash' },
} as const;
export type Alias = keyof typeof COMPTES;
const COMPTES_UTILISATEURS = Object.values(COMPTES)
  .map((c) => c.user)
  .join(' ');

export interface Labo {
  /** Enveloppeur du vrai ssh, à passer au daemon comme binaire `ssh`. */
  ssh: string;
  transport: TransportOptions & { env: NodeJS.ProcessEnv };
  conteneur: string;
  /** Exécute une commande shell dans le conteneur, sous un compte (root par défaut). */
  exec(cmd: string, user?: string): string;
  /**
   * Coupure réseau : les connexions ssh en cours tombent et les nouvelles sont refusées (sshd relit sa
   * configuration). Les process du serveur, agents et tmux compris, continuent.
   */
  couper(): void;
  /** Fin de la coupure : le serveur répond de nouveau. */
  retablir(): void;
  arreter(): void;
}

function docker(args: string[], timeout = 60_000): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  });
}

/** L'image suit le Dockerfile : un Dockerfile modifié construit une nouvelle image. */
export function imageLabo(): string {
  const empreinte = createHash('sha256')
    .update(readFileSync(join(DOSSIER, 'Dockerfile')))
    .digest('hex');
  return `aid-labo-serveur:${empreinte.slice(0, 12)}`;
}

/** DL6 : Docker absent ou arrêté est un échec explicite, jamais un saut. */
export function verifierDocker(): void {
  try {
    docker(['info', '--format', '{{.ServerVersion}}'], 20_000);
  } catch (err) {
    const detail = (err as { stderr?: string }).stderr?.trim() || (err as Error).message;
    throw new Error(`labo : Docker indisponible (colima start ?) — ${detail}`);
  }
}

export function construireImage(): string {
  const image = imageLabo();
  try {
    docker(['image', 'inspect', image], 20_000);
  } catch {
    docker(['build', '-q', '-t', image, DOSSIER], 600_000);
  }
  return image;
}

function attendre(ok: () => boolean, ms: number, quoi: string): void {
  const fin = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > fin) throw new Error(`labo : ${quoi} — délai dépassé (${ms} ms)`);
    execFileSync('sleep', ['0.2']);
  }
}

export function demarrerLabo(): Labo {
  verifierDocker();
  const image = construireImage();
  const nom = `aid-labo-${randomBytes(4).toString('hex')}`;
  const dossier = mkdtempSync(join(tmpdir(), 'aid-labo-'));
  const conteneur = docker([
    'run',
    '-d',
    '--rm',
    '--label',
    'aid-labo=1',
    '--name',
    nom,
    '-p',
    '127.0.0.1::22',
    image,
  ]).trim();
  const exec = (cmd: string, user = 'root') =>
    docker(['exec', '-u', user, conteneur, 'sh', '-c', cmd], 60_000);
  try {
    // DL4 : copiés, jamais montés
    docker(['cp', `${FIXTURES}/.`, `${conteneur}:/opt/aid-fixtures`]);
    exec('chown -R root:root /opt/aid-fixtures && chmod -R a+rX /opt/aid-fixtures');
    execFileSync(
      'ssh-keygen',
      ['-q', '-t', 'ed25519', '-N', '', '-C', nom, '-f', join(dossier, 'id')],
      {
        stdio: 'ignore',
      },
    );
    docker(['cp', join(dossier, 'id.pub'), `${conteneur}:/etc/ssh/labo_authorized_keys`]);
    exec(
      'chown root:root /etc/ssh/labo_authorized_keys && chmod 644 /etc/ssh/labo_authorized_keys',
    );

    const port = /:(\d+)\s*$/m.exec(docker(['port', conteneur, '22/tcp']).split('\n')[0]!)?.[1];
    if (!port) throw new Error('labo : port ssh du conteneur introuvable');
    const config = join(dossier, 'config');
    const hotes = Object.keys(COMPTES).join(' ');
    writeFileSync(
      config,
      [
        ...Object.entries(COMPTES).flatMap(([alias, c]) => [`Host ${alias}`, `  User ${c.user}`]),
        `Host ${hotes}`,
        '  HostName 127.0.0.1',
        `  Port ${port}`,
        `  IdentityFile ${join(dossier, 'id')}`,
        '  IdentitiesOnly yes',
        '  IdentityAgent none',
        `  UserKnownHostsFile ${join(dossier, 'known_hosts')}`,
        '  GlobalKnownHostsFile /dev/null',
        '  StrictHostKeyChecking accept-new',
        '  ControlMaster no',
        '  ControlPath none',
        '  LogLevel ERROR',
        '',
      ].join('\n'),
    );
    const ssh = join(dossier, 'ssh');
    writeFileSync(ssh, `#!/bin/sh\nexec ssh -F '${config}' "$@"\n`);
    chmodSync(ssh, 0o755);

    const joignable = () => {
      try {
        execFileSync(ssh, ['-o', 'BatchMode=yes', 'aid-labo', 'true'], {
          stdio: 'ignore',
          timeout: 10_000,
        });
        return true;
      } catch {
        return false;
      }
    };
    attendre(joignable, 30_000, 'sshd du conteneur');

    return {
      ssh,
      transport: { ssh, env: { ...process.env } },
      conteneur,
      exec,
      couper: () => {
        exec(
          `printf 'DenyUsers ${COMPTES_UTILISATEURS}\\n' > /etc/ssh/sshd_config.d/00-coupure.conf && kill -HUP 1`,
        );
        attendre(() => !joignable(), 10_000, 'coupure du serveur');
        exec(`pkill -f '^sshd: (${COMPTES_UTILISATEURS.replace(/ /g, '|')})' || true`);
      },
      retablir: () => {
        exec('rm -f /etc/ssh/sshd_config.d/00-coupure.conf && kill -HUP 1');
        attendre(joignable, 10_000, 'retour du serveur');
      },
      arreter: () => {
        try {
          docker(['rm', '-f', conteneur], 60_000);
        } finally {
          rmSync(dossier, { recursive: true, force: true });
        }
      },
    };
  } catch (err) {
    try {
      docker(['rm', '-f', conteneur], 60_000);
    } catch {
      // déjà parti
    }
    rmSync(dossier, { recursive: true, force: true });
    throw err;
  }
}

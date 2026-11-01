import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import {
  ensureRelay,
  parseAlive,
  parseFini,
  RELAY_SCRIPT,
  relayAlive,
  relayAttach,
  relayStart,
  relayStop,
} from '../../src/daemon/remote/relay.js';
import { killGroup, remoteExec, remoteSpawn } from '../../src/daemon/remote/transport.js';
import { waitFor } from '../helpers/daemon.js';
import { type Alias, COMPTES, demarrerLabo, type Labo } from './labo.js';

/**
 * Chantier 18, L.2 : le relais du chantier 17 contre le vrai tmux et le vrai sshd. Une coupure est une
 * vraie connexion ssh qui meurt : c'est sshd, pas un faux, qui décide de ce qui arrive au rattachement.
 */
const AGENT = '/opt/aid-fixtures/fake-line-agent.sh';

let labo: Labo;
beforeAll(() => {
  labo = demarrerLabo();
});
afterAll(() => labo?.arreter());

const nettoyages: (() => void)[] = [];
afterEach(() => {
  for (const n of nettoyages.splice(0).reverse()) n();
});

const serveur = (alias: Alias) => ({
  mode: 'ssh_alias' as const,
  target: alias,
  sshOptions: null,
  loadProfile: false,
  shell: COMPTES[alias].shell === 'dash' ? 'sh' : COMPTES[alias].shell,
});

const exec = (alias: Alias, cmd: string) =>
  remoteExec(serveur(alias), cmd, { ...labo.transport, timeoutMs: 15_000 });

const alive = async (alias: Alias, id: string) =>
  parseAlive((await exec(alias, relayAlive(id))).stdout);

async function attendreEtat(alias: Alias, id: string, state: string): Promise<void> {
  const debut = Date.now();
  while ((await alive(alias, id)).state !== state) {
    if (Date.now() - debut > 15_000) throw new Error(`délai dépassé : ${id} ${state}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function attacher(alias: Alias, id: string, offset: number) {
  const child = remoteSpawn(serveur(alias), relayAttach(id, offset), labo.transport);
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
    attendre: (motif: string) => waitFor(() => texte().includes(motif), 15_000, motif),
    ecrire: (ligne: string) => child.stdin.write(`${ligne}\n`),
  };
}

async function demarrer(alias: Alias, id: string, argv: string[] = [AGENT]): Promise<void> {
  const r = await exec(alias, relayStart(id, '~', argv));
  expect(r, r.stderr).toMatchObject({ code: 0 });
  expect(r.stdout).toContain('aid-relay: démarré');
}

/** Sessions du serveur tmux du relais, vues dans le conteneur. */
const sessions = (alias: Alias) =>
  labo
    .exec(`tmux -L aid-relay ls -F '#S' 2>/dev/null || true`, COMPTES[alias].user)
    .split('\n')
    .filter(Boolean);

const sortie = (alias: Alias, id: string) =>
  labo.exec(`cat ~/.aid-remote/agents/${id}/out`, COMPTES[alias].user);

test.each(Object.keys(COMPTES) as Alias[])(
  '%s : dépôt, démarrage sous tmux, vraie coupure ssh en plein tour, ré-attache sans perte ni doublon, arrêt',
  async (alias) => {
    expect(await ensureRelay(serveur(alias), labo.transport)).toBe('depose');
    expect(labo.exec('cat ~/.aid-remote/aid-relay', COMPTES[alias].user)).toBe(RELAY_SCRIPT);
    expect(await ensureRelay(serveur(alias), labo.transport)).toBe('present');

    await demarrer(alias, 'sa_1');
    expect(sessions(alias)).toEqual(['aid-sa_1']);
    expect(await alive(alias, 'sa_1')).toEqual({ state: 'vivant' });

    const a = attacher(alias, 'sa_1', 0);
    a.ecrire('bonjour');
    await a.attendre('{"echo":"bonjour"}');
    a.ecrire('lent 8');
    await a.attendre('{"n":1}');

    // la connexion ssh meurt : sshd ferme la session distante, l'agent continue dans tmux
    killGroup(a.child, 'SIGKILL');
    await a.fin;
    const offset = a.octets();
    await waitFor(
      () => sortie(alias, 'sa_1').includes('{"n":8}'),
      15_000,
      'fin du tour pendant la coupure',
    );
    expect(await alive(alias, 'sa_1')).toEqual({ state: 'vivant' });

    const b = attacher(alias, 'sa_1', offset);
    await b.attendre('{"n":8}');
    const total = a.texte() + b.texte();
    expect(total).toBe(sortie(alias, 'sa_1'));
    for (let n = 1; n <= 8; n++) expect(total.split(`{"n":${n}}\n`)).toHaveLength(2);

    b.ecrire('encore');
    await b.attendre('{"echo":"encore"}');
    expect((await exec(alias, relayStop('sa_1'))).code).toBe(0);
    await b.fin;
    expect(await alive(alias, 'sa_1')).toEqual({ state: 'inconnu' });
    expect(sessions(alias)).toEqual([]);
    expect(labo.exec(`pgrep -u ${COMPTES[alias].user} -f fake-line-agent || true`).trim()).toBe('');
  },
);

test('fin de l’agent : attach rend le code ; agent en échec : 3', async () => {
  await ensureRelay(serveur('aid-labo'), labo.transport);
  await demarrer('aid-labo', 'sa_2');
  const a = attacher('aid-labo', 'sa_2', 0);
  a.ecrire('fail');
  const fin = await a.fin;
  expect(fin.code).toBe(0);
  expect(parseFini(fin.stderr)).toBe(3);
  expect(await alive('aid-labo', 'sa_2')).toEqual({ state: 'fini', code: 3 });
  expect(sessions('aid-labo')).not.toContain('aid-sa_2');
  await exec('aid-labo', relayStop('sa_2'));
});

test('session tmux tuée : l’agent meurt avec elle, perdu, attach rend la sortie restante puis 4', async () => {
  await ensureRelay(serveur('aid-labo'), labo.transport);
  await demarrer('aid-labo', 'sa_3');
  const a = attacher('aid-labo', 'sa_3', 0);
  a.ecrire('avant');
  await a.attendre('{"echo":"avant"}');
  killGroup(a.child, 'SIGKILL');
  await a.fin;

  labo.exec('tmux -L aid-relay kill-session -t =aid-sa_3', 'aid');
  await attendreEtat('aid-labo', 'sa_3', 'perdu');
  expect(labo.exec('pgrep -u aid -f fake-line-agent || true').trim()).toBe('');

  const b = attacher('aid-labo', 'sa_3', 0);
  const fin = await b.fin;
  expect(fin.code).toBe(4);
  expect(fin.stderr).toContain('aid-relay: perdu');
  expect(b.texte()).toContain('{"echo":"avant"}');
  await exec('aid-labo', relayStop('sa_3'));
});

test('serveur tmux tué (redémarrage) : tous les agents perdus, un nouveau start repart', async () => {
  await ensureRelay(serveur('aid-labo'), labo.transport);
  await demarrer('aid-labo', 'sa_4');
  await demarrer('aid-labo', 'sa_5');
  labo.exec('tmux -L aid-relay kill-server', 'aid');
  await attendreEtat('aid-labo', 'sa_4', 'perdu');
  await attendreEtat('aid-labo', 'sa_5', 'perdu');

  await exec('aid-labo', relayStop('sa_4'));
  await demarrer('aid-labo', 'sa_4');
  expect(await alive('aid-labo', 'sa_4')).toEqual({ state: 'vivant' });
  await exec('aid-labo', relayStop('sa_4'));
  await exec('aid-labo', relayStop('sa_5'));
});

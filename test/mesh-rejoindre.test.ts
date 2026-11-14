import { ChildProcess, spawn } from 'node:child_process';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import { LanceurRejoindre, validerGatewayRejoindre } from '../src/daemon/mesh/rejoindre.js';

vi.mock('node:child_process', { spy: true });

let dossier: string;
let lanceur: LanceurRejoindre;
const demande = { gateway: 'https://aid-e2e.ts.net', cell: 'peer-a', mesh: 'essai' };
const jeton = () => join(dossier, 'home/.config/swarph/peer-a.peer_token');
const inscription = () => join(dossier, 'home/.config/swarph/peer-a.join.json');

beforeEach(async () => {
  await mkdir('/var/tmp/aid-tmp-33.3', { recursive: true });
  dossier = await mkdtemp('/var/tmp/aid-tmp-33.3/rejoindre-');
  const bin = join(dossier, 'swarph');
  await copyFile(resolve('test/fixtures/fake-swarph-join.mjs'), bin);
  await chmod(bin, 0o700);
  lanceur = new LanceurRejoindre({
    mesh: { ...DEFAULT_CONFIG.mesh, bin, home: join(dossier, 'home') },
    meshes: DEFAULT_CONFIG.meshes,
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await lanceur.annuler();
  vi.unstubAllEnvs();
  await rm(dossier, { recursive: true, force: true });
});

async function lancer(scenario: Record<string, unknown> = {}) {
  await writeFile(join(dossier, 'scenario.json'), JSON.stringify(scenario));
  lanceur.lancer(demande);
}
async function attendreCode() {
  await vi.waitFor(() => expect(lanceur.etat().etat).toBe('en-attente'));
}
async function attendreFin() {
  await vi.waitFor(() => expect(lanceur.etat().etat).not.toBe('en-attente'));
  expect(JSON.stringify(lanceur.etat())).not.toContain('FAUX-JETON');
}

describe('lanceur rejoindre — D333 et D334', () => {
  test('état initial aucune, puis demande avant la ligne Code', async () => {
    expect(lanceur.etat()).toEqual({ etat: 'aucune' });
    await lancer();
    expect(lanceur.etat()).toEqual({ etat: 'demande' });
    await attendreCode();
    await attendreFin();
  });

  test('error sans close termine la demande ; un close tardif ne termine pas la suivante', async () => {
    const enfant = Object.assign(new ChildProcess(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    await writeFile(join(dossier, 'scenario.json'), '{}');
    vi.mocked(spawn).mockReturnValueOnce(enfant);
    lanceur.lancer(demande);
    enfant.emit('error', Object.assign(new Error('exemple'), { code: 'ENOENT' }));
    expect(lanceur.etat()).toEqual({ etat: 'echec', libelle: 'swarph introuvable' });
    await lancer({ attente: true });
    enfant.emit('close', -2, null);
    expect(lanceur.etat()).toEqual({ etat: 'demande' });
    expect(() => lanceur.lancer(demande)).toThrow('déjà en cours');
    await attendreCode();
    await lanceur.annuler();
  });

  test.each(['ENOENT', 'EACCES'])(
    'spawn %s libère le lanceur pour un succès suivant',
    async (erreur) => {
      const bin = join(dossier, 'swarph');
      if (erreur === 'ENOENT') await rm(bin);
      else await chmod(bin, 0o600);
      await lancer();
      await vi.waitFor(() =>
        expect(lanceur.etat()).toEqual({ etat: 'echec', libelle: 'swarph introuvable' }),
      );
      await copyFile(resolve('test/fixtures/fake-swarph-join.mjs'), bin);
      await chmod(bin, 0o700);
      await lancer();
      await attendreCode();
      await attendreFin();
      expect(lanceur.etat()).toEqual({ etat: 'approuve' });
    },
  );

  test.each([true, false])('approuvé, témoin %s, entrée et environnement', async (temoin) => {
    for (const cle of [
      'SWARPH_SELF',
      'MESH_GATEWAY_URL',
      'MESH_GATEWAY_TOKEN',
      'GH_TOKEN',
      'GITHUB_TOKEN',
    ])
      vi.stubEnv(cle, 'exemple');
    await lancer({ temoin, bruit: true });
    await attendreCode();
    const etat = lanceur.etat();
    expect(etat).toMatchObject({ etat: 'en-attente', code: 'ABCD-EFGH' });
    if (etat.etat === 'en-attente')
      expect(etat.expiration - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(() => lanceur.lancer(demande)).toThrow('déjà en cours');
    const constat = JSON.parse(await readFile(join(dossier, 'constat.json'), 'utf8'));
    expect(constat).toEqual({
      entree: '/dev/null',
      python: '1',
      variables: [],
      arguments: ['join', demande.gateway, '--name', 'peer-a'],
    });
    await attendreFin();
    expect(lanceur.etat()).toEqual({ etat: 'approuve', ...(temoin ? { temoin: 'peer-b' } : {}) });
    expect((await lstat(jeton())).mode & 0o777).toBe(0o600);
  });

  test.each([
    ['access_denied', { etat: 'refuse' }],
    ['expired_token', { etat: 'expire' }],
    ['join request expired', { etat: 'expire' }],
    [
      'join request refused (HTTP 409)',
      { etat: 'echec', libelle: 'join request refused (HTTP 409)' },
    ],
    ['invalid gateway URL', { etat: 'echec', libelle: 'invalid gateway URL' }],
    [
      'authenticated identity check failed; the private credential file is retained',
      { etat: 'a-voir' },
    ],
    ['invalid token pickup response; operator recovery may be needed', { etat: 'a-voir' }],
    [
      'gateway request failed: FAUX-JETON-NE-JAMAIS-SERVIR',
      { etat: 'echec', libelle: 'gateway request failed' },
    ],
    ['inconnu FAUX-JETON-NE-JAMAIS-SERVIR', { etat: 'echec', libelle: 'échec' }],
  ])('raison %s réduite à la liste fermée', async (raison, etat) => {
    await lancer({ raison });
    await attendreCode();
    await attendreFin();
    expect(lanceur.etat()).toEqual(etat);
  });

  test('sortie inattendue sans raison', async () => {
    await lancer({ inattendu: true });
    await attendreCode();
    await attendreFin();
    expect(lanceur.etat()).toEqual({ etat: 'echec', libelle: 'échec' });
  });

  test('annulation par SIGINT, attend la fin et garde le code', async () => {
    await lancer({ attente: true, reserve: true });
    await attendreCode();
    await lanceur.annuler();
    expect(await readFile(join(dossier, 'signal'), 'utf8')).toBe('SIGINT');
    expect(lanceur.etat()).toEqual({ etat: 'annule', code: 'ABCD-EFGH' });
    await expect(lstat(jeton())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test.each([false, true])(
    'SIGKILL : jeton non vide %s',
    async (nonVide) => {
      await lancer({ attente: true, reserve: true, ignore: true, nonVide });
      await attendreCode();
      const fin = lanceur.annuler();
      await fin;
      expect(await readFile(join(dossier, 'signal'), 'utf8')).toBe('SIGINT');
      if (nonVide) expect((await lstat(jeton())).size).toBeGreaterThan(0);
      else await expect(lstat(jeton())).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(inscription())).rejects.toMatchObject({ code: 'ENOENT' });
      expect(lanceur.etat()).toEqual({ etat: 'annule', code: 'ABCD-EFGH' });
    },
    15_000,
  );

  test('filet à 16 minutes : SIGINT puis expiration', async () => {
    await lancer({ attente: true, reserve: true });
    await attendreCode();
    vi.useFakeTimers();
    // Le délai a été créé avant les faux timers : on le teste dans un nouveau lancement.
    vi.useRealTimers();
    await lanceur.annuler();
    vi.useFakeTimers();
    lanceur.lancer(demande);
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(lanceur.etat()).toEqual({ etat: 'expire' }));
  });

  test('seules les lignes ancrées sont interprétées ; dernière raison fermée', async () => {
    await lancer({
      code: 'préfixe Code: ABCD-EFGH (expires in 15 minutes).',
      lignes: [
        'Code: IIII-OOOO (expires in 15 minutes).',
        'préfixe No interactive answers were supplied; no handshake was sent. Send your own answers to peer-b.',
      ],
      erreurs: ['swarph join: access_denied', 'swarph join: secret-inconnu'],
    });
    await vi.waitFor(() => expect(lanceur.etat().etat).toBe('echec'));
    expect(lanceur.etat()).toEqual({ etat: 'echec', libelle: 'échec' });
  });

  test('une raison trop longue remplace la raison précédente sans conserver sa sortie', async () => {
    await lancer({ erreurs: ['swarph join: access_denied', `swarph join: ${'x'.repeat(5000)}`] });
    await attendreCode();
    await attendreFin();
    expect(lanceur.etat()).toEqual({ etat: 'echec', libelle: 'échec' });
  });

  test('SIGKILL ne suit pas les liens et ne supprime pas un join.json non vide', async () => {
    await lancer({ attente: true, reserve: true, ignore: true });
    await attendreCode();
    const cible = join(dossier, 'cible-vide');
    await writeFile(cible, '');
    await rm(jeton());
    await symlink(cible, jeton());
    await writeFile(inscription(), '{}');
    await lanceur.annuler();
    expect((await lstat(jeton())).isSymbolicLink()).toBe(true);
    expect((await lstat(cible)).size).toBe(0);
    expect((await lstat(inscription())).size).toBe(2);
  }, 15_000);

  test('refus avant lancement : noms, mesh existant, HTTP et jeton présent', async () => {
    for (const cell of ['a', 'Peer-a', '../peer-a', 'peer-a-', 'a'.repeat(65)])
      expect(() => lanceur.lancer({ ...demande, cell })).toThrow('invalid peer name');
    for (const mesh of ['Essai', '../essai', 'a'.repeat(33)])
      expect(() => lanceur.lancer({ ...demande, mesh })).toThrow('Nom de mesh invalide');
    expect(() => lanceur.lancer({ ...demande, mesh: 'principal' })).toThrow('déjà configuré');
    expect(() => lanceur.lancer({ ...demande, gateway: 'http://192.0.2.1' })).toThrow(
      'non-tailnet',
    );
    await mkdir(join(dossier, 'home/.config/swarph'), { recursive: true });
    await writeFile(jeton(), 'FAUX-JETON-NE-JAMAIS-SERVIR');
    expect(() => lanceur.lancer(demande)).toThrow('jeton déjà présent');
    await expect(lstat(join(dossier, 'constat.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('adresses strictes', () => {
    for (const adresse of [
      'https://example.com/chemin',
      'https://example.com?x',
      'https://example.com#x',
      'https://peer-a@example.com',
      'file:///example.com',
      'http://ts.net',
      'http://aid-e2e.ts.net.example.com',
    ])
      expect(() => validerGatewayRejoindre(adresse)).toThrow();
    expect(validerGatewayRejoindre('http://aid-e2e.ts.net/')).toBe('http://aid-e2e.ts.net');
    expect(validerGatewayRejoindre('https://example.com')).toBe('https://example.com');
  });
});

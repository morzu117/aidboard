import { expect, test, vi } from 'vitest';
import { creerSondeEnvironnement } from '../src/daemon/machines/environnement.js';

const URL = 'http://127.0.0.1:11434';
const OUTILS = ['node', 'npm', 'git', 'mise', 'docker', 'python3', 'cargo', 'ollama'];

function fixture() {
  const exec = vi.fn(async () => ({ stdout: 'version 1.2.3', stderr: '' }));
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => Response.json({ models: [] }));
  const procVersion = vi.fn(async () => 'Linux version');
  return { exec, fetch, procVersion };
}

test('63.3 : la liste fermée des outils est sondée en parallèle, avec le délai prévu', async () => {
  const sondes = fixture();
  const mesurer = creerSondeEnvironnement(URL, sondes);
  const mesure = mesurer();
  expect(sondes.exec.mock.calls).toEqual(
    OUTILS.map((outil) => [outil, ['--version'], { timeout: 3000, killSignal: 'SIGKILL' }]),
  );
  expect(await mesure).toEqual({
    os: process.platform,
    arch: process.arch,
    outils: Object.fromEntries(OUTILS.map((outil) => [outil, '1.2.3'])),
    modelesOllama: [],
    mesureA: expect.any(String),
  });
});

test('63.3 : outil absent, délai dépassé et version illisible valent null', async () => {
  const sondes = fixture();
  sondes.exec
    .mockRejectedValueOnce(Object.assign(new Error('introuvable'), { code: 'ENOENT' }))
    .mockRejectedValueOnce(Object.assign(new Error('délai dépassé'), { killed: true }))
    .mockResolvedValueOnce({ stdout: 'inconnue', stderr: '' })
    .mockResolvedValueOnce({ stdout: '', stderr: 'mise 2.3.4' });
  const env = await creerSondeEnvironnement(URL, sondes)();
  expect(env.outils).toMatchObject({ node: null, npm: null, git: null, mise: '2.3.4' });
});

test('63.3 : Ollama ne livre que les noms triés', async () => {
  const sondes = fixture();
  sondes.fetch.mockResolvedValue(
    Response.json({ models: [{ name: 'z', path: '/tmp/z' }, { name: 'a' }, { model: 'autre' }] }),
  );
  const env = await creerSondeEnvironnement(`${URL}/`, sondes)();
  expect(sondes.fetch).toHaveBeenCalledWith(`${URL}/api/tags`, {
    method: 'GET',
    signal: expect.any(AbortSignal),
  });
  expect(env.modelesOllama).toEqual(['a', 'z']);
});

test('63.3 : absence, délai dépassé ou erreur HTTP d’Ollama', async () => {
  const sondes = fixture();
  sondes.fetch
    .mockRejectedValueOnce(new Error('connexion refusée'))
    .mockRejectedValueOnce(new DOMException('délai dépassé', 'TimeoutError'))
    .mockResolvedValueOnce(new Response(null, { status: 503 }));
  for (let i = 0; i < 3; i++) {
    expect((await creerSondeEnvironnement(URL, sondes)()).modelesOllama).toBeNull();
  }
});

test('63.3 : cache à la demande, dix minutes après la mesure', async () => {
  const sondes = fixture();
  let temps = Date.UTC(2026, 10, 24);
  const mesurer = creerSondeEnvironnement(URL, { ...sondes, maintenant: () => temps });
  expect(sondes.exec).not.toHaveBeenCalled();
  const premiere = await mesurer();
  expect(premiere.mesureA).toBe(new Date(temps).toISOString());
  temps += 599_999;
  expect(await mesurer()).toBe(premiere);
  temps++;
  expect(sondes.exec).toHaveBeenCalledTimes(8);
  expect((await mesurer()).mesureA).toBe(new Date(temps).toISOString());
  expect(sondes.exec).toHaveBeenCalledTimes(16);
});

test('63.3 : deux appels simultanés partagent la même promesse', async () => {
  const sondes = fixture();
  const mesurer = creerSondeEnvironnement(URL, sondes);
  const premiere = mesurer();
  expect(mesurer()).toBe(premiere);
  await premiere;
  expect(sondes.exec).toHaveBeenCalledTimes(8);
  expect(sondes.fetch).toHaveBeenCalledTimes(1);
});

test.runIf(process.platform === 'linux')('63.3 : WSL conserve linux et ajoute wsl', async () => {
  const sondes = fixture();
  sondes.procVersion.mockResolvedValue('Linux version 6.6.87.2-microsoft-standard-WSL2');
  expect(await creerSondeEnvironnement(URL, sondes)()).toMatchObject({ os: 'linux', wsl: true });
});

test('63.3 : un /proc/version manquant laisse la mesure disponible', async () => {
  const sondes = fixture();
  sondes.procVersion.mockRejectedValue(new Error('ENOENT'));
  expect(await creerSondeEnvironnement(URL, sondes)()).not.toHaveProperty('wsl');
});

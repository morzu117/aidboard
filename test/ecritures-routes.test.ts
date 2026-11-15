import { injecterEnvFauxSwarph } from './helpers/env-faux-swarph.js';
import { mkdtempSync, symlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import { startTestDaemon, waitFor, type TestDaemon } from './helpers/daemon.js';

injecterEnvFauxSwarph();

let t: TestDaemon | undefined;
afterEach(async () => {
  await t?.d.stop();
  t = undefined;
  vi.unstubAllEnvs();
});
async function boot(gateway = 'https://example.com') {
  const home = mkdtempSync(join(tmpdir(), 'aid-swarph-r-'));
  symlinkSync(join(import.meta.dirname, 'fixtures/fake-swarph.sh'), join(home, 'swarph'));
  vi.stubEnv('PATH', `${home}:${process.env.PATH}`);
  vi.stubEnv('FAKE_SWARPH_BOARD', join(import.meta.dirname, 'fixtures/board'));
  const journal = join(home, 'appels');
  writeFileSync(journal, '');
  vi.stubEnv('FAKE_SWARPH_LOG', journal);
  t = await startTestDaemon(home, {
    config: {
      mesh: {
        ...DEFAULT_CONFIG.mesh,
        bin: 'swarph',
        cell: 'peer-a',
        gateway,
        stateRoot: join(home, 'etat'),
        tailscale: { manage: false, bin: join(import.meta.dirname, 'fixtures/fake-tailscale.sh') },
      },
    },
  });
  await waitFor(() => readFileSync(journal, 'utf8').includes('monitor status'));
  writeFileSync(journal, '');
  return () => readFileSync(journal, 'utf8');
}

const texte = 'Bonjour';
const bases = {
  'carte.note': { carte: 3531, a: 'peer-b', kind: 'fyi', texte },
  'dm.envoyer': { pair: 'peer-b', fil: null, kind: 'answer', texte },
  'canal.poster': { canal: 'general', kind: 'status', texte },
};
const apercu = (action: string, params: unknown) =>
  t!.d.app.inject({
    method: 'POST',
    url: '/api/swarph/ecrire/apercu',
    headers: t!.headers,
    payload: { mesh: 'principal', action, params },
  });
test('trois aperçus exacts : seule la lecture des obligations part', async () => {
  const journal = await boot();
  const commandes = {
    'carte.note': [
      'board',
      'cards',
      'say',
      '3531',
      '--content-file',
      'FICHIER',
      '--kind',
      'fyi',
      '--to',
      'peer-b',
      '--as',
      'peer-a',
    ],
    'dm.envoyer': [
      'mesh',
      'send',
      'peer-b',
      '--kind',
      'answer',
      '--content-file',
      'FICHIER',
      '--as',
      'peer-a',
    ],
    'canal.poster': [
      'channel',
      'post',
      'general',
      '--kind',
      'status',
      '--content-file',
      'FICHIER',
      '--as',
      'peer-a',
    ],
  };
  for (const action of Object.keys(bases) as (keyof typeof bases)[]) {
    const r = await apercu(action, bases[action]);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      ok: true,
      aBlanc: true,
      argv: commandes[action],
      resume:
        action === 'carte.note'
          ? 'Note fyi sur la carte #3531, à peer-b'
          : action === 'dm.envoyer'
            ? 'DM answer à peer-b'
            : 'Post status sur le canal general',
      texte,
      rappel: action === 'carte.note' ? { obligations: [81] } : null,
    });
  }
  expect(journal()).toBe('board obligations list --card 3531 --json --as peer-a\n');
});
test('refus de schéma par action, DM à soi et action inconnue sans processus', async () => {
  const journal = await boot();
  for (const action of Object.keys(bases) as (keyof typeof bases)[])
    expect((await apercu(action, { ...bases[action], texte: '' })).json()).toEqual({
      ok: false,
      kind: 'schema',
      message: 'texte vide',
    });
  expect((await apercu('dm.envoyer', { ...bases['dm.envoyer'], pair: 'peer-a' })).json()).toEqual({
    ok: false,
    kind: 'schema',
    message: 'un DM ne peut pas viser ta propre cell',
  });
  expect((await apercu('autre', {})).statusCode).toBe(400);
  expect(journal()).toBe('');
});
test('nettoyage sans texte, avertissement canal, aucune lecture', async () => {
  const journal = await boot();
  for (const action of Object.keys(bases) as (keyof typeof bases)[]) {
    const r = await apercu(action, { ...bases[action], texte: 'Visiter aid-e2e.ts.net' });
    expect(r.json()).toEqual({
      ok: false,
      kind: 'nettoyage',
      message:
        'hôte privé' +
        (action === 'canal.poster' ? ' Ce post serait lu par tous les membres du canal.' : ''),
    });
    expect(r.body).not.toContain('aid-e2e.ts.net');
  }
  expect(journal()).toBe('');
});
test('rappel non bloquant : autre cell, lecture échouée, aucun cache', async () => {
  const journal = await boot();
  expect(
    (await apercu('carte.note', { ...bases['carte.note'], carte: 3532 })).json(),
  ).toMatchObject({ ok: true, rappel: null });
  await apercu('carte.note', bases['carte.note']);
  vi.stubEnv('FAKE_SWARPH_BOARD_ERROR', 'forbidden');
  expect((await apercu('carte.note', bases['carte.note'])).json()).toMatchObject({
    ok: true,
    rappel: { indisponible: true },
  });
  expect(journal().trim().split('\n')).toEqual(
    [3532, 3531, 3531].map((id) => `board obligations list --card ${id} --json --as peer-a`),
  );
});
test('mesh désactivé : 404', async () => {
  t = await startTestDaemon();
  expect((await apercu('canal.poster', bases['canal.poster'])).statusCode).toBe(404);
});

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { liensSwairm } from '../src/shared/swairm-board.js';
import { BoardReader } from '../src/daemon/mesh/board.js';
import { argumentsLectureValides } from '../src/daemon/mesh/proxy.js';
import { parseStatut, SwairmStatut } from '../src/daemon/swairm/statut.js';
import { lireBoardSwairm } from '../src/daemon/swairm/board.js';
import { creerFauxProxy } from './fixtures/faux-proxy.js';

const dossiers: string[] = [];
afterEach(() => {
  dossiers.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const sujet = (id = '12') => ({
  id,
  titre: 'Sujet',
  etat: 'futur',
  colonne: 'future',
  en_pause: false,
  pas: { total: 1, par_etat: { futur: 1 } },
  maj: '2026-11-10',
});
const statut = {
  format: 'swairm-status/1',
  projets: [
    {
      projet: 'exemple/depot',
      sujets: [sujet(), sujet('123'), sujet('sans')],
      vols: [{ cible: '12', machine: 'machine-a', pid: 1, depuis: '2026-11-10', tenant: 'futur' }],
    },
  ],
  erreurs: [{ projet: 'exemple/casse', board: '/tmp/board.db', erreur: 'illisible' }],
};
function script(contenu = `printf '%s' '${JSON.stringify(statut)}'`) {
  const dossier = mkdtempSync(join(tmpdir(), 'aid-statut-'));
  dossiers.push(dossier);
  const bin = join(dossier, 'swairm');
  writeFileSync(bin, `#!/bin/sh\n[ "$*" = 'status --json' ] || exit 2\n${contenu}\n`);
  chmodSync(bin, 0o700);
  return bin;
}
function lecteur(corps: unknown, extra = {}) {
  const read = vi.fn(async () => ({
    ok: true,
    timedOut: false,
    stdout: JSON.stringify(corps),
    stderr: '',
  }));
  return {
    read,
    board: new BoardReader({ mesh: { read }, cell: 'peer-a', log: () => undefined, ...extra }),
  };
}
const fixture = (dossier: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', dossier, 'cards-search.json'), 'utf8'),
  ) as unknown;

test('D285 : limites, caractères, espaces, préfixe et lignes CRLF', () => {
  const ligne = (owner: string, depot: string, id: string) => `Swairm: ${owner}/${depot}#${id}`;
  expect(liensSwairm(ligne('a'.repeat(100), 'b'.repeat(100), 'c'.repeat(200)))).toHaveLength(1);
  for (const args of [
    ['a'.repeat(101), 'b', '1'],
    ['a', 'b'.repeat(101), '1'],
    ['a', 'b', '1'.repeat(201)],
    ['', 'b', '1'],
    ['a', '', '1'],
    ['a', 'b', ''],
    ['a', 'b', 'é'],
  ])
    expect(liensSwairm(ligne(args[0]!, args[1]!, args[2]!))).toEqual([]);
  for (const texte of [' Swairm: a/b#12', 'Swairm: a/b#12 ', 'swairm: a/b#12', 'Swairm:  a/b#12'])
    expect(liensSwairm(texte)).toEqual([]);
  expect(liensSwairm('Swairm: a/b#12\r\ntexte\nSwairm: a/b#123\r')).toEqual([
    { projet: 'a/b', id: '12' },
    { projet: 'a/b', id: '123' },
  ]);
});

test('recherche CLI : corps, argv, fusion, cache et longueur maximale', async () => {
  let temps = 0;
  const { board, read } = lecteur(fixture('board'), { now: () => temps });
  const resultats = await Promise.all([
    board.chercherCartes('Swairm: '),
    board.chercherCartes('Swairm: '),
  ]);
  expect(resultats[0]).toMatchObject({
    ok: true,
    data: { searched: 10, cards: [{ body: 'Swairm: exemple/depot#12' }] },
  });
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0]).toEqual([
    ['board', 'cards', 'list', '--search', 'Swairm: ', '--json', '--as', 'peer-a'],
    undefined,
  ]);
  await board.chercherCartes('Swairm: ');
  expect(read).toHaveBeenCalledTimes(1);
  temps = 5000;
  await board.chercherCartes('Swairm: ');
  expect(read).toHaveBeenCalledTimes(2);
  expect(() => board.chercherCartes('x'.repeat(1001))).toThrow(RangeError);
  await board.chercherCartes('x'.repeat(1000));
});

test('recherche : searched doit être un compteur entier positif ou nul', async () => {
  for (const searched of ['Swairm: ', -1, 1.5, null, true, undefined]) {
    const { board } = lecteur({ cards: [], searched });
    expect(await board.chercherCartes('Swairm: ')).toMatchObject({ ok: false, kind: 'format' });
  }
  for (const searched of [0, 10]) {
    const { board } = lecteur({ cards: [], searched });
    expect(await board.chercherCartes('Swairm: ')).toMatchObject({
      ok: true,
      data: { cards: [], searched },
    });
  }
});

test('recherche proxy : corps gateway et q sans projet', async () => {
  const proxy = await creerFauxProxy({
    reponse: { ok: true, status: 200, body: fixture('proxy') },
  });
  try {
    const { board, read } = lecteur({}, { proxySocket: proxy.socket });
    expect(await board.chercherCartes('Swairm: ')).toMatchObject({
      ok: true,
      data: { searched: 10, cards: [{ body: 'Swairm: exemple/depot#12' }] },
    });
    expect(JSON.parse(proxy.lignes[0]!)).toMatchObject({
      verb: 'board.cards.list',
      args: { q: 'Swairm: ' },
    });
    expect(JSON.parse(proxy.lignes[0]!).args).not.toHaveProperty('project');
    const assemblage = await lireBoardSwairm(board, new SwairmStatut(script()));
    expect(assemblage.sujets[0]).toMatchObject({ id: '12', carte: 1 });
    expect(proxy.lignes).toHaveLength(1);
    expect(read).not.toHaveBeenCalled();
    expect(argumentsLectureValides('board.cards.list', { q: 'x'.repeat(1000) })).toBe(true);
    expect(argumentsLectureValides('board.cards.list', { q: 'x'.repeat(1001) })).toBe(false);
    expect(argumentsLectureValides('board.cards.list', { q: 1 })).toBe(false);
  } finally {
    await proxy.fermer();
  }
});

test('statut : contrat strict, extensions et erreurs conservées', () => {
  expect(parseStatut({ ...statut, inconnu: true })?.erreurs).toEqual(statut.erreurs);
  expect(parseStatut(statut)?.projets[0]?.sujets[0]?.etat).toBe('futur');
  for (const v of [
    null,
    {},
    { ...statut, format: 'swairm-status/2' },
    { ...statut, erreurs: [{}] },
    { ...statut, projets: [{ ...statut.projets[0], sujets: [{ ...sujet(), en_pause: 'non' }] }] },
    {
      ...statut,
      projets: [
        { ...statut.projets[0], sujets: [{ ...sujet(), pas: { total: '1', par_etat: {} } }] },
      ],
    },
  ])
    expect(parseStatut(v)).toBeNull();
});

test('statut : faux binaire, fusion, cache de 5 s et expiration', async () => {
  let temps = 0;
  const bin = script();
  const compteur = join(bin, '..', 'appels');
  writeFileSync(
    bin,
    readFileSync(bin, 'utf8').replace('[ "$*"', `echo appel >> '${compteur}'\n[ "$*"`),
  );
  const lecteur = new SwairmStatut(bin, { now: () => temps });
  const a = lecteur.lire();
  expect(lecteur.lire()).toBe(a);
  expect(await a).toMatchObject({ etat: 'ok' });
  await lecteur.lire();
  expect(readFileSync(compteur, 'utf8').trim().split('\n')).toHaveLength(1);
  temps = 5000;
  await lecteur.lire();
  expect(readFileSync(compteur, 'utf8').trim().split('\n')).toHaveLength(2);
});

test('statut : absent, non configuré, format, sortie en échec et délai', async () => {
  expect(await new SwairmStatut().lire()).toEqual({ etat: 'non-configure' });
  expect(await new SwairmStatut('/tmp/aid-binaire-inexistant/swairm').lire()).toEqual({
    etat: 'non-configure',
  });
  expect(await new SwairmStatut(script('echo {}')).lire()).toEqual({
    etat: 'erreur',
    erreur: 'format',
  });
  expect(await new SwairmStatut(script('exit 2')).lire()).toEqual({
    etat: 'erreur',
    erreur: 'lecture',
  });
  expect(await new SwairmStatut(script('exec sleep 1'), { delaiMs: 20 }).lire()).toEqual({
    etat: 'erreur',
    erreur: 'timeout',
  });
});

test('assemblage : lien exact, sans carte, conflit et vol ciblé', async () => {
  const { board } = lecteur({
    searched: 10,
    cards: [
      { id: 1, body: 'Swairm: exemple/depot#12' },
      { id: 2, body: 'Swairm: exemple/depot#123\nSwairm: exemple/depot#123' },
      { id: 3, body: 'Swairm: exemple/depot#123' },
    ],
  });
  const resultat = await lireBoardSwairm(board, new SwairmStatut(script()));
  expect(resultat.sujets).toMatchObject([
    { id: '12', carte: 1, conflit: [], vol: { cible: '12' } },
    { id: '123', carte: null, conflit: [2, 3], vol: null },
    { id: 'sans', carte: null, conflit: [], vol: null },
  ]);
  expect(resultat.cartes).toHaveLength(3);
});

test('assemblage : une erreur ne supprime pas la lecture réussie', async () => {
  const { board } = lecteur(fixture('board'));
  expect(await lireBoardSwairm(board, new SwairmStatut())).toMatchObject({
    sujets: [],
    cartes: [{ id: 1 }],
    swairm: { etat: 'non-configure' },
  });
  expect(await lireBoardSwairm(board, new SwairmStatut(script('exit 2')))).toMatchObject({
    sujets: [],
    cartes: [{ id: 1 }],
    swairm: { etat: 'erreur', erreur: 'lecture' },
  });
  const resultat = await lireBoardSwairm(lecteur({}).board, new SwairmStatut(script()));
  expect(resultat).toMatchObject({
    sujets: [
      { id: '12', carte: null },
      { id: '123', carte: null },
      { id: 'sans', carte: null },
    ],
    board: { ok: false, kind: 'format' },
    swairm: { etat: 'ok', data: { erreurs: statut.erreurs } },
  });
});

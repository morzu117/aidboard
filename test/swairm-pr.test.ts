import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { SwairmPr } from '../src/daemon/swairm/pr.js';
import { bloc } from './fixtures/swairm-trailers.js';

const dossiers: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  dossiers.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const pr = {
  number: 7,
  state: 'OPEN',
  mergedAt: null,
  headRefName: 'feat/exemple',
  isCrossRepository: false,
  headRepositoryOwner: { login: 'EXEMPLE' },
};
const commit = {
  oid: 'abcdef0123456789',
  committedDate: '2026-11-11T09:00:00Z',
  messageHeadline: 'pas s1',
  messageBody: bloc,
};
const vue = {
  number: 7,
  state: 'OPEN',
  url: 'https://github.com/exemple/depot/pull/7',
  commits: [
    commit,
    { ...commit, messageBody: bloc.replace('feat/exemple', 'autre') },
    { ...commit, messageBody: 'sans trailers' },
  ],
};
function faux(liste: unknown = [pr], detail: unknown = vue, code?: string) {
  const dossier = mkdtempSync(join(tmpdir(), 'aid-gh-'));
  dossiers.push(dossier);
  const bin = join(dossier, 'gh');
  writeFileSync(join(dossier, 'liste.json'), JSON.stringify(liste));
  writeFileSync(join(dossier, 'vue.json'), JSON.stringify(detail));
  writeFileSync(
    bin,
    `#!/bin/sh\ncd '${dossier}' || exit 2\nprintf '%s\\n' "$@" >> appels\n${code ?? 'case "$2" in\nlist) cat liste.json ;;\nview) cat vue.json ;;\n*) exit 2 ;;\nesac'}\n`,
  );
  chmodSync(bin, 0o700);
  return { bin, dossier };
}

test('PR trouvée, argv, filtrage du sujet, fusion et cache de 60 s', async () => {
  const { bin, dossier } = faux();
  let temps = 0;
  const lecteur = new SwairmPr(bin, { now: () => temps });
  const premiere = lecteur.lire('exemple/depot', 'feat/exemple');
  expect(lecteur.lire('exemple/depot', 'feat/exemple')).toBe(premiere);
  expect(await premiere).toEqual({
    etat: 'ok',
    pr: { number: 7, state: 'OPEN', url: vue.url },
    commits: [
      {
        sha: commit.oid,
        date: commit.committedDate,
        step: 's1',
        proof: 'passed',
        attempt: 3,
        drone: null,
      },
    ],
  });
  const argv = readFileSync(join(dossier, 'appels'), 'utf8').trim().split('\n');
  expect(argv).toEqual([
    'pr',
    'list',
    '-R',
    'exemple/depot',
    '--head',
    'feat/exemple',
    '--state',
    'all',
    '--json',
    'number,headRefName,title,body,isCrossRepository,headRepositoryOwner,state,mergedAt',
    '--limit',
    '50',
    'pr',
    'view',
    '7',
    '-R',
    'exemple/depot',
    '--json',
    'number,state,url,commits',
  ]);
  temps = 59999;
  await lecteur.lire('exemple/depot', 'feat/exemple');
  expect(readFileSync(join(dossier, 'appels'), 'utf8').trim().split('\n')).toHaveLength(
    argv.length,
  );
  temps = 60000;
  await lecteur.lire('exemple/depot', 'feat/exemple');
  expect(readFileSync(join(dossier, 'appels'), 'utf8').trim().split('\n')).toHaveLength(
    argv.length * 2,
  );
});

test('aucune PR, forks et autre propriétaire ou branche ignorés', async () => {
  for (const liste of [
    [],
    [{ ...pr, isCrossRepository: true }],
    [{ ...pr, headRepositoryOwner: { login: 'autre' } }],
    [{ ...pr, headRefName: 'autre' }],
  ]) {
    const { bin } = faux(liste);
    expect(await new SwairmPr(bin).lire('exemple/depot', 'feat/exemple')).toEqual({
      etat: 'ok',
      pr: null,
      commits: [],
    });
  }
  const { bin } = faux([{ ...pr, isCrossRepository: true }, pr]);
  expect(await new SwairmPr(bin).lire('exemple/depot', 'feat/exemple')).toMatchObject({
    etat: 'ok',
    pr: { number: 7 },
  });
});

test('plusieurs PR ouvertes : refus de choisir', async () => {
  const { bin } = faux([pr, { ...pr, number: 8 }]);
  expect(await new SwairmPr(bin).lire('exemple/depot', 'feat/exemple')).toMatchObject({
    etat: 'non-lu',
    raison: 'plusieurs PR ouvertes',
  });
});

test('gh absent, en échec, délai dépassé et sortie illisible : jamais une exception', async () => {
  for (const [lecteur, raison] of [
    [new SwairmPr('/tmp/aid-gh-inexistant/gh'), 'gh absent'],
    [new SwairmPr(faux([], vue, 'exit 2').bin), 'échec de gh'],
    [new SwairmPr(faux([], vue, 'exec sleep 1').bin, { delaiMs: 20 }), 'délai dépassé'],
    [new SwairmPr(faux([], vue, 'echo invalide').bin), 'format illisible'],
    [new SwairmPr(faux({}).bin), 'format illisible'],
    [new SwairmPr(faux([pr], {}).bin), 'format illisible'],
  ] as const)
    expect(await lecteur.lire('exemple/depot', 'feat/exemple')).toEqual({
      pr: null,
      commits: [],
      etat: 'non-lu',
      raison,
    });
});

test('validation D285 avant tout appel et URL dangereuse supprimée', async () => {
  const lecteur = new SwairmPr('/tmp/aid-gh-inexistant/gh');
  for (const [projet, sujet] of [
    ['a/b/c', 's'],
    ['a/b', 's\n'],
    ['a/b\n', 's'],
    ['a/b', '$(id)'],
    ['a/b', 's'.repeat(201)],
    ['a'.repeat(101) + '/b', 's'],
  ])
    expect(await lecteur.lire(projet!, sujet!)).toMatchObject({
      etat: 'non-lu',
      raison: 'identifiants invalides',
    });
  const { bin } = faux([pr], {
    ...vue,
    url: 'javascript:alert(1)',
    commits: [{ ...commit, messageBody: bloc + '\nSwairm-Drone: machine-a/42@2026-11-11' }],
  });
  const resultat = await new SwairmPr(bin).lire('exemple/depot', 'feat/exemple');
  expect(resultat.pr).toEqual({ number: 7, state: 'OPEN' });
  expect(resultat.commits[0]?.drone).toBe('machine-a/42@2026-11-11');
});

test('github.bin vide utilise gh dans le PATH ; délai et échec de pr view sont non bloquants', async () => {
  const { dossier } = faux();
  vi.stubEnv('PATH', `${dossier}:${process.env.PATH ?? ''}`);
  expect(await new SwairmPr().lire('exemple/depot', 'feat/exemple')).toMatchObject({
    etat: 'ok',
    pr: { number: 7 },
  });
  for (const [code, raison] of [
    ['exec sleep 1', 'délai dépassé'],
    ['exit 2', 'échec de gh'],
  ] as const) {
    const { bin } = faux(
      [pr],
      vue,
      `case "$2" in
list) cat liste.json ;;
view) ${code} ;;
esac`,
    );
    expect(
      await new SwairmPr(bin, { delaiMs: 100 }).lire('exemple/depot', 'feat/exemple'),
    ).toMatchObject({ etat: 'non-lu', raison });
  }
});

const mergee = { ...pr, state: 'MERGED', mergedAt: '2026-11-11T09:00:00Z' };

test('sujet mergé : retrouve sa PR mergée et ses commits après la fermeture', async () => {
  const { bin } = faux([mergee], { ...vue, state: 'MERGED' });
  const resultat = await new SwairmPr(bin).lire('exemple/depot', 'feat/exemple');
  expect(resultat).toMatchObject({ etat: 'ok', pr: { number: 7, state: 'MERGED' } });
  expect(resultat.commits).toHaveLength(1);
});

test('PR fermée sans merge : ignorée', async () => {
  const { bin, dossier } = faux([{ ...pr, state: 'CLOSED' }]);
  expect(await new SwairmPr(bin).lire('exemple/depot', 'feat/exemple')).toEqual({
    etat: 'ok',
    pr: null,
    commits: [],
  });
  expect(readFileSync(join(dossier, 'appels'), 'utf8').split('\n')).not.toContain('view');
});

test('une PR ouverte gagne sur une PR mergée plus récente et de numéro supérieur', async () => {
  const { bin } = faux([{ ...mergee, number: 8 }, pr]);
  expect(await new SwairmPr(bin).lire('exemple/depot', 'feat/exemple')).toMatchObject({
    etat: 'ok',
    pr: { number: 7, state: 'OPEN' },
  });
});

test.each([false, true])(
  'deux PR mergées : date la plus récente, puis numéro décroissant (égalité : %s)',
  async (egalite) => {
    const recente = { ...mergee, number: 8 };
    const autre = {
      ...mergee,
      number: egalite ? 6 : 9,
      mergedAt: egalite ? mergee.mergedAt : '2026-11-10T09:00:00Z',
    };
    for (const liste of [
      [autre, recente],
      [recente, autre],
    ]) {
      const { bin } = faux(liste, { ...vue, number: 8, state: 'MERGED' });
      expect(await new SwairmPr(bin).lire('exemple/depot', 'feat/exemple')).toMatchObject({
        etat: 'ok',
        pr: { number: 8, state: 'MERGED' },
      });
    }
  },
);

test('limite atteinte : non-lu explicite, aucun choix silencieux même après filtrage des forks', async () => {
  const liste = [
    pr,
    ...Array.from({ length: 49 }, (_, i) => ({ ...pr, number: i + 8, isCrossRepository: true })),
  ];
  const { bin, dossier } = faux(liste);
  expect(await new SwairmPr(bin).lire('exemple/depot', 'feat/exemple')).toMatchObject({
    pr: null,
    commits: [],
    etat: 'non-lu',
    raison: 'limite de 50 PR atteinte : liste potentiellement incomplète',
  });
  expect(readFileSync(join(dossier, 'appels'), 'utf8').split('\n')).not.toContain('view');
});

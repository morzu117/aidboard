import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const fixtures = join(import.meta.dirname, 'fixtures');
const codegraph = [
  'codegraph',
  '--local',
  '--json',
  '--limit',
  '50',
  '--caller-cell',
  'morzu-mac',
  '--',
  'lecture test',
];
const lectures: [string[], string][] = [
  [['mesh', 'peers', '--as', 'morzu-mac'], 'mesh-peers.txt'],
  [['rights', '--json', '--as', 'morzu-mac'], 'rights.json'],
  [codegraph, 'codegraph-lecture_test.json'],
  [['memory', 'list', '-n', '100', '--json'], 'memory-list.json'],
  [['memory', 'list', '--type', 'note', '-n', '100', '--json'], 'memory-list-type-note.json'],
  [['memory', 'list', '--tag', 'test', '-n', '100', '--json'], 'memory-list-test.json'],
  [['memory', 'get', 'page-test', '--json'], 'memory-get-page-test.json'],
  [
    ['memory', 'links', 'page-test', '--direction', 'both', '--json'],
    'memory-links-page-test.json',
  ],
];

function lancer(args: string[], environnement: Record<string, string> = {}) {
  return spawnSync(join(fixtures, 'fake-swarph.sh'), args, {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      FAKE_SWARPH_BOARD: join(fixtures, 'board'),
      ...environnement,
    },
  });
}

test.each(lectures)('lecture exacte %j depuis %s, refus des variantes et 404', (args, fichier) => {
  const resultat = lancer(args);
  expect(resultat.status).toBe(0);
  expect(resultat.stderr).toBe('');
  expect(resultat.stdout).toBe(readFileSync(join(fixtures, 'board', fichier), 'utf8'));
  for (let i = 0; i < args.length; i++) {
    expect(lancer(args.filter((_, position) => position !== i)).status).toBe(2);
  }
  expect(lancer([...args, '--token-file', 'interdit']).status).toBe(2);
  const absent = lancer(args, { FAKE_SWARPH_BOARD: join(fixtures, 'absent') });
  expect(absent.status).toBe(1);
  expect(absent.stderr).toBe('swarph board: gateway 404: not found\n');
});

test('refus des options, valeurs et ordres hors contrat', () => {
  const refus = [
    ['mesh', 'peers', '--json', '--as', 'morzu-mac'],
    ['rights', 'peer-a', '--json', '--as', 'morzu-mac'],
    ['rights', '--as', 'morzu-mac', '--json'],
    ['memory', 'links', 'page-test', '--direction', 'outgoing', '--json'],
    ['memory', 'get', '../page-test', '--json'],
    ['memory', 'list', '--tag', 'test', '-n', 'non-entier', '--json'],
    ['memory', 'list', '--tag', 'test', '-n', '0', '--json'],
    ...['-x', '', 'ligne\nsuivante', 'x'.repeat(201)].map((requete) => [
      ...codegraph.slice(0, -1),
      requete,
    ]),
    codegraph.map((arg) => (arg === '50' ? 'non-entier' : arg)),
    ['memory', 'put', 'page-test', '--json'],
  ];
  for (const args of refus) expect(lancer(args).status, JSON.stringify(args)).toBe(2);
});

test('codegraph sans index ou avec index périmé', () => {
  const args = codegraph;
  const absent = lancer(args, { FAKE_SWARPH_CODEGRAPH_MODE: 'no-index' });
  expect(absent.status).toBe(1);
  expect(absent.stdout).toBe('');
  expect(absent.stderr).toBe('NO INDEX AVAILABLE\n');
  const perime = lancer(args, { FAKE_SWARPH_CODEGRAPH_MODE: 'stale' });
  expect(perime.status).toBe(0);
  expect(perime.stderr).toBe('STALE INDEX\n');
  expect(perime.stdout).toBe(lancer(args).stdout);
});

test.each(['forbidden', 'unreachable', 'credential', 'other', 'too-old'])(
  'le mode partagé %s s’applique aux six lectures',
  (mode) => {
    for (const [args] of lectures) {
      const resultat = lancer(args, { FAKE_SWARPH_BOARD_ERROR: mode });
      expect(resultat.status).toBe(mode === 'too-old' ? 2 : 1);
      expect(resultat.stdout).toBe('');
      expect(resultat.stderr).not.toBe('');
    }
  },
);

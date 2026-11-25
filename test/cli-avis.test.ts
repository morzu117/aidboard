import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { parse } from 'yaml';
import { runAvis } from '../src/cli/commands/avis.js';
import { resolvePaths } from '../src/daemon/paths.js';
import { modelesAvis, routage } from '../src/shared/routage.js';
import { parseAsk, parseAsks } from '../src/shared/swairm-ask.js';

const archive = parseAsk(
  JSON.parse(readFileSync('test/fixtures/swairm/show-20261109T071500Z-3f2a.json', 'utf8')),
)!;
const donnees = {
  ...archive,
  avis: [{ ...archive.avis[0]!, modele_demande: 'claude:sonnet', etat: 'ok', cout_usd: 0.04 }],
  accord: [{ n: 1, accord: 'unanime', verdict: 'oui', compte: { oui: 1 } }],
  cout_total_usd: 0.04,
};
const appel = vi.fn<typeof fetch>();
const repondre = (json: unknown, status = 200) =>
  appel.mockResolvedValue(new Response(JSON.stringify(json), { status }));
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aid-cli-avis-'));
  vi.stubEnv('AID_HOME', home);
  vi.stubEnv('AID_URL', 'http://127.0.0.1:1234');
  vi.stubEnv('AID_TOKEN', 'jeton-test');
  appel.mockReset();
  vi.stubGlobal('fetch', appel);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const lancer = (...args: string[]) => runAvis(['Faut-il vérifier ?', ...args], resolvePaths());

test('texte, options et en-tête de confirmation, sortie 0', async () => {
  repondre({ ok: true, data: donnees });
  expect(
    await lancer(
      '--niveau',
      'leger',
      '--n',
      '2',
      '--budget',
      '0.4',
      '--sous-question',
      'Une ?',
      '--sous-question',
      'Deux ?',
    ),
  ).toBe(0);
  const [url, options] = appel.mock.calls[0]!;
  expect(url).toBe('http://127.0.0.1:1234/api/swairm/ask');
  expect(options).toMatchObject({
    method: 'POST',
    headers: { 'X-AID-Confirm': 'ask', authorization: 'Bearer jeton-test' },
  });
  expect(JSON.parse(String(options?.body))).toEqual({
    question: 'Faut-il vérifier ?',
    n: 2,
    modeles: ['claude:haiku'],
    sousQuestions: [
      { n: 1, texte: 'Une ?' },
      { n: 2, texte: 'Deux ?' },
    ],
    budgetUsd: 0.4,
  });
  expect(vi.mocked(console.log).mock.calls.flat()).toEqual([
    'claude\tsonnet\tok\t0.04 USD',
    'n\taccord\tverdict\tcompte',
    '1\tunanime\toui\toui=1',
    'Coût total 0.04 USD',
  ]);
});

test('challenge fort sur trois fournisseurs et sortie JSON swairm-ask/1', async () => {
  repondre({ ok: true, data: donnees });
  expect(await lancer('--json', '--challenge', '--niveau', 'leger', '--n', '5')).toBe(0);
  expect(JSON.parse(String(appel.mock.calls[0]?.[1]?.body))).toMatchObject({
    n: 3,
    modeles: ['claude:opus', 'codex:defaut', 'vibe:defaut'],
  });
  expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toMatchObject({
    format: 'swairm-ask/1',
    id: archive.id,
  });
});

test.each(['partage', 'insuffisant'])('accord %s et coût inconnu, sortie 4', async (accord) => {
  repondre({
    ok: true,
    data: {
      ...donnees,
      avis: [{ ...donnees.avis[0], cout_usd: null }],
      accord: [...donnees.accord, { n: 2, accord, verdict: null, compte: {} }],
    },
  });
  expect(await lancer()).toBe(4);
  expect(JSON.parse(String(appel.mock.calls[0]?.[1]?.body))).toMatchObject({
    n: 3,
    modeles: ['claude:sonnet'],
  });
  expect(console.log).toHaveBeenCalledWith('Coût total inconnu');
});

test('aucun avis valide, sortie 3 et archive JSON', async () => {
  repondre({
    ok: false,
    kind: 'aucun-avis',
    data: { ...donnees, avis: [{ ...donnees.avis[0], etat: 'echec' }] },
  });
  expect(await lancer('--json')).toBe(3);
  expect(console.log).toHaveBeenCalledOnce();
});

test('refus ou erreur HTTP, sortie 2', async () => {
  repondre({ ok: false, kind: 'refusee', message: 'hôte privé' });
  expect(await lancer()).toBe(2);
  expect(console.error).toHaveBeenCalledWith('question refusée : hôte privé');
  repondre({ error: 'demande déjà en cours' }, 409);
  expect(await lancer()).toBe(2);
  expect(console.log).not.toHaveBeenCalled();
});

test('la table utilisée par le CLI est alignée sur les défauts du noyau', () => {
  const defaults = parse(readFileSync('kernel/defaults.yml', 'utf8'));
  expect(defaults.routage).toEqual(routage);
  expect(modelesAvis('leger', false)).toEqual(['claude:haiku']);
  expect(modelesAvis('standard', false)).toEqual(['claude:sonnet']);
  expect(modelesAvis('fort', false)).toEqual(['claude:opus']);
  expect(modelesAvis('standard', true)).toEqual(['claude:opus', 'codex:defaut', 'vibe:defaut']);
});

test('contrats : champs inconnus ignorés, limites et formes inattendues', () => {
  const brut = JSON.parse(readFileSync('test/fixtures/swairm/ask-ok.json', 'utf8'));
  brut.inconnu = true;
  brut.question = 'q'.repeat(21000);
  brut.avis[0].reponses[0].justification = 'j'.repeat(700);
  brut.avis[0].brut = 'b'.repeat(5000);
  const a = parseAsk(brut)!;
  expect(a.question).toHaveLength(20000);
  expect(a.avis[0]!.reponses[0]!.justification).toHaveLength(600);
  expect(a.avis[0]!.brut).toHaveLength(4000);
  expect(a).not.toHaveProperty('inconnu');
  expect(a).not.toHaveProperty('schemaVersion');
  for (const valeur of [
    null,
    [],
    {},
    { ...brut, id: '../x' },
    { ...brut, avis: [{}] },
    { ...brut, accord: [{}] },
    { ...brut, cout_total_usd: '0' },
  ])
    expect(parseAsk(valeur)).toBeNull();
  const liste = JSON.parse(readFileSync('test/fixtures/swairm/asks.json', 'utf8'));
  liste.ajout = 1;
  liste.demandes[0].question = 'x'.repeat(300);
  expect(parseAsks(liste)?.demandes[0]?.question).toHaveLength(200);
  for (const valeur of [
    null,
    {},
    { ...liste, erreurs: [{}] },
    { ...liste, demandes: [{ id: '../x' }] },
  ])
    expect(parseAsks(valeur)).toBeNull();
});

test.each([
  ['echec', 'CLI absent', 'CLI absent'],
  ['delai', null, 'Délai dépassé'],
  ['echec', null, 'Échec du CLI'],
])('la sortie texte nomme l’échec %s (%s)', async (etat, brut, message) => {
  repondre({
    ok: false,
    kind: 'aucun-avis',
    data: { ...donnees, avis: [{ ...donnees.avis[0], etat, brut, cout_usd: null }] },
  });
  expect(await lancer()).toBe(3);
  expect(console.log).toHaveBeenCalledWith(`claude\tsonnet\t${message}\tinconnu`);
});

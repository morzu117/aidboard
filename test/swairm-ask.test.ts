import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { AskOccupe, SwairmAsk } from '../src/daemon/swairm/ask.js';
import { parseAsk, parseAsks } from '../src/shared/swairm-ask.js';

const bin = join(import.meta.dirname, 'fixtures/fake-swairm.sh');
const fixtures = join(import.meta.dirname, 'fixtures/swairm');
const demande = {
  question: 'Une question UTF-8 ; $(echo exemple)',
  n: 3,
  modeles: ['sonnet', 'opus'] as ('sonnet' | 'opus')[],
};
const dossiers: string[] = [];
afterEach(() => {
  for (const d of dossiers.splice(0)) rmSync(d, { recursive: true, force: true });
});
function lecteur(mode = 'ok', timeoutMs?: number) {
  const dossier = mkdtempSync(join(tmpdir(), 'aid-test-ask-'));
  dossiers.push(dossier);
  const copie = join(dossier, 'copie');
  const log = join(dossier, 'argv');
  const envLog = join(dossier, 'env');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FAKE_SWAIRM_ASK_MODE: mode,
    FAKE_SWAIRM_ASK_COPY: copie,
    FAKE_SWAIRM_LOG: log,
    FAKE_SWAIRM_ASK_ENV: envLog,
  };
  for (const cle of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'OPENAI_API_KEY',
    'GH_TOKEN',
  ])
    env[cle] = 'valeur-synthetique';
  return { service: new SwairmAsk(bin, { env, timeoutMs }), copie, log, envLog };
}
const lire = (f: string) => readFileSync(f, 'utf8');
async function attendre(f: string) {
  for (let i = 0; i < 200 && !existsSync(f); i++) await new Promise((r) => setTimeout(r, 10));
  expect(existsSync(f)).toBe(true);
}

test('contrats : champs inconnus ignorés, limites et formes inattendues', () => {
  const brut = JSON.parse(lire(join(fixtures, 'ask-ok.json')));
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
  const liste = JSON.parse(lire(join(fixtures, 'asks.json')));
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

test('succès : argv, question exacte, permissions, nettoyage, clés retirées, lectures', async () => {
  const { service, copie, log, envLog } = lecteur();
  expect(await service.demander(demande)).toMatchObject({
    ok: true,
    data: { format: 'swairm-ask/1' },
    readAt: expect.any(String),
  });
  const chemin = lire(copie + '.path');
  expect(lire(copie)).toBe(demande.question);
  expect(lire(copie + '.mode').trim()).toBe('600');
  expect(lire(copie + '.dir-mode').trim()).toBe('700');
  expect(existsSync(chemin)).toBe(false);
  expect(existsSync(join(chemin, '..'))).toBe(false);
  expect(lire(log)).toBe(`ask --n 3 --modeles sonnet,opus --question-file ${chemin} --json\n`);
  expect(lire(envLog).trim().split('\n')).toEqual([
    'ANTHROPIC_API_KEY=unset',
    'ANTHROPIC_AUTH_TOKEN=unset',
    'CLAUDE_CODE_OAUTH_TOKEN=unset',
    'OPENAI_API_KEY=unset',
    'GH_TOKEN=unset',
  ]);
  expect(await service.liste()).toMatchObject({ ok: true, data: { format: 'swairm-asks/1' } });
  expect(await service.relire('20261109T071500Z-3f2a')).toMatchObject({ ok: true });
  expect(lire(log).split('\n').slice(1, 3)).toEqual([
    'ask --list --json',
    'ask --show 20261109T071500Z-3f2a --json',
  ]);
  expect(() => service.relire('../x')).toThrow(RangeError);
});

test.each([
  ['refus', 'refusee'],
  ['ancien', 'too-old'],
  ['aucun', 'aucun-avis'],
  ['format', 'format'],
] as const)('%s : résultat discriminé et fichier supprimé', async (mode, kind) => {
  const { service, copie } = lecteur(mode);
  const resultat = await service.demander(demande);
  expect(resultat).toMatchObject({ ok: false, kind });
  if (mode === 'refus') expect(resultat).toHaveProperty('message', 'ressemble à une clé API');
  if (mode === 'aucun') expect(resultat).toHaveProperty('data.format', 'swairm-ask/1');
  expect(existsSync(lire(copie + '.path'))).toBe(false);
});

test('absent et erreur inconnue', async () => {
  expect(await new SwairmAsk('/binaire-absent-synthetique').liste()).toMatchObject({
    ok: false,
    kind: 'absent',
  });
  expect(await new SwairmAsk('/bin/false').liste()).toMatchObject({ ok: false, kind: 'unknown' });
});

test('délai et suppression', async () => {
  const { service, copie } = lecteur('lent', 200);
  expect(await service.demander(demande)).toMatchObject({ ok: false, kind: 'timeout' });
  expect(existsSync(lire(copie + '.path'))).toBe(false);
});

test('exclusion, état, annulation et suppression', async () => {
  const { service, copie } = lecteur('lent');
  const resultat = service.demander(demande);
  await attendre(copie + '.path');
  expect(service.etat()).toMatchObject({
    enCours: true,
    depuis: expect.any(String),
    budgetUsd: 0.5,
  });
  await expect(service.demander(demande)).rejects.toBeInstanceOf(AskOccupe);
  service.annuler();
  expect(await resultat).toMatchObject({ ok: false, kind: 'annule' });
  expect(existsSync(lire(copie + '.path'))).toBe(false);
  expect(service.etat()).toEqual({ enCours: false, depuis: null, budgetUsd: 0.5 });
});

test('annuler arrête aussi les petits-enfants de swairm (les avis claude -p)', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'aid-test-enfant-'));
  dossiers.push(temp);
  const pidFichier = join(temp, 'enfant.pid');
  // lecteur() copie process.env à sa construction : la variable doit être posée avant
  process.env.FAKE_SWAIRM_ENFANT_PID = pidFichier;
  const { service, copie } = lecteur('enfant');
  try {
    const resultat = service.demander(demande);
    await attendre(copie + '.path');
    await attendre(pidFichier);
    const pid = Number(lire(pidFichier).trim());
    expect(vivant(pid)).toBe(true);
    service.annuler();
    expect(await resultat).toMatchObject({ ok: false, kind: 'annule' });
    const fin = Date.now() + 2000;
    while (vivant(pid) && Date.now() < fin) await new Promise((r) => setTimeout(r, 20));
    expect(vivant(pid)).toBe(false);
  } finally {
    delete process.env.FAKE_SWAIRM_ENFANT_PID;
  }
});

function vivant(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test.each([
  { n: 0 },
  { n: 6 },
  { n: 1.5 },
  { question: '' },
  { question: ' ' },
  { question: 'x'.repeat(20001) },
  { modeles: [] },
  { modeles: ['autre'] },
])('entrée invalide sans lancement : %o', async (changement) => {
  const { service, log } = lecteur();
  await expect(
    service.demander({ ...demande, ...changement } as typeof demande),
  ).rejects.toBeInstanceOf(RangeError);
  expect(existsSync(log)).toBe(false);
});

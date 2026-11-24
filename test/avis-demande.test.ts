import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { lancerAvis, liste, type DemandeAvis } from '../src/daemon/avis/demande.js';
import { lancerFournisseur } from '../src/daemon/avis/fournisseurs.js';
import { AskOccupe, ServiceAvis, validerDemande } from '../src/daemon/avis/service.js';
import { construirePrompt } from '../src/daemon/avis/prompt.js';
import { parseAsk } from '../src/shared/swairm-ask.js';

const question = 'Faut-il vérifier les tests ?';
const reponse = JSON.stringify({
  reponses: [{ n: 1, verdict: 'oui', justification: 'Un avis.' }],
});
const enveloppe = JSON.stringify({
  type: 'result',
  subtype: 'success',
  result: reponse,
  total_cost_usd: 0.04,
  duration_ms: 1234,
  modelUsage: {
    premier: { costUSD: 0.01 },
    second: { costUSD: 0.03, canonicalModel: 'sonnet-test' },
  },
});

let racine: string;
let dossier: string;
let env: NodeJS.ProcessEnv;
const strip = ['CLE_PROJET'];

beforeEach(async () => {
  racine = await mkdtemp(join(tmpdir(), 'aid-test-avis-'));
  dossier = join(racine, 'archives');
  const bin = join(racine, 'bin');
  await mkdir(bin);
  env = {
    PATH: bin,
    AID_HOME: racine,
    HOME: racine,
    TRACES: racine,
    ANTHROPIC_API_KEY: 'faux',
    ANTHROPIC_AUTH_TOKEN: 'faux',
    ANTHROPIC_BASE_URL: 'faux',
    OPENAI_API_KEY: 'faux',
    MISTRAL_API_KEY: 'faux',
    CLE_PROJET: 'faux',
    CLAUDE_CODE_OAUTH_TOKEN: 'faux',
    GH_TOKEN: 'faux',
    REPONSE: reponse,
    ENVELOPPE: enveloppe,
    VIBE_JSON: JSON.stringify([{ role: 'assistant', content: reponse }]),
  };
  const trace = String.raw`
nom=$(/usr/bin/basename "$0")
printf '%s\0' "$@" > "$TRACES/$nom.argv"
printf '%s' "$PWD" > "$TRACES/$nom.cwd"
printf '%s' "$$" > "$TRACES/$nom.pid"
/bin/ls -A > "$TRACES/$nom.contenu"
/usr/bin/env > "$TRACES/$nom.env"
`;
  const scripts = {
    claude: `
case "$MODE" in
  delai) exec /bin/sleep 10 ;;
  budget) printf '%s' '{"type":"result","subtype":"error_max_budget_usd"}'; exit 1 ;;
  echec) printf '%s' "$ENVELOPPE"; exit 1 ;;
esac
printf 'avertissement\n%s\n{}' "$ENVELOPPE"`,
    codex: `
/bin/cat > "$TRACES/codex.stdin"
while [ "$1" != "-o" ]; do shift; done
printf '%s' "$REPONSE" > "$2"
printf 'La réponse est dans le fichier.'`,
    vibe: `printf '%s' "$VIBE_JSON"`,
  };
  await Promise.all(
    Object.entries(scripts).map(([nom, script]) =>
      writeFile(join(bin, nom), '#!/bin/sh\n' + trace + script + '\n', { mode: 0o700 }),
    ),
  );
});

afterEach(async () => {
  await rm(racine, { recursive: true, force: true });
});

const options = { question, budgetUsd: 0.5, delaiMs: 5000 };
const fournisseurs: DemandeAvis['avis'] = [
  { fournisseur: 'claude', modele: 'sonnet' },
  { fournisseur: 'codex', modele: 'modele:test-1.0' },
  { fournisseur: 'vibe', modele: 'defaut' },
];

test('trois fournisseurs isolés, argv exact, archive privée relisible', async () => {
  const resultat = await lancerAvis({ ...options, avis: fournisseurs }, { dossier, env, strip });
  expect(resultat.id).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{4}$/);
  expect(
    resultat.avis.map((a) => [a.i, a.modele_demande, a.modele_servi, a.etat, a.cout_usd]),
  ).toEqual([
    [1, 'claude:sonnet', 'sonnet-test', 'ok', 0.04],
    [2, 'codex:modele:test-1.0', 'modele:test-1.0', 'ok', null],
    [3, 'vibe:defaut', null, 'ok', null],
  ]);
  expect(resultat.avis[0]?.duree_s).toBe(1.234);
  expect(resultat.avis.map((a) => a.reponses)).toEqual(Array(3).fill(JSON.parse(reponse).reponses));
  expect(resultat.cout_total_usd).toBe(0.04);
  expect(resultat.accord).toEqual([
    { n: 1, accord: 'unanime', verdict: 'oui', compte: { oui: 3 } },
  ]);
  const fichier = join(dossier, resultat.id + '.json');
  expect(parseAsk(JSON.parse(await readFile(fichier, 'utf8')))).toEqual(resultat);
  expect((await stat(fichier)).mode & 0o777).toBe(0o600);
  expect((await stat(dossier)).mode & 0o777).toBe(0o700);

  const prompt = construirePrompt(question);
  const lireTrace = (nom: string) => readFile(join(racine, nom), 'utf8');
  const codexCwd = await lireTrace('codex.cwd');
  const argv = {
    claude: [
      '-p',
      prompt,
      '--tools',
      '',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--permission-mode',
      'dontAsk',
      '--model',
      'sonnet',
      '--max-budget-usd',
      '0.5',
      '--output-format',
      'json',
    ],
    codex: [
      'exec',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '-m',
      'modele:test-1.0',
      '-o',
      join(codexCwd, 'avis.txt'),
      '-',
    ],
    vibe: [
      '-p',
      prompt,
      '--max-turns',
      '1',
      '--output',
      'json',
      '--max-price',
      '0.5',
      '--enabled-tools',
      '',
    ],
  };
  expect(await lireTrace('codex.stdin')).toBe(prompt);
  const cwds = new Set<string>();
  for (const { fournisseur } of fournisseurs) {
    expect((await lireTrace(fournisseur + '.argv')).split('\0').slice(0, -1)).toEqual(
      argv[fournisseur],
    );
    expect(await lireTrace(fournisseur + '.contenu')).toBe('');
    const cwd = await lireTrace(fournisseur + '.cwd');
    cwds.add(cwd);
    await expect(access(cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    const environnement = await lireTrace(fournisseur + '.env');
    expect(environnement).toContain('AID_HOME=' + racine);
    expect(environnement).not.toMatch(
      /^(?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|OPENAI_API_KEY|MISTRAL_API_KEY|CLE_PROJET|CLAUDE_CODE_OAUTH_TOKEN|GH_TOKEN)=/m,
    );
  }
  expect(cwds.size).toBe(3);

  await writeFile(join(dossier, 'casse.json'), 'illisible');
  expect(await liste(dossier)).toEqual({
    format: 'swairm-asks/1',
    demandes: [
      { id: resultat.id, genere_a: resultat.genere_a, question, n: 3, accord: resultat.accord },
    ],
    erreurs: [{ fichier: 'casse.json', erreur: 'Demande illisible.' }],
  });
  expect(await liste(join(dossier, 'absent'))).toMatchObject({ demandes: [], erreurs: [] });
});

test('un CLI absent laisse les autres avis se terminer', async () => {
  await rm(join(env.PATH!, 'claude'));
  const resultat = await lancerAvis({ ...options, avis: fournisseurs }, { dossier, env });
  expect(resultat.avis[0]).toMatchObject({ etat: 'echec', brut: 'CLI absent', reponses: [] });
  expect(resultat.avis.slice(1).map((a) => a.etat)).toEqual(['ok', 'ok']);
});

test('délai injectable, processus tué puis cwd supprimé', async () => {
  const resultat = await lancerFournisseur(
    'claude',
    { ...options, prompt: question, modele: 'haiku', delaiMs: 300 },
    { env: { ...env, MODE: 'delai' } },
  );
  expect(resultat).toMatchObject({ etat: 'delai', duree_s: null, texte: '' });
  const cwd = await readFile(join(racine, 'claude.cwd'), 'utf8');
  const pid = Number(await readFile(join(racine, 'claude.pid'), 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  await expect(access(cwd)).rejects.toMatchObject({ code: 'ENOENT' });
});

test.each([
  ['budget', 'budget'],
  ['echec', 'echec'],
])('enveloppe Claude avec code non nul (%s)', async (mode, etat) => {
  const resultat = await lancerFournisseur(
    'claude',
    { ...options, prompt: question, modele: 'opus' },
    { env: { ...env, MODE: mode } },
  );
  expect(resultat.etat).toBe(etat);
});

test('le modèle Codex invalide est refusé avant tout appel', async () => {
  const avis = [...fournisseurs, { fournisseur: 'codex', modele: 'x y' } as const];
  await expect(lancerAvis({ ...options, avis }, { dossier, env })).rejects.toThrow(
    'Modèle Codex invalide',
  );
  await expect(access(join(racine, 'claude.argv'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('Vibe conserve stdout lorsque le JSON ne porte pas de message assistant', async () => {
  const stdout = 'avertissement\n' + reponse;
  const resultat = await lancerFournisseur(
    'vibe',
    { ...options, prompt: question, modele: 'defaut' },
    { env: { ...env, VIBE_JSON: stdout } },
  );
  expect(resultat).toMatchObject({ etat: 'ok', texte: stdout, modele_servi: null });
});

test('la liste signale une archive dont le nom diffère de son id', async () => {
  const resultat = await lancerAvis(
    { ...options, avis: fournisseurs.slice(0, 1) },
    { dossier, env },
  );
  const fichier = join(dossier, 'autre.json');
  await writeFile(fichier, JSON.stringify(resultat));
  expect((await liste(dossier)).erreurs).toEqual([
    { fichier: basename(fichier), erreur: 'Demande illisible.' },
  ]);
});

test('cinq avis sont traités dans leur ordre avec trois processus au maximum', async () => {
  await writeFile(
    join(env.PATH!, 'codex'),
    String.raw`#!/bin/sh
while [ "$1" != "-m" ]; do shift; done
modele="$2"
fichier="$4"
/bin/mkdir "$TRACES/actif-$modele" || exit 1
set -- "$TRACES"/actif-*
[ "$#" -le 3 ] || exit 1
while [ ! -f "$TRACES/premier-lot" ]; do
  set -- "$TRACES"/actif-*
  if [ "$#" -eq 3 ]; then
    : > "$TRACES/premier-lot"
  fi
  /bin/sleep 0.01
done
/bin/sleep 0.05
/bin/rmdir "$TRACES/actif-$modele"
printf '%s' "$REPONSE" > "$fichier"
`,
    { mode: 0o700 },
  );
  const modeles = ['un', 'deux', 'trois', 'quatre', 'cinq'];
  const avis = modeles.map((modele) => ({ fournisseur: 'codex' as const, modele }));
  const resultat = await lancerAvis({ ...options, avis }, { dossier, env });
  expect(resultat.avis.map((a) => [a.modele_servi, a.etat])).toEqual(
    modeles.map((modele) => [modele, 'ok']),
  );
});

test('Codex omet -m pour defaut et laisse le modèle servi inconnu', async () => {
  const avis = await lancerFournisseur(
    'codex',
    { prompt: question, modele: 'defaut', budgetUsd: 0.5, delaiMs: 5000 },
    { env },
  );
  expect(avis).toMatchObject({
    modele_demande: 'codex:defaut',
    modele_servi: null,
    etat: 'ok',
  });
  const cwd = await readFile(join(racine, 'codex.cwd'), 'utf8');
  const argv = await readFile(join(racine, 'codex.argv'), 'utf8');
  expect(argv.split('\0').slice(0, -1)).toEqual([
    'exec',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '-o',
    join(cwd, 'avis.txt'),
    '-',
  ]);
});

const demandeService = { question, n: 3, modeles: ['sonnet', 'codex:defaut'] };

test('le service distribue et archive les avis en tourniquet', async () => {
  const service = new ServiceAvis(racine, { env });
  const resultat = await service.demander(demandeService);
  expect(resultat.ok).toBe(true);
  if (!resultat.ok) throw new Error('Demande échouée.');
  expect(resultat.data.avis.map((avis) => avis.modele_demande)).toEqual([
    'claude:sonnet',
    'codex:defaut',
    'claude:sonnet',
  ]);
  expect(await service.relire(resultat.data.id)).toMatchObject({ ok: true, data: resultat.data });
});

test('le service refuse une seconde demande et annule les avis actifs et en attente', async () => {
  const service = new ServiceAvis(racine, { env: { ...env, MODE: 'delai' } });
  const attente = service.demander({ ...demandeService, n: 5, modeles: ['sonnet'] });
  const trace = join(racine, 'claude.pid');
  let pid = 0;
  for (let i = 0; i < 200 && !pid; i++) {
    pid = Number(await readFile(trace, 'utf8').catch(() => ''));
    if (!pid) await new Promise((r) => setTimeout(r, 10));
  }
  expect(pid).toBeGreaterThan(0);
  await expect(service.demander(demandeService)).rejects.toBeInstanceOf(AskOccupe);
  service.annuler();
  expect(await attente).toMatchObject({ ok: false, kind: 'annule' });
  expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  expect(service.etat().enCours).toBe(false);
  await expect(access(join(racine, 'avis'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test.each([
  { question: 'Vérifier le service interne.example.com ?' },
  { sousQuestions: [{ n: 1, texte: 'Vérifier le service interne.example.com ?' }] },
])('le filtre arrête tout lancement et masque le texte de la demande %#', async (diff) => {
  const service = new ServiceAvis(racine, { env, hotesPrives: ['interne.example.com'] });
  expect(await service.demander({ ...demandeService, ...diff })).toMatchObject({
    ok: false,
    kind: 'refusee',
    message: 'hôte privé',
  });
  for (const nom of ['claude.argv', 'codex.argv', 'avis'])
    await expect(access(join(racine, nom))).rejects.toMatchObject({ code: 'ENOENT' });
});

test.each(['sonnet', 'opus', 'haiku', 'claude:opus', 'codex:defaut', 'vibe:defaut'])(
  'valide %s',
  (modele) => {
    expect(() => validerDemande({ ...demandeService, modeles: [modele] })).not.toThrow();
  },
);

test.each(['claude:gpt', 'inconnu:defaut', 'codex:avec espace', 'vibe:', 'vibe:a/b'])(
  'refuse %s',
  (modele) => {
    expect(() => validerDemande({ ...demandeService, modeles: [modele] })).toThrow(RangeError);
  },
);

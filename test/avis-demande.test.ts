import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { lancerAvis, liste, type DemandeAvis } from '../src/daemon/avis/demande.js';
import { lancerFournisseur } from '../src/daemon/avis/fournisseurs.js';
import { AskOccupe, ServiceAvis, validerDemande } from '../src/daemon/avis/service.js';
import { construirePrompt } from '../src/daemon/avis/prompt.js';
import { parseAsk } from '../src/shared/swairm-ask.js';
import { parseConfig } from '../src/daemon/config.js';

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
    ANTHROPIC_API_KEY: 'faux',
    ANTHROPIC_AUTH_TOKEN: 'faux',
    ANTHROPIC_BASE_URL: 'faux',
    OPENAI_API_KEY: 'faux',
    MISTRAL_API_KEY: 'faux',
    CLE_PROJET: 'faux',
    CLAUDE_CODE_OAUTH_TOKEN: 'faux',
    GH_TOKEN: 'faux',
  };
  const trace = String.raw`
nom=$(/usr/bin/basename "$0")
printf '%s\0' "$@" > "$HOME/$nom.argv"
printf '%s' "$PWD" > "$HOME/$nom.cwd"
printf '%s' "$$" > "$HOME/$nom.pid"
/bin/ls -A > "$HOME/$nom.contenu"
/usr/bin/env > "$HOME/$nom.env"
`;
  const scripts = {
    claude: `
/bin/cat > "$HOME/claude.stdin"
case "$(/bin/cat "$HOME/mode" 2>/dev/null)" in
  delai) exec /bin/sleep 10 ;;
  budget) printf '%s' '{"type":"result","subtype":"error_max_budget_usd"}'; exit 1 ;;
  echec) printf '%s' '${enveloppe}'; exit 1 ;;
esac
printf 'avertissement\n%s\n{}' '${enveloppe}'`,
    codex: `
/bin/cat > "$HOME/codex.stdin"
while [ "$1" != "-o" ]; do shift; done
printf '%s' '${reponse}' > "$2"
printf 'La réponse est dans le fichier.'`,
    vibe: `/bin/cat "$HOME/vibe-sortie"`,
  };
  await writeFile(
    join(racine, 'vibe-sortie'),
    JSON.stringify([{ role: 'assistant', content: reponse }]),
  );
  await Promise.all(
    Object.entries(scripts).map(([nom, script]) =>
      writeFile(join(bin, nom), '#!/bin/sh\n' + trace + script + '\n', { mode: 0o700 }),
    ),
  );
});

afterEach(async () => {
  await rm(racine, { recursive: true, force: true });
});

const durcissementCodexAttendu = [
  '--ignore-user-config',
  '--disable',
  'agent_message_board',
  '--disable',
  'agent_message_board_mcp',
  '--disable',
  'apps',
  '--disable',
  'apps_early_resource_discovery',
  '--disable',
  'artifact',
  '--disable',
  'browser_annotation_api',
  '--disable',
  'browser_use',
  '--disable',
  'browser_use_external',
  '--disable',
  'browser_use_full_cdp_access',
  '--disable',
  'cli_daybreak',
  '--disable',
  'code_mode',
  '--disable',
  'code_mode_host',
  '--disable',
  'code_mode_only',
  '--disable',
  'code_mode_prewarm',
  '--disable',
  'code_mode_tool_search',
  '--disable',
  'codex_apps_mcp_2026_07_28',
  '--disable',
  'computer_use',
  '--disable',
  'daemon_auto_start',
  '--disable',
  'deferred_executor',
  '--disable',
  'enable_mcp_apps',
  '--disable',
  'executor_capability_discovery',
  '--disable',
  'executor_capability_discovery_v2',
  '--disable',
  'goals',
  '--disable',
  'guardian_approval',
  '--disable',
  'hooks',
  '--disable',
  'hosted_search_policy',
  '--disable',
  'image_generation',
  '--disable',
  'image_generation_animation',
  '--disable',
  'in_app_browser',
  '--disable',
  'in_app_local_automation',
  '--disable',
  'incremental_exec_tools',
  '--disable',
  'incremental_tools',
  '--disable',
  'incremental_tools_legacy',
  '--disable',
  'incremental_tools_legacy_gcp',
  '--disable',
  'mcp_2026_07_28',
  '--disable',
  'mcp_connection_sharing',
  '--disable',
  'mcp_lazy_stdio_startup',
  '--disable',
  'mcp_oauth_refresh_coordination',
  '--disable',
  'mcp_shared_repl_cwd',
  '--disable',
  'memories',
  '--disable',
  'multi_agent',
  '--disable',
  'multi_agent_v2',
  '--disable',
  'multi_agent_v2_dynamic_tools',
  '--disable',
  'multi_env_copy_file',
  '--disable',
  'multi_environment_mcp',
  '--disable',
  'network_proxy',
  '--disable',
  'plugin_sharing',
  '--disable',
  'plugins',
  '--disable',
  'recommended_plugins',
  '--disable',
  'remote_plugin',
  '--disable',
  'request_permissions_tool',
  '--disable',
  'runtime_agent_instances',
  '--disable',
  'shell_snapshot',
  '--disable',
  'shell_snapshot_v2',
  '--disable',
  'shell_tool',
  '--disable',
  'skill_mcp_dependency_install',
  '--disable',
  'skill_search',
  '--disable',
  'sleep_tool',
  '--disable',
  'standalone_web_search',
  '--disable',
  'tool_call_mcp_elicitation',
  '--disable',
  'tool_suggest',
  '--disable',
  'unified_exec',
  '--disable',
  'unified_exec_tty',
  '--disable',
  'view_image',
  '--disable',
  'web_search_cached',
  '--disable',
  'web_search_request',
  '--disable',
  'workspace_dependencies',
  '-c',
  'web_search="disabled"',
];

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
    [2, 'codex:modele:test-1.0', null, 'ok', null],
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
      ...durcissementCodexAttendu,
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
  expect(await lireTrace('claude.stdin')).toBe(prompt);
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
    expect(environnement).toContain('HOME=' + racine);
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
  await writeFile(join(racine, 'mode'), 'delai');
  const resultat = await lancerFournisseur(
    'claude',
    { ...options, prompt: question, modele: 'haiku', delaiMs: 300 },
    { env },
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
  await writeFile(join(racine, 'mode'), mode);
  const resultat = await lancerFournisseur(
    'claude',
    { ...options, prompt: question, modele: 'opus' },
    { env },
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
  await writeFile(join(racine, 'vibe-sortie'), stdout);
  const resultat = await lancerFournisseur(
    'vibe',
    { ...options, prompt: question, modele: 'defaut' },
    { env },
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
    `#!/bin/sh
while [ "$1" != "-m" ]; do shift; done
modele="$2"
fichier="$4"
/bin/mkdir "$HOME/actif-$modele" || exit 1
set -- "$HOME"/actif-*
[ "$#" -le 3 ] || exit 1
while [ ! -f "$HOME/premier-lot" ]; do
  set -- "$HOME"/actif-*
  if [ "$#" -eq 3 ]; then
    : > "$HOME/premier-lot"
  fi
  /bin/sleep 0.01
done
/bin/sleep 0.05
/bin/rmdir "$HOME/actif-$modele"
printf '%s' '${reponse}' > "$fichier"
`,
    { mode: 0o700 },
  );
  const modeles = ['un', 'deux', 'trois', 'quatre', 'cinq'];
  const avis = modeles.map((modele) => ({ fournisseur: 'codex' as const, modele }));
  const resultat = await lancerAvis({ ...options, avis }, { dossier, env });
  expect(resultat.avis.map((a) => [a.modele_demande, a.modele_servi, a.etat])).toEqual(
    modeles.map((modele) => [`codex:${modele}`, null, 'ok']),
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
    ...durcissementCodexAttendu,
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
  await writeFile(join(racine, 'mode'), 'delai');
  const service = new ServiceAvis(racine, { env });
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

test('le faux CLI reçoit seulement les variables autorisées de son fournisseur', async () => {
  await lancerFournisseur(
    'codex',
    { ...options, prompt: question, modele: 'defaut' },
    {
      env: {
        ...env,
        GITHUB_TOKEN: 'faux',
        AWS_SECRET_ACCESS_KEY: 'faux',
        NPM_TOKEN: 'faux',
        CODEX_HOME: racine,
        LC_MESSAGES: 'C',
        XDG_CONFIG_HOME: racine,
        TERM: 'dumb',
      },
      strip: ['TERM'],
    },
  );
  const trace = await readFile(join(racine, 'codex.env'), 'utf8');
  expect(trace).not.toMatch(/^(?:GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY|NPM_TOKEN|AID_HOME|TERM)=/m);
  expect(trace).toContain('CODEX_HOME=' + racine);
  expect(trace).toContain('LC_MESSAGES=C');
  expect(trace).toContain('XDG_CONFIG_HOME=' + racine);
});

test.each(['db.internal', 'nas.local', 'nas.lan', 'db.corp', 'nas.home.arpa', 'db.cluster.local'])(
  'refuse le suffixe privé de %s avant tout lancement',
  async (hote) => {
    const service = new ServiceAvis(racine, { env, hotesPrives: ['example.com'] });
    expect(
      await service.demander({ ...demandeService, question: `Vérifier ${hote} ?` }),
    ).toMatchObject({
      ok: false,
      kind: 'refusee',
      message: 'hôte privé',
    });
    for (const nom of ['claude.argv', 'codex.argv', 'avis'])
      await expect(access(join(racine, nom))).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

test('la configuration des hôtes privés accepte une liste de chaînes', () => {
  expect(parseConfig('hotesPrives: [example.com]').hotesPrives).toEqual(['example.com']);
  expect(() => parseConfig('hotesPrives: example.com')).toThrow('liste de chaînes');
});

test('une réponse vide produit un avis invalide et aucun succès du service', async () => {
  await writeFile(join(racine, 'vibe-sortie'), '{"reponses":[]}');
  const service = new ServiceAvis(racine, { env });
  expect(
    await service.demander({ ...demandeService, n: 1, modeles: ['vibe:defaut'] }),
  ).toMatchObject({
    ok: false,
    kind: 'aucun-avis',
    data: { avis: [{ etat: 'invalide' }] },
  });
});

test('le service se libère après exit malgré le stdout hérité par un petit-enfant détaché', async () => {
  await writeFile(
    join(env.PATH!, 'vibe'),
    `#!${process.execPath}
const { spawn } = require('node:child_process');
spawn('/bin/sleep', ['2'], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] }).unref();
console.log(${JSON.stringify(reponse)});
`,
    { mode: 0o700 },
  );
  const service = new ServiceAvis(racine, { env });
  const attente = service.demander({ ...demandeService, n: 1, modeles: ['vibe:defaut'] });
  let minuterie: ReturnType<typeof setTimeout> | undefined;
  try {
    const resultat = await Promise.race([
      attente,
      new Promise((resolve) => {
        minuterie = setTimeout(() => resolve('service encore occupé'), 1000);
      }),
    ]);
    expect(resultat).toMatchObject({ ok: true });
    expect(service.etat().enCours).toBe(false);
    expect(await service.demander({ ...demandeService, n: 1 })).toMatchObject({ ok: true });
  } finally {
    clearTimeout(minuterie);
    await attente;
  }
});

test.each([
  ['question', { question: 'a'.repeat(20_001) }, 'question trop longue'],
  [
    'une sous-question',
    { sousQuestions: [{ n: 1, texte: 'a'.repeat(20_001) }] },
    'sous-questions trop longues',
  ],
  [
    'sous-questions cumulées',
    {
      sousQuestions: [
        { n: 1, texte: 'a'.repeat(10_001) },
        { n: 2, texte: 'b'.repeat(10_000) },
      ],
    },
    'sous-questions trop longues',
  ],
])('refuse clairement le dépassement du plafond (%s)', async (_cas, diff, message) => {
  const service = new ServiceAvis(racine, { env });
  expect(await service.demander({ ...demandeService, ...diff })).toMatchObject({
    ok: false,
    kind: 'refusee',
    message,
  });
  await expect(access(join(racine, 'claude.argv'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('stdout est accepté à 4 Mio et refusé au premier octet supplémentaire', async () => {
  const script = join(env.PATH!, 'vibe');
  const lancer = () =>
    lancerFournisseur('vibe', { ...options, prompt: question, modele: 'defaut' }, { env });
  const tailleMax = 4 * 1024 * 1024;
  await writeFile(script, `#!/bin/sh\nexec /usr/bin/head -c ${tailleMax} /dev/zero\n`);
  const exact = await lancer();
  expect(exact.etat).toBe('ok');
  expect(exact.texte.length).toBe(tailleMax);
  await writeFile(script, `#!/bin/sh\nexec /usr/bin/head -c ${tailleMax + 1} /dev/zero\n`);
  const depassement = await lancer();
  expect(depassement.etat).toBe('echec');
  expect(depassement.texte).toBe('');
});

test('les mots ordinaires ne sont pas traités comme des suffixes DNS privés', async () => {
  const service = new ServiceAvis(racine, { env });
  expect(
    await service.demander({ ...demandeService, n: 1, question: 'Faut-il un test local ?' }),
  ).toMatchObject({ ok: true });
});

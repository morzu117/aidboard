import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODELES_ASK } from '../../shared/swairm-ask.js';
import type { Fournisseur } from '../../shared/routage.js';
import { lireObjet, objet } from './lecture.js';

export type { Fournisseur } from '../../shared/routage.js';
export interface OptionsAvis {
  prompt: string;
  modele: string;
  budgetUsd: number;
  delaiMs: number;
}
export interface EnvironnementAvis {
  env?: NodeJS.ProcessEnv;
  strip?: readonly string[];
  signal?: AbortSignal;
}
export interface AvisBrut {
  modele_demande: string;
  modele_servi: string | null;
  cout_usd: number | null;
  duree_s: number | null;
  texte: string;
  etat: 'ok' | 'echec' | 'budget' | 'delai';
  detail?: 'CLI absent';
}

export function validerModele(
  fournisseur: string,
  modele: string,
): asserts fournisseur is Fournisseur {
  if (fournisseur !== 'claude' && fournisseur !== 'codex' && fournisseur !== 'vibe')
    throw new RangeError('Fournisseur inconnu.');
  if (typeof modele !== 'string') throw new RangeError('Modèle invalide.');
  if (fournisseur === 'claude' && !MODELES_ASK.some((m) => m === modele))
    throw new RangeError('Modèle attendu : sonnet, opus ou haiku.');
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(modele))
    throw new RangeError(fournisseur === 'codex' ? 'Modèle Codex invalide.' : 'Modèle invalide.');
}

export function validerBudget(budgetUsd: number): void {
  if (!Number.isFinite(budgetUsd) || !(budgetUsd > 0 && budgetUsd <= 2))
    throw new RangeError('Budget attendu entre 0 et 2 USD, hors zéro.');
}

export function validerAvis(fournisseur: Fournisseur, options: OptionsAvis): void {
  const { modele, budgetUsd, delaiMs } = options;
  validerModele(fournisseur, modele);
  validerBudget(budgetUsd);
  if (!Number.isFinite(delaiMs) || !(delaiMs > 0 && delaiMs <= 2_147_483_647))
    throw new RangeError('Délai invalide.');
}

const mesure = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

function lireClaude(stdout: string, code: number | null): Partial<AvisBrut> {
  let enveloppe = null;
  for (let i = stdout.indexOf('{'); i >= 0; i = stdout.indexOf('{', i + 1)) {
    enveloppe = lireObjet(stdout, i);
    if (enveloppe) break;
  }
  if (enveloppe?.type !== 'result') return { texte: stdout };
  let modeleServi: string | null = null;
  let meilleurCout: number | null = null;
  if (objet(enveloppe.modelUsage)) {
    for (const [nom, usage] of Object.entries(enveloppe.modelUsage)) {
      if (!objet(usage)) continue;
      const cout = mesure(usage.costUSD);
      if (!modeleServi || (cout !== null && (meilleurCout === null || cout > meilleurCout))) {
        modeleServi =
          typeof usage.canonicalModel === 'string' && usage.canonicalModel
            ? usage.canonicalModel
            : nom;
        meilleurCout = cout;
      }
    }
  }
  const duree = mesure(enveloppe.duration_ms);
  const { result, subtype, is_error } = enveloppe;
  let etat: AvisBrut['etat'] = 'echec';
  if (subtype === 'error_max_budget_usd') etat = 'budget';
  else if (code === 0 && subtype === 'success' && !is_error && typeof result === 'string')
    etat = 'ok';
  return {
    modele_servi: modeleServi || null,
    cout_usd: mesure(enveloppe.total_cost_usd),
    duree_s: duree === null ? null : Math.trunc(duree) / 1000,
    texte: typeof result === 'string' ? result : JSON.stringify(enveloppe),
    etat,
  };
}

function lireVibe(stdout: string): string {
  try {
    const valeur: unknown = JSON.parse(stdout);
    if (typeof valeur === 'string') return valeur;
    const messages: unknown = objet(valeur) ? valeur.messages : valeur;
    if (Array.isArray(messages)) {
      for (const message of (messages as unknown[]).slice().reverse()) {
        if (objet(message) && message.role === 'assistant' && typeof message.content === 'string')
          return message.content;
      }
    }
  } catch {
    // La sortie brute reste lisible par le parseur d'avis.
  }
  return stdout;
}

// Options présentes dans `codex features list` pour Codex CLI 0.172.0.
const FONCTIONNALITES_CODEX_DESACTIVEES = [
  'agent_message_board',
  'agent_message_board_mcp',
  'apps',
  'apps_early_resource_discovery',
  'artifact',
  'browser_annotation_api',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'cli_daybreak',
  'code_mode',
  'code_mode_host',
  'code_mode_only',
  'code_mode_prewarm',
  'code_mode_tool_search',
  'codex_apps_mcp_2026_07_28',
  'computer_use',
  'daemon_auto_start',
  'deferred_executor',
  'enable_mcp_apps',
  'executor_capability_discovery',
  'executor_capability_discovery_v2',
  'goals',
  'guardian_approval',
  'hooks',
  'hosted_search_policy',
  'image_generation',
  'image_generation_animation',
  'in_app_browser',
  'in_app_local_automation',
  'incremental_exec_tools',
  'incremental_tools',
  'incremental_tools_legacy',
  'incremental_tools_legacy_gcp',
  'mcp_2026_07_28',
  'mcp_connection_sharing',
  'mcp_lazy_stdio_startup',
  'mcp_oauth_refresh_coordination',
  'mcp_shared_repl_cwd',
  'memories',
  'multi_agent',
  'multi_agent_v2',
  'multi_agent_v2_dynamic_tools',
  'multi_env_copy_file',
  'multi_environment_mcp',
  'network_proxy',
  'plugin_sharing',
  'plugins',
  'recommended_plugins',
  'remote_plugin',
  'request_permissions_tool',
  'runtime_agent_instances',
  'shell_snapshot',
  'shell_snapshot_v2',
  'shell_tool',
  'skill_mcp_dependency_install',
  'skill_search',
  'sleep_tool',
  'standalone_web_search',
  'tool_call_mcp_elicitation',
  'tool_suggest',
  'unified_exec',
  'unified_exec_tty',
  'view_image',
  'web_search_cached',
  'web_search_request',
  'workspace_dependencies',
];

function argumentsAvis(fournisseur: Fournisseur, options: OptionsAvis, fichier: string): string[] {
  const { prompt, modele, budgetUsd } = options;
  switch (fournisseur) {
    case 'claude':
      return [
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
        modele,
        '--max-budget-usd',
        String(budgetUsd),
        '--output-format',
        'json',
      ];
    case 'codex':
      return [
        'exec',
        '--ignore-user-config',
        ...FONCTIONNALITES_CODEX_DESACTIVEES.flatMap((nom) => ['--disable', nom]),
        '-c',
        'web_search="disabled"',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        ...(modele === 'defaut' ? [] : ['-m', modele]),
        '-o',
        fichier,
        '-',
      ];
    case 'vibe':
      return [
        '-p',
        prompt,
        '--max-turns',
        '1',
        '--output',
        'json',
        '--max-price',
        String(budgetUsd),
        '--enabled-tools',
        '',
      ];
  }
}

const GRACE_SORTIE_MS = 100;
const STDOUT_MAX = 4 * 1024 * 1024;
const VARIABLES_COMMUNES = new Set(['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR']);

interface Sortie {
  stdout: string;
  code: number | null;
  delai: boolean;
  erreur: string | undefined;
}

function executer(
  fournisseur: Fournisseur,
  options: OptionsAvis,
  fichier: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<Sortie> {
  signal?.throwIfAborted();
  return new Promise((resolve) => {
    const groupe = process.platform !== 'win32';
    const enfant = spawn(fournisseur, argumentsAvis(fournisseur, options, fichier), {
      cwd,
      env,
      detached: groupe,
      stdio: [fournisseur === 'vibe' ? 'ignore' : 'pipe', 'pipe', 'ignore'],
    });
    const sortie: Buffer[] = [];
    let octets = 0;
    let delai = false;
    let erreur: string | undefined;
    const arreter = () => {
      try {
        if (groupe && enfant.pid !== undefined) process.kill(-enfant.pid, 'SIGKILL');
        else enfant.kill('SIGKILL');
      } catch {
        enfant.kill('SIGKILL');
      }
    };
    signal?.addEventListener('abort', arreter, { once: true });
    const minuterie = setTimeout(() => {
      delai = true;
      arreter();
    }, options.delaiMs);
    enfant.stdout?.on('data', (bloc: Buffer) => {
      if (erreur) return;
      octets += bloc.length;
      if (octets > STDOUT_MAX) {
        erreur = 'stdout';
        arreter();
        return;
      }
      sortie.push(bloc);
    });
    enfant.on('error', (err: NodeJS.ErrnoException) => {
      erreur = err.code ?? 'spawn';
    });
    let grace: ReturnType<typeof setTimeout> | undefined;
    const terminer = (code: number | null) => {
      clearTimeout(minuterie);
      clearTimeout(grace);
      signal?.removeEventListener('abort', arreter);
      resolve({ stdout: Buffer.concat(sortie).toString('utf8'), code, delai, erreur });
    };
    enfant.once('close', terminer);
    enfant.once('exit', (code) => {
      clearTimeout(minuterie);
      grace = setTimeout(() => {
        enfant.removeListener('close', terminer);
        enfant.stdin?.destroy();
        enfant.stdout?.destroy();
        terminer(code);
      }, GRACE_SORTIE_MS);
    });
    enfant.stdin?.on('error', () => {
      // La fermeture anticipée de stdin est traitée via le résultat du CLI.
    });
    enfant.stdin?.end(options.prompt);
  });
}

export async function lancerFournisseur(
  fournisseur: Fournisseur,
  options: OptionsAvis,
  deps: EnvironnementAvis = {},
): Promise<AvisBrut> {
  validerAvis(fournisseur, options);
  const brut: AvisBrut = {
    modele_demande: `${fournisseur}:${options.modele}`,
    modele_servi: null,
    cout_usd: null,
    duree_s: null,
    texte: '',
    etat: 'echec',
  };
  const configCli =
    fournisseur === 'codex' ? 'CODEX_HOME' : fournisseur === 'claude' ? 'CLAUDE_CONFIG_DIR' : null;
  const env = Object.fromEntries(
    Object.entries(deps.env ?? process.env).filter(
      ([cle]) =>
        (cle === configCli ||
          VARIABLES_COMMUNES.has(cle) ||
          cle.startsWith('LC_') ||
          cle.startsWith('XDG_')) &&
        !deps.strip?.includes(cle),
    ),
  );

  let cwd: string | undefined;
  try {
    cwd = await mkdtemp(join(tmpdir(), 'aid-avis-'));
    const fichier = join(cwd, 'avis.txt');
    const { stdout, code, delai, erreur } = await executer(
      fournisseur,
      options,
      fichier,
      cwd,
      env,
      deps.signal,
    );
    if (delai) return { ...brut, etat: 'delai' };
    if (erreur === 'ENOENT') return { ...brut, detail: 'CLI absent' };
    if (erreur) return brut;
    if (fournisseur === 'claude') return { ...brut, ...lireClaude(stdout, code) };
    if (code !== 0) return brut;
    return {
      ...brut,
      texte: fournisseur === 'codex' ? await readFile(fichier, 'utf8') : lireVibe(stdout),
      etat: 'ok',
    };
  } catch {
    return brut;
  } finally {
    if (cwd) await rm(cwd, { recursive: true, force: true });
  }
}

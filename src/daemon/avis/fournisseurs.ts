import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODELES_ASK } from '../../shared/swairm-ask.js';
import { lireObjet, objet } from './lecture.js';

export type Fournisseur = 'claude' | 'codex' | 'vibe';
export interface OptionsAvis {
  prompt: string;
  modele: string;
  budgetUsd: number;
  delaiMs: number;
}
export interface EnvironnementAvis {
  env?: NodeJS.ProcessEnv;
  strip?: readonly string[];
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

export function validerAvis(fournisseur: Fournisseur, options: OptionsAvis): void {
  const { modele, budgetUsd, delaiMs } = options;
  if (fournisseur !== 'claude' && fournisseur !== 'codex' && fournisseur !== 'vibe')
    throw new RangeError('Fournisseur inconnu.');
  if (typeof modele !== 'string') throw new RangeError('Modèle invalide.');
  if (!Number.isFinite(budgetUsd) || !(budgetUsd > 0 && budgetUsd <= 2))
    throw new RangeError('Budget attendu entre 0 et 2 USD, hors zéro.');
  if (!Number.isFinite(delaiMs) || !(delaiMs > 0 && delaiMs <= 2_147_483_647))
    throw new RangeError('Délai invalide.');
  if (fournisseur === 'claude' && !MODELES_ASK.some((m) => m === modele))
    throw new RangeError('Modèle attendu : sonnet, opus ou haiku.');
  if (fournisseur === 'codex' && !/^[A-Za-z0-9._:-]{1,64}$/.test(modele))
    throw new RangeError('Modèle Codex invalide.');
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

function argumentsAvis(fournisseur: Fournisseur, options: OptionsAvis, fichier: string): string[] {
  const { prompt, modele, budgetUsd } = options;
  switch (fournisseur) {
    case 'claude':
      return [
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
        modele,
        '--max-budget-usd',
        String(budgetUsd),
        '--output-format',
        'json',
      ];
    case 'codex':
      return [
        'exec',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '-m',
        modele,
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
): Promise<Sortie> {
  return new Promise((resolve) => {
    const groupe = process.platform !== 'win32';
    const enfant = spawn(fournisseur, argumentsAvis(fournisseur, options, fichier), {
      cwd,
      env,
      detached: groupe,
      stdio: [fournisseur === 'codex' ? 'pipe' : 'ignore', 'pipe', 'ignore'],
    });
    const sortie: Buffer[] = [];
    let delai = false;
    let erreur: string | undefined;
    const minuterie = setTimeout(() => {
      delai = true;
      try {
        if (groupe && enfant.pid !== undefined) process.kill(-enfant.pid, 'SIGKILL');
        else enfant.kill('SIGKILL');
      } catch {
        enfant.kill('SIGKILL');
      }
    }, options.delaiMs);
    enfant.stdout?.on('data', (chunk: Buffer) => sortie.push(chunk));
    enfant.on('error', (err: NodeJS.ErrnoException) => {
      erreur = err.code ?? 'spawn';
    });
    enfant.on('close', (code) => {
      clearTimeout(minuterie);
      resolve({ stdout: Buffer.concat(sortie).toString('utf8'), code, delai, erreur });
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
    modele_servi: fournisseur === 'codex' ? options.modele : null,
    cout_usd: null,
    duree_s: null,
    texte: '',
    etat: 'echec',
  };
  const env = { ...(deps.env ?? process.env) };
  for (const cle of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'OPENAI_API_KEY',
    'MISTRAL_API_KEY',
    ...(deps.strip ?? []),
  ])
    delete env[cle];

  let cwd: string | undefined;
  try {
    cwd = await mkdtemp(join(tmpdir(), 'aid-avis-'));
    const fichier = join(cwd, 'avis.txt');
    const { stdout, code, delai, erreur } = await executer(fournisseur, options, fichier, cwd, env);
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

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AlerteSecret, Fournisseur, Fournisseurs } from '../../shared/model.js';

/**
 * Chantier 29 (D159) : les accès aux modèles que les agents d'A-I-D utilisent vraiment, et les secrets en clair.
 * Rien n'est jamais lu : la présence d'une variable (`nom in env`) et l'existence d'un fichier. Ni valeur, ni
 * contenu, ni longueur ne sortent d'ici.
 */

const ANTHROPIC = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const OPENAI = ['OPENAI_API_KEY'];
/** Les clés d'API qu'une alerte nomme quand elles traînent dans l'environnement du daemon. */
export const CLES_CONNUES = [...ANTHROPIC, ...OPENAI, 'OPENROUTER_API_KEY', 'GEMINI_API_KEY'];

export interface EntreesFournisseurs {
  env: NodeJS.ProcessEnv;
  /** `env.strip` : retirées de l'environnement des agents */
  strip: string[];
  /** `memory.embeddings.provider === 'ollama'` */
  ollama: boolean;
  /** le dossier de codex (`$CODEX_HOME` ou `~/.codex`) */
  codexHome: string;
  /** `existsSync`, remplaçable en test */
  existe?: (path: string) => boolean;
}

/** `~/.codex` plutôt que le chemin complet, quand il est sous le HOME. */
function court(path: string, home: string): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

const present = (env: NodeJS.ProcessEnv, nom: string) => (env[nom] ?? '') !== '';

function alerteEnv(nom: string): AlerteSecret {
  return {
    id: `env:${nom}`,
    titre: `${nom} dans l'environnement du daemon`,
    etapes: [
      `Retire la ligne qui exporte ${nom} de ton profil de shell (~/.zshrc, ~/.zprofile ou ~/.bash_profile).`,
      `Si un outil en a besoin, range la clé dans le trousseau : security add-generic-password -a "$USER" -s ${nom} -w, puis lis-la au besoin avec security find-generic-password -s ${nom} -w.`,
      'Arrête puis relance le daemon A-I-D depuis un shell neuf : il ne voit plus la clé.',
    ],
  };
}

export function fournisseurs(e: EntreesFournisseurs): Fournisseurs {
  const existe = e.existe ?? existsSync;
  const home = e.env.HOME ?? homedir();
  const alertes = CLES_CONNUES.filter((nom) => present(e.env, nom)).map(alerteEnv);
  const alerteDe = (noms: string[]) =>
    alertes.find((a) => noms.some((n) => a.id === `env:${n}`))?.id ?? null;
  const transmise = (noms: string[]) => noms.some((n) => present(e.env, n) && !e.strip.includes(n));

  const auth = join(e.codexHome, 'auth.json');
  if (existe(auth))
    alertes.push({
      id: 'codex:auth.json',
      titre: `Identifiants de codex dans un fichier (${court(auth, home)})`,
      etapes: [
        `Ajoute cli_auth_credentials_store = "keyring" à ${court(join(e.codexHome, 'config.toml'), home)}.`,
        'Lance codex logout, puis codex login : les identifiants passent dans le trousseau.',
        `Vérifie que ${court(auth, home)} a disparu.`,
      ],
    });

  const anthropicUsage = transmise(ANTHROPIC);
  const openaiUsage = transmise(OPENAI);
  const liste: Fournisseur[] = [
    {
      id: 'anthropic',
      nom: 'Anthropic',
      agent: 'claude',
      acces: anthropicUsage
        ? "Clé API · facturation à l'usage"
        : 'Abonnement · claude CLI · repli payant désactivé',
      usage: anthropicUsage,
      secret: alerteDe(ANTHROPIC)
        ? "Clé en clair dans l'environnement"
        : 'Identifiants gérés par le CLI',
      alerte: alerteDe(ANTHROPIC),
    },
    {
      id: 'openai',
      nom: 'OpenAI',
      agent: 'codex',
      acces: openaiUsage
        ? "Clé API présente · facturation à l'usage possible"
        : 'codex CLI · identifiants gérés par le CLI',
      usage: openaiUsage,
      secret: alerteDe(OPENAI)
        ? "Clé en clair dans l'environnement"
        : existe(auth)
          ? 'Identifiants dans un fichier'
          : 'Identifiants gérés par le CLI',
      alerte: alerteDe(OPENAI) ?? (existe(auth) ? 'codex:auth.json' : null),
    },
  ];
  if (e.ollama)
    liste.push({
      id: 'ollama',
      nom: 'Ollama',
      agent: null,
      acces: 'Endpoint local · sans clé · recherche de la mémoire',
      usage: false,
      secret: 'Aucun secret',
      alerte: null,
    });
  return { fournisseurs: liste, alertes };
}

/** Le dossier de codex, comme codex le cherche. */
export function codexHome(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME || join(env.HOME ?? homedir(), '.codex');
}

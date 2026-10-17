import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { AidPaths } from './paths.js';

export interface AidConfig {
  host: '127.0.0.1';
  port: number;
  editor: string[];
  env: { strip: string[] };
  terminal: { scrollback: number; logMaxBytes: number; logRetentionDays: number };
  memory: MemoryConfig;
  structural: StructuralConfig;
}

export interface MemoryConfig {
  embeddings: { provider: 'off' | 'ollama'; model: string; url: string };
  maintenance: { enabled: boolean; model: string; window: string };
  git: { push: boolean };
}

export interface StructuralConfig {
  engine: 'codegraph' | 'off';
  bin: string;
  timeoutMs: number;
  /** DO2 (chantier 08) encore ouverte : le champ existe, aucun adaptateur ne le lit encore */
  exclude: string[];
}

export const DEFAULT_CONFIG: AidConfig = {
  host: '127.0.0.1',
  port: 4870,
  editor: [],
  env: { strip: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] },
  terminal: { scrollback: 5000, logMaxBytes: 50 * 1024 * 1024, logRetentionDays: 30 },
  memory: {
    embeddings: { provider: 'ollama', model: 'bge-m3', url: 'http://127.0.0.1:11434' },
    maintenance: { enabled: false, model: 'qwen3:8b', window: '02:00-06:00' },
    git: { push: false },
  },
  structural: { engine: 'codegraph', bin: 'codegraph', timeoutMs: 60_000, exclude: [] },
};

export class ConfigError extends Error {}

type Raw = Record<string, unknown>;

function isRecord(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function rejectUnknown(raw: Raw, known: string[], where: string): void {
  for (const key of Object.keys(raw)) {
    if (!known.includes(key))
      throw new ConfigError(`clé inconnue dans config.yaml : ${where}${key}`);
  }
}

function positiveInt(v: unknown, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) {
    throw new ConfigError(`config.yaml : ${name} doit être un entier entre 1 et ${max}`);
  }
  return v;
}

function stringList(v: unknown, name: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new ConfigError(`config.yaml : ${name} doit être une liste de chaînes`);
  }
  return v as string[];
}

export function parseConfig(text: string): AidConfig {
  const doc: unknown = text.trim() === '' ? {} : parse(text);
  if (doc === null || doc === undefined) return structuredClone(DEFAULT_CONFIG);
  if (!isRecord(doc)) throw new ConfigError('config.yaml : un objet est attendu à la racine');
  rejectUnknown(doc, ['host', 'port', 'editor', 'env', 'terminal', 'memory', 'structural'], '');

  const cfg = structuredClone(DEFAULT_CONFIG);
  if (doc.host !== undefined && doc.host !== '127.0.0.1') {
    throw new ConfigError("A-I-D n'écoute que sur 127.0.0.1 : `host` ne peut pas changer");
  }
  if (doc.port !== undefined) cfg.port = positiveInt(doc.port, 'port', 65535);
  if (doc.editor !== undefined) cfg.editor = stringList(doc.editor, 'editor');
  if (doc.env !== undefined) {
    if (!isRecord(doc.env)) throw new ConfigError('config.yaml : env doit être un objet');
    rejectUnknown(doc.env, ['strip'], 'env.');
    if (doc.env.strip !== undefined) cfg.env.strip = stringList(doc.env.strip, 'env.strip');
  }
  if (doc.terminal !== undefined) {
    if (!isRecord(doc.terminal)) throw new ConfigError('config.yaml : terminal doit être un objet');
    rejectUnknown(doc.terminal, ['scrollback', 'logMaxBytes', 'logRetentionDays'], 'terminal.');
    if (doc.terminal.scrollback !== undefined) {
      cfg.terminal.scrollback = positiveInt(doc.terminal.scrollback, 'terminal.scrollback');
    }
    if (doc.terminal.logRetentionDays !== undefined) {
      cfg.terminal.logRetentionDays = positiveInt(
        doc.terminal.logRetentionDays,
        'terminal.logRetentionDays',
      );
    }
    if (doc.terminal.logMaxBytes !== undefined) {
      cfg.terminal.logMaxBytes = positiveInt(doc.terminal.logMaxBytes, 'terminal.logMaxBytes');
    }
  }
  if (doc.memory !== undefined) parseMemory(doc.memory, cfg.memory);
  if (doc.structural !== undefined) parseStructural(doc.structural, cfg.structural);
  return cfg;
}

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || v === '')
    throw new ConfigError(`config.yaml : ${name} doit être une chaîne`);
  return v;
}

function bool(v: unknown, name: string): boolean {
  if (typeof v !== 'boolean')
    throw new ConfigError(`config.yaml : ${name} doit être true ou false`);
  return v;
}

function parseMemory(raw: unknown, cfg: MemoryConfig): void {
  if (!isRecord(raw)) throw new ConfigError('config.yaml : memory doit être un objet');
  rejectUnknown(raw, ['embeddings', 'maintenance', 'git'], 'memory.');
  const e = raw.embeddings;
  if (e !== undefined) {
    if (!isRecord(e)) throw new ConfigError('config.yaml : memory.embeddings doit être un objet');
    rejectUnknown(e, ['provider', 'model', 'url'], 'memory.embeddings.');
    if (e.provider !== undefined) {
      if (e.provider !== 'off' && e.provider !== 'ollama') {
        throw new ConfigError("config.yaml : memory.embeddings.provider vaut 'off' ou 'ollama'");
      }
      cfg.embeddings.provider = e.provider;
    }
    if (e.model !== undefined) cfg.embeddings.model = str(e.model, 'memory.embeddings.model');
    if (e.url !== undefined) cfg.embeddings.url = str(e.url, 'memory.embeddings.url');
  }
  const m = raw.maintenance;
  if (m !== undefined) {
    if (!isRecord(m)) throw new ConfigError('config.yaml : memory.maintenance doit être un objet');
    rejectUnknown(m, ['enabled', 'model', 'window'], 'memory.maintenance.');
    if (m.enabled !== undefined)
      cfg.maintenance.enabled = bool(m.enabled, 'memory.maintenance.enabled');
    if (m.model !== undefined) cfg.maintenance.model = str(m.model, 'memory.maintenance.model');
    if (m.window !== undefined) {
      const w = str(m.window, 'memory.maintenance.window');
      if (!/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(w)) {
        throw new ConfigError('config.yaml : memory.maintenance.window attend "HH:MM-HH:MM"');
      }
      cfg.maintenance.window = w;
    }
  }
  const g = raw.git;
  if (g !== undefined) {
    if (!isRecord(g)) throw new ConfigError('config.yaml : memory.git doit être un objet');
    rejectUnknown(g, ['push'], 'memory.git.');
    if (g.push !== undefined) cfg.git.push = bool(g.push, 'memory.git.push');
  }
}

function parseStructural(raw: unknown, cfg: StructuralConfig): void {
  if (!isRecord(raw)) throw new ConfigError('config.yaml : structural doit être un objet');
  rejectUnknown(raw, ['engine', 'bin', 'timeoutMs', 'exclude'], 'structural.');
  if (raw.engine !== undefined) {
    if (raw.engine !== 'codegraph' && raw.engine !== 'off') {
      throw new ConfigError(
        'config.yaml : structural.engine — moteur inconnu (disponibles : codegraph, off)',
      );
    }
    cfg.engine = raw.engine;
  }
  if (raw.bin !== undefined) cfg.bin = str(raw.bin, 'structural.bin');
  if (raw.timeoutMs !== undefined) {
    cfg.timeoutMs = positiveInt(raw.timeoutMs, 'structural.timeoutMs');
  }
  if (raw.exclude !== undefined) cfg.exclude = stringList(raw.exclude, 'structural.exclude');
}

export function loadConfig(p: AidPaths): AidConfig {
  if (!existsSync(p.config)) return structuredClone(DEFAULT_CONFIG);
  return parseConfig(readFileSync(p.config, 'utf8'));
}

const DEFAULT_FILE = `# Configuration d'A-I-D. Tout est facultatif : ce sont les valeurs par défaut.
# port: 4870
# editor: []              # vide = détection (code, open, xdg-open) ; "{path}" est remplacé
# env:
#   strip:                # retirées de l'environnement des agents
#     - ANTHROPIC_API_KEY
#     - ANTHROPIC_AUTH_TOKEN
# terminal:
#   scrollback: 5000
#   logMaxBytes: 52428800
#   logRetentionDays: 30     # les journaux plus vieux sont supprimés au démarrage
# memory:
#   embeddings:
#     provider: ollama       # off = recherche FTS5 seule ; ollama = vecteurs si le modèle répond
#     model: bge-m3          # ollama pull bge-m3
#     url: http://127.0.0.1:11434
#   maintenance:
#     enabled: false         # propositions (tags, doublons, découpage) par un modèle local, jamais appliquées sans clic
#     model: qwen3:8b
#     window: "02:00-06:00"
#   git:
#     push: false            # true : git push de ~/.aid/memory après chaque commit, si un remote origin existe
# structural:
#   engine: codegraph      # off = aucune lecture structurelle, les sujets restent "disabled"
#   bin: codegraph         # chemin ou nom du binaire codegraph
#   timeoutMs: 60000
#   exclude: []            # dossiers à exclure des résultats (dist, …) — ex. ["dist"]
`;

export function writeDefaultConfigIfAbsent(p: AidPaths): void {
  if (!existsSync(p.config)) writeFileSync(p.config, DEFAULT_FILE, { mode: 0o600 });
}

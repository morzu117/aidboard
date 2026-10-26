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
  mesh: MeshConfig;
  swairm: SwairmConfig;
  agents: AgentsConfig;
}

/** Bascule progressive D63 : `stream` passe `claude`/`codex` par pilote structuré plutôt que PTY. */
export interface AgentsConfig {
  transport: 'pty' | 'stream';
}

/** Cell Swairm (14.1, D43) : binaire vide = désactivée. */
export interface SwairmConfig {
  bin: string;
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

/** Mesh swarph (chantier 12, D39). `cell` vide = mesh désactivé, rien n'apparaît dans l'UI. Le token n'y figure jamais. */
export interface MeshConfig {
  /** nom ou chemin du binaire swarph */
  bin: string;
  cell: string;
  /** vide = `~/.config/swarph/cells/<cell>.yaml` */
  cellFile: string;
  /** `MESH_GATEWAY_URL` passé à swarph : une URL, pas un secret */
  gateway: string;
  /** vide = `~/swarph_state` */
  stateRoot: string;
  /** manage: true = `tailscale up`/`down` par A-I-D (D37 : défaut false, Tailscale sert aussi à autre chose) */
  tailscale: { manage: boolean; bin: string };
}

export const DEFAULT_TAILSCALE_BIN =
  process.platform === 'darwin'
    ? '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
    : 'tailscale';

export const DEFAULT_CONFIG: AidConfig = {
  swairm: { bin: '' },
  agents: { transport: 'pty' },
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
  mesh: {
    bin: 'swarph',
    cell: '',
    cellFile: '',
    gateway: '',
    stateRoot: '',
    tailscale: { manage: false, bin: DEFAULT_TAILSCALE_BIN },
  },
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
  rejectUnknown(
    doc,
    [
      'host',
      'port',
      'editor',
      'env',
      'terminal',
      'memory',
      'structural',
      'mesh',
      'swairm',
      'agents',
    ],
    '',
  );

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
  if (doc.mesh !== undefined) parseMesh(doc.mesh, cfg.mesh);
  if (doc.swairm !== undefined) parseSwairm(doc.swairm, cfg.swairm);
  if (doc.agents !== undefined) parseAgents(doc.agents, cfg.agents);
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

// `cell`, `cellFile` et `stateRoot` acceptent la chaîne vide (= désactivé ou dérivé) ; les autres chaînes non.
function strOrEmpty(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new ConfigError(`config.yaml : ${name} doit être une chaîne`);
  return v;
}

function parseMesh(raw: unknown, cfg: MeshConfig): void {
  if (!isRecord(raw)) throw new ConfigError('config.yaml : mesh doit être un objet');
  rejectUnknown(raw, ['bin', 'cell', 'cellFile', 'gateway', 'stateRoot', 'tailscale'], 'mesh.');
  if (raw.bin !== undefined) cfg.bin = str(raw.bin, 'mesh.bin');
  if (raw.cell !== undefined) {
    cfg.cell = strOrEmpty(raw.cell, 'mesh.cell');
    if (!/^[A-Za-z0-9._-]*$/.test(cfg.cell)) {
      throw new ConfigError(
        'config.yaml : mesh.cell — lettres, chiffres, point, tiret et souligné seulement',
      );
    }
  }
  if (raw.cellFile !== undefined) cfg.cellFile = strOrEmpty(raw.cellFile, 'mesh.cellFile');
  if (raw.gateway !== undefined) {
    cfg.gateway = strOrEmpty(raw.gateway, 'mesh.gateway');
    if (cfg.gateway !== '' && !/^https?:\/\//.test(cfg.gateway)) {
      throw new ConfigError('config.yaml : mesh.gateway doit être une URL http(s)');
    }
  }
  if (raw.stateRoot !== undefined) cfg.stateRoot = strOrEmpty(raw.stateRoot, 'mesh.stateRoot');
  const t = raw.tailscale;
  if (t !== undefined) {
    if (!isRecord(t)) throw new ConfigError('config.yaml : mesh.tailscale doit être un objet');
    rejectUnknown(t, ['manage', 'bin'], 'mesh.tailscale.');
    if (t.manage !== undefined) cfg.tailscale.manage = bool(t.manage, 'mesh.tailscale.manage');
    if (t.bin !== undefined) cfg.tailscale.bin = str(t.bin, 'mesh.tailscale.bin');
  }
}

function parseSwairm(raw: unknown, cfg: SwairmConfig): void {
  if (!isRecord(raw)) throw new ConfigError('config.yaml : swairm doit être un objet');
  rejectUnknown(raw, ['bin'], 'swairm.');
  if (raw.bin !== undefined) cfg.bin = strOrEmpty(raw.bin, 'swairm.bin');
}

function parseAgents(raw: unknown, cfg: AgentsConfig): void {
  if (!isRecord(raw)) throw new ConfigError('config.yaml : agents doit être un objet');
  rejectUnknown(raw, ['transport'], 'agents.');
  if (raw.transport !== undefined) {
    if (raw.transport !== 'pty' && raw.transport !== 'stream') {
      throw new ConfigError("config.yaml : agents.transport vaut 'pty' ou 'stream'");
    }
    cfg.transport = raw.transport;
  }
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
# mesh:                    # mesh swarph (chantier 12) ; cell vide = désactivé
#   bin: swarph
#   cell: ""               # ex. morzu-mac — sa propre identité, jamais celle d'une autre machine
#   cellFile: ""           # vide = ~/.config/swarph/cells/<cell>.yaml
#   gateway: ""            # ex. http://mesh-gw.example.ts.net:8788 (MESH_GATEWAY_URL, pas un secret)
#   stateRoot: ""          # vide = ~/swarph_state
#   tailscale:
#     manage: false        # true : A-I-D lance tailscale up/down à la connexion ; false : il le lit seulement
#     bin: /Applications/Tailscale.app/Contents/MacOS/Tailscale   # tailscale sous Linux
# swairm:
#   bin: ""                # vide = désactivé ; préférer un chemin absolu, le PATH du daemon diffère du shell
#                          # ex. /Users/vous/.local/bin/swairm
# agents:
#   transport: pty         # stream = claude/codex par pilote structuré (D63) ; pty = terminal (défaut)
`;

export function writeDefaultConfigIfAbsent(p: AidPaths): void {
  if (!existsSync(p.config)) writeFileSync(p.config, DEFAULT_FILE, { mode: 0o600 });
}

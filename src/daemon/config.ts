import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parse, parseDocument } from 'yaml';
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
  artefacts: ArtefactsConfig;
  modeHost: ModeHostConfig;
}

/** Bascule progressive D63 : `stream` passe `claude`/`codex` par pilote structuré plutôt que PTY. */
export interface AgentsConfig {
  transport: 'pty' | 'stream';
}

/** Chantier 30 (D162) : le second port, réservé aux artefacts. `null` = port du daemon + 10. */
export interface ArtefactsConfig {
  port: number | null;
}

/**
 * Chantier 31 (D171, D172) : le mode host par le tailnet. Éteint par défaut. `port` : celui des
 * appareils, que Tailscale Serve est seul à atteindre ; `null` = port du daemon + 20. La clé `host`
 * reste l'adresse d'écoute, toujours 127.0.0.1 : le mode host n'y touche pas.
 */
export interface ModeHostConfig {
  pda: boolean;
  code: boolean;
  push: boolean;
  actif: boolean;
  port: number | null;
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
  agents: { transport: 'stream' },
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
  artefacts: { port: null },
  modeHost: { actif: false, port: null, push: false, code: false, pda: false },
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
      'artefacts',
      'modeHost',
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
  if (doc.artefacts !== undefined) {
    if (!isRecord(doc.artefacts))
      throw new ConfigError('config.yaml : artefacts doit être un objet');
    rejectUnknown(doc.artefacts, ['port'], 'artefacts.');
    if (doc.artefacts.port !== undefined) {
      cfg.artefacts.port = positiveInt(doc.artefacts.port, 'artefacts.port', 65535);
    }
  }
  if (doc.modeHost !== undefined) {
    if (!isRecord(doc.modeHost)) throw new ConfigError('config.yaml : modeHost doit être un objet');
    rejectUnknown(doc.modeHost, ['actif', 'port', 'push', 'code', 'pda'], 'modeHost.');
    if (doc.modeHost.pda !== undefined) cfg.modeHost.pda = bool(doc.modeHost.pda, 'modeHost.pda');
    if (doc.modeHost.code !== undefined)
      cfg.modeHost.code = bool(doc.modeHost.code, 'modeHost.code');
    if (doc.modeHost.push !== undefined)
      cfg.modeHost.push = bool(doc.modeHost.push, 'modeHost.push');
    if (doc.modeHost.actif !== undefined) {
      cfg.modeHost.actif = bool(doc.modeHost.actif, 'modeHost.actif');
    }
    if (doc.modeHost.port !== undefined) {
      cfg.modeHost.port = positiveInt(doc.modeHost.port, 'modeHost.port', 65535);
    }
  }
  verifierPortAppareils(cfg);
  return cfg;
}

/** Le pont de redémarrage de l'app Tauri (`app/src-tauri/src/daemon_bridge.rs`). */
export const PORT_PONT_TAURI = 4871;

/** D171 : le port des appareils n'est ni celui du daemon, ni le pont Tauri, ni celui des artefacts. */
function verifierPortAppareils(cfg: AidConfig): void {
  const port = portAppareils(cfg);
  if (port === 0) return;
  const interdits: Array<[number, string]> = [
    [cfg.port, 'le port du daemon'],
    [PORT_PONT_TAURI, 'le pont de l’app'],
    [portArtefacts(cfg), 'le port des artefacts'],
  ];
  for (const [p, nom] of interdits) {
    if (port === p) {
      throw new ConfigError(`config.yaml : modeHost.port (${port}) ne peut pas être ${nom}`);
    }
  }
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

/**
 * Chantier 31 (D172) : l'interrupteur du mode host écrit `modeHost.actif` dans config.yaml, en
 * gardant le reste du fichier, commentaires compris. Le résultat est relu par `parseConfig`
 * avant d'être écrit : un fichier qui ne passerait plus n'est jamais posé.
 */
export function ecrireModeHostActif(p: AidPaths, actif: boolean): void {
  const doc = parseDocument(existsSync(p.config) ? readFileSync(p.config, 'utf8') : '');
  if (doc.errors.length > 0) throw new ConfigError("config.yaml illisible : rien n'est écrit");
  try {
    doc.setIn(['modeHost', 'actif'], actif);
  } catch {
    throw new ConfigError('config.yaml : modeHost doit être un objet');
  }
  const texte = doc.toString();
  parseConfig(texte);
  writeFileSync(p.config, texte);
}

export function ecrireModeHostPush(p: AidPaths, actif: boolean): void {
  const doc = parseDocument(existsSync(p.config) ? readFileSync(p.config, 'utf8') : '');
  if (doc.errors.length > 0) throw new ConfigError("config.yaml illisible : rien n'est écrit");
  try {
    doc.setIn(['modeHost', 'push'], actif);
  } catch {
    throw new ConfigError('config.yaml : modeHost doit être un objet');
  }
  const texte = doc.toString();
  parseConfig(texte);
  writeFileSync(p.config, texte);
}

export function ecrireModeHostCode(p: AidPaths, actif: boolean): void {
  const doc = parseDocument(existsSync(p.config) ? readFileSync(p.config, 'utf8') : '');
  if (doc.errors.length > 0) throw new ConfigError("config.yaml illisible : rien n'est écrit");
  try {
    doc.setIn(['modeHost', 'code'], actif);
  } catch {
    throw new ConfigError('config.yaml : modeHost doit être un objet');
  }
  const texte = doc.toString();
  parseConfig(texte);
  writeFileSync(p.config, texte);
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
#   transport: stream      # stream = claude/codex par pilote structuré (D63, défaut) ; pty = terminal
# modeHost:                # chantier 31 : le cockpit sur ton tailnet, jamais sur internet
#   actif: false           # s'active depuis Machines, sur le Mac seulement
#   port: 4890             # vide = port + 20 ; Tailscale Serve y envoie les appareils
`;

export function writeDefaultConfigIfAbsent(p: AidPaths): void {
  if (!existsSync(p.config)) writeFileSync(p.config, DEFAULT_FILE, { mode: 0o600 });
}

/** Chantier 30 (D162) : le port des artefacts ; un daemon sur un port libre (0, tests) donne 0. */
export function portArtefacts(config: AidConfig): number {
  if (config.artefacts.port !== null) return config.artefacts.port;
  return config.port === 0 ? 0 : config.port + 10;
}

/** Chantier 31 (D171) : le port des appareils ; un daemon sur un port libre (0, tests) donne 0. */
export function portAppareils(config: AidConfig): number {
  if (config.modeHost.port !== null) return config.modeHost.port;
  return config.port === 0 ? 0 : config.port + 20;
}

export function ecrireModeHostPda(p: AidPaths, actif: boolean): void {
  const doc = parseDocument(existsSync(p.config) ? readFileSync(p.config, 'utf8') : '');
  if (doc.errors.length > 0) throw new ConfigError("config.yaml illisible : rien n'est écrit");
  try {
    doc.setIn(['modeHost', 'pda'], actif);
  } catch {
    throw new ConfigError('config.yaml : modeHost doit être un objet');
  }
  const texte = doc.toString();
  parseConfig(texte);
  writeFileSync(p.config, texte);
}

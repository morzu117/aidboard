import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { AidPaths } from './paths.js';

export interface AidConfig {
  host: '127.0.0.1';
  port: number;
  editor: string[];
  env: { strip: string[] };
  terminal: { scrollback: number; logMaxBytes: number };
}

export const DEFAULT_CONFIG: AidConfig = {
  host: '127.0.0.1',
  port: 4870,
  editor: [],
  env: { strip: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] },
  terminal: { scrollback: 5000, logMaxBytes: 50 * 1024 * 1024 },
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
  rejectUnknown(doc, ['host', 'port', 'editor', 'env', 'terminal'], '');

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
    rejectUnknown(doc.terminal, ['scrollback', 'logMaxBytes'], 'terminal.');
    if (doc.terminal.scrollback !== undefined) {
      cfg.terminal.scrollback = positiveInt(doc.terminal.scrollback, 'terminal.scrollback');
    }
    if (doc.terminal.logMaxBytes !== undefined) {
      cfg.terminal.logMaxBytes = positiveInt(doc.terminal.logMaxBytes, 'terminal.logMaxBytes');
    }
  }
  return cfg;
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
`;

export function writeDefaultConfigIfAbsent(p: AidPaths): void {
  if (!existsSync(p.config)) writeFileSync(p.config, DEFAULT_FILE, { mode: 0o600 });
}

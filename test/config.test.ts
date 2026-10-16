import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  ConfigError,
  DEFAULT_CONFIG,
  loadConfig,
  parseConfig,
  writeDefaultConfigIfAbsent,
} from '../src/daemon/config.js';
import { ensureHome, resolvePaths } from '../src/daemon/paths.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'aid-cfg-'));

test('sans fichier, les défauts', () => {
  expect(loadConfig(resolvePaths(tmp()))).toEqual(DEFAULT_CONFIG);
});

test('un fichier partiel est fusionné aux défauts', () => {
  const cfg = parseConfig('port: 5000\nterminal:\n  scrollback: 100\n');
  expect(cfg.port).toBe(5000);
  expect(cfg.terminal).toEqual({ ...DEFAULT_CONFIG.terminal, scrollback: 100 });
  expect(cfg.env.strip).toEqual(DEFAULT_CONFIG.env.strip);
});

test("host 0.0.0.0 est refusé avec un message qui l'explique", () => {
  expect(() => parseConfig('host: 0.0.0.0')).toThrow("A-I-D n'écoute que sur 127.0.0.1");
});

test('une clé inconnue est nommée', () => {
  expect(() => parseConfig('portt: 1')).toThrow('portt');
  expect(() => parseConfig('terminal:\n  scrolback: 1')).toThrow('terminal.scrolback');
});

test('un port invalide est refusé', () => {
  expect(() => parseConfig('port: 70000')).toThrow(ConfigError);
  expect(() => parseConfig('port: "4870"')).toThrow(ConfigError);
});

test('un fichier vide ou fait de commentaires donne les défauts', () => {
  expect(parseConfig('')).toEqual(DEFAULT_CONFIG);
  expect(parseConfig('# rien\n')).toEqual(DEFAULT_CONFIG);
});

test('le fichier par défaut créé est lisible et ne change rien', () => {
  const p = resolvePaths(tmp());
  writeDefaultConfigIfAbsent(p);
  expect(loadConfig(p)).toEqual(DEFAULT_CONFIG);
  expect(statSync(p.config).mode & 0o777).toBe(0o600);
});

test('ensureHome pose 0700, y compris sur un dossier déjà en 0755', () => {
  const home = tmp();
  mkdirSync(join(home, 'logs'), { mode: 0o755 });
  writeFileSync(join(home, 'x'), '');
  const p = resolvePaths(home);
  ensureHome(p);
  for (const d of [p.home, p.logs, p.actionLogs, p.worktrees, p.spool]) {
    expect(statSync(d).mode & 0o777).toBe(0o700);
  }
});

import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { fakeReleaseServer } from './helpers/release.js';

const sh = promisify(execFile);
const script = join(import.meta.dirname, '..', 'scripts', 'install-server.sh');

// Jamais le réseau : AID_SERVER_BASE_URL pointe sur le serveur local du test (13.6, DR9).
const run = (home: string, base: string, extra: Record<string, string> = {}) =>
  sh('sh', [script], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      AID_HOME: home,
      AID_SERVER_BASE_URL: base,
      // locale d'un Terminal macOS : bash 3.2 y collait le « … » de « $name… » au nom de variable (unbound variable sous set -u)
      LANG: 'en_US.UTF-8',
      ...extra,
    },
  }).then(
    (r) => ({ code: 0, out: r.stdout + r.stderr }),
    (err: { code?: number; stdout: string; stderr: string }) => ({
      code: err.code ?? 1,
      out: err.stdout + err.stderr,
    }),
  );

test('install-server.sh : installe la version servie sous AID_HOME/server, current → version, bin/aid répond', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aid-ish-'));
  const srv = await fakeReleaseServer('0.2.0');
  try {
    const r = await run(home, `${srv.base}/download`);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('AID Server 0.2.0 installé');
    expect(r.out).toContain(`${join(home, 'server', 'current')}/bin`);
    expect(readlinkSync(join(home, 'server', 'current'))).toBe('0.2.0');
    expect(existsSync(join(home, 'server', '0.2.0.partial'))).toBe(false);
    const v = await sh(join(home, 'server', 'current', 'bin', 'aid'), ['--version']);
    expect(v.stdout.trim()).toBe('aidboard 0.2.0');

    // seconde fois : rien à télécharger, current reposé
    const again = await run(home, `${srv.base}/download`, { AID_SERVER_VERSION: '0.2.0' });
    expect(again.code).toBe(0);
    expect(again.out).toContain('déjà installé');
    expect(readlinkSync(join(home, 'server', 'current'))).toBe('0.2.0');
  } finally {
    await srv.close();
  }
});

test('install-server.sh : somme fausse → code 1, rien d’installé, pas de partiel', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aid-ish-'));
  const srv = await fakeReleaseServer('0.2.0', { corrupt: true });
  try {
    const r = await run(home, `${srv.base}/download`);
    expect(r.code).toBe(1);
    expect(r.out).toContain('SHA-256');
    expect(existsSync(join(home, 'server', '0.2.0'))).toBe(false);
    expect(existsSync(join(home, 'server', '0.2.0.partial'))).toBe(false);
    expect(existsSync(join(home, 'server', 'current'))).toBe(false);
  } finally {
    await srv.close();
  }
});

test('install-server.sh : archive introuvable (version inconnue) → code 1 sans rien installer', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aid-ish-'));
  const srv = await fakeReleaseServer('0.2.0');
  try {
    const r = await run(home, `${srv.base}/download`, { AID_SERVER_VERSION: '0.9.0' });
    expect(r.code).not.toBe(0);
    expect(existsSync(join(home, 'server', 'current'))).toBe(false);
  } finally {
    await srv.close();
  }
});

test.each([false, true])('current → A, installer B (mv BSD simulé : %s)', async (bsd) => {
  const home = mkdtempSync(join(tmpdir(), 'aid-ish-'));
  const premiere = await fakeReleaseServer('0.2.0');
  const seconde = await fakeReleaseServer('0.3.0');
  const extra: Record<string, string> = {};
  if (bsd) {
    const bin = join(home, 'bin');
    mkdirSync(bin);
    // Sans -h, le mv BSD suit current ; -T est refusé avant toute mutation.
    writeFileSync(
      join(bin, 'mv'),
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const options = args.filter((arg) => arg.startsWith('-')).join('');
if (options.includes('T')) process.exit(1);
const [source, cible] = args.filter((arg) => !arg.startsWith('-'));
let destination = cible;
if (!options.includes('h') && fs.existsSync(cible) && fs.statSync(cible).isDirectory()) {
  destination = path.join(cible, path.basename(source));
}
fs.renameSync(source, destination);
`,
      { mode: 0o755 },
    );
    extra.PATH = `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`;
  }
  try {
    const a = await run(home, `${premiere.base}/download`, extra);
    expect(a.code, a.out).toBe(0);
    expect(readlinkSync(join(home, 'server', 'current'))).toBe('0.2.0');
    const b = await run(home, `${seconde.base}/download`, extra);
    expect(b.code, b.out).toBe(0);
    expect(readlinkSync(join(home, 'server', 'current'))).toBe('0.3.0');
    for (const dossier of [join(home, 'server'), join(home, 'server', '0.2.0')]) {
      expect(readdirSync(dossier).filter((nom) => nom.startsWith('.current-'))).toEqual([]);
    }
  } finally {
    await premiere.close();
    await seconde.close();
  }
});

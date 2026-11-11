import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { defaultEditor, editorCommand, openInEditor } from '../src/daemon/actions/editor.js';
import { waitFor } from './helpers/daemon.js';

const wsl = 'Linux version 5.15.0-microsoft-standard-WSL2';
const repertoire = mkdtempSync(join(tmpdir(), 'aid-editeur-wsl-'));
beforeEach(() => {
  mkdirSync(repertoire, { recursive: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(repertoire, { recursive: true, force: true });
});

test('WSL : code prime, puis wslview, puis explorer ; les autres plateformes restent identiques', () => {
  expect(defaultEditor('linux', true, wsl)).toEqual(['code', '{path}']);
  expect(defaultEditor('linux', false, wsl, (bin) => bin === 'wslview')).toEqual([
    'wslview',
    '{path}',
  ]);
  expect(defaultEditor('linux', false, wsl, () => false)).toEqual(['explorer.exe', '{path}']);
  expect(defaultEditor('linux', false, 'Linux version 6.1', () => true)).toEqual([
    'xdg-open',
    '{path}',
  ]);
  expect(defaultEditor('darwin', false, wsl)).toEqual([
    'open',
    '-a',
    'Visual Studio Code',
    '{path}',
  ]);
  expect(editorCommand(['vim', '{path}'], 'linux')).toEqual(['vim', '{path}']);
});

test('explorer reçoit le chemin converti par wslpath en argv, sans shell', async () => {
  const sortie = join(repertoire, 'sortie');
  const conversion = join(repertoire, 'conversion');
  writeFileSync(
    join(repertoire, 'wslpath'),
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$CONVERSION"\nprintf "%s\\n" "C:\\exemple avec espaces;\\$(commande)"\n',
    { mode: 0o755 },
  );
  writeFileSync(join(repertoire, 'explorer.exe'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$SORTIE"\n', {
    mode: 0o755,
  });
  vi.stubEnv('PATH', repertoire);
  vi.stubEnv('CONVERSION', conversion);
  vi.stubEnv('SORTIE', sortie);
  const chemin = '/tmp/exemple avec espaces;$(commande)';
  await openInEditor(['explorer.exe', '{path}'], chemin);
  await waitFor(
    () => {
      try {
        return readFileSync(sortie, 'utf8').endsWith('\n');
      } catch {
        return false;
      }
    },
    3000,
    'arguments explorer',
  );
  expect(readFileSync(conversion, 'utf8')).toBe(`-w\n${chemin}\n`);
  expect(readFileSync(sortie, 'utf8')).toBe('C:\\exemple avec espaces;$(commande)\n');
  rmSync(join(repertoire, 'wslpath'));
  await expect(openInEditor(['explorer.exe', '{path}'], chemin)).rejects.toThrow(/ENOENT/);
});

test('wslview reçoit le chemin Linux intact, sans conversion', async () => {
  const sortie = join(repertoire, 'sortie');
  writeFileSync(join(repertoire, 'wslview'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$SORTIE"\n', {
    mode: 0o755,
  });
  vi.stubEnv('PATH', repertoire);
  vi.stubEnv('SORTIE', sortie);
  const chemin = '/tmp/avec espaces;$(commande)';
  await openInEditor(['wslview', '{path}'], chemin);
  await waitFor(
    () => {
      try {
        return readFileSync(sortie, 'utf8') === `${chemin}\n`;
      } catch {
        return false;
      }
    },
    3000,
    'arguments wslview',
  );
});

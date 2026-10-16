import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { readVersion } from '../src/cli/version.js';

test('la version du CLI est celle de package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(readVersion()).toBe(pkg.version);
});

test('readVersion remonte jusqu’au package.json de aidboard, d’où qu’on parte', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'aid-ver-'));
  writeFileSync(join(root, 'package.json'), '{"name":"aidboard","version":"9.9.9"}');
  mkdirSync(join(root, 'dist', 'cli'), { recursive: true });
  expect(readVersion(join(root, 'dist'))).toBe('9.9.9');
  expect(readVersion(join(root, 'dist', 'cli'))).toBe('9.9.9');
  const other = mkdtempSync(join(tmpdir(), 'aid-ver2-'));
  writeFileSync(join(other, 'package.json'), '{"name":"autre","version":"1.0.0"}');
  expect(() => readVersion(other)).toThrow('introuvable');
});

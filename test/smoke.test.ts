import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { readVersion } from '../src/cli/version.js';

test('la version du CLI est celle de package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(readVersion()).toBe(pkg.version);
});

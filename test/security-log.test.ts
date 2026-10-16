import { expect, test } from 'vitest';
import { redactToken } from '../src/daemon/server.js';

test('le token d’ouverture est masqué dans les journaux', () => {
  expect(redactToken('/?token=abc123&x=1')).toBe('/?token=***&x=1');
  expect(redactToken('/auth?token=abc')).toBe('/auth?token=***');
  expect(redactToken('/api/state')).toBe('/api/state');
  expect(redactToken(undefined)).toBe('');
});

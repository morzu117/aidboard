import { expect, test } from 'vitest';
import { depuisCourt } from '../../web/src/ui/depuis.js';

const now = Date.parse('2026-10-27T12:00:00.000Z');
const iso = (msAvant: number) => new Date(now - msAvant).toISOString();

test('depuisCourt : bornes 44 s / 45 s', () => {
  expect(depuisCourt(iso(44_000), now)).toBe('maintenant');
  expect(depuisCourt(iso(45_000), now)).toBe('1 min');
});

test('depuisCourt : bornes 59 min / 60 min', () => {
  expect(depuisCourt(iso(59 * 60_000), now)).toBe('59 min');
  expect(depuisCourt(iso(60 * 60_000), now)).toBe('1 h');
});

test('depuisCourt : bornes 23 h / 24 h', () => {
  expect(depuisCourt(iso(23 * 3_600_000), now)).toBe('23 h');
  expect(depuisCourt(iso(24 * 3_600_000), now)).toBe('1 j');
});

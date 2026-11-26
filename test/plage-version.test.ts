import { describe, expect, it } from 'vitest';
import { extraireVersion, lirePlageVersion } from '../src/shared/plage-version.js';

describe('plages de version', () => {
  it.each([
    ['22', '22.12.1', '23.0.0'],
    ['22.12', '22.12.1', '22.13.0'],
    ['22.12.0', '22.12', '22.12.1'],
    ['=22', '22.0.0', '22.1.0'],
    ['>22 <=23', '23.0.0', '23.0.1'],
    ['>=22.12 <25', '22.12.0', '25.0.0'],
    ['>=22.12.1 <25 || 26', '26.2.0', '22.12.0'],
    ['^1.2.3', '1.9.0', '2.0.0'],
    ['^0.2.3', '0.2.9', '0.3.0'],
    ['^0.0.3', '0.0.3', '0.0.4'],
    ['~1.2.3', '1.2.9', '1.3.0'],
  ])('évalue %s', (plage, dedans, dehors) => {
    const accepte = lirePlageVersion(plage);
    expect(accepte(dedans)).toBe(true);
    expect(accepte(dehors)).toBe(false);
  });

  it.each(['', '22.x', '>= 22', '^1.2', '1.2.3.4', '22 ||', '22 || latest'])('refuse %j', (plage) =>
    expect(() => lirePlageVersion(plage)).toThrow(),
  );
});

describe('extraction de version', () => {
  it.each([
    ['v22.12.0', '22.12.0'],
    ['git version 2.43.0', '2.43.0'],
    ['10.9.2', '10.9.2'],
    ['mise 2025.1.6 linux-x64', '2025.1.6'],
  ])('lit %s', (sortie, version) => {
    expect(extraireVersion(sortie, '0.0.0')).toBe(version);
    expect(extraireVersion('', sortie)).toBe(version);
  });

  it('retient la première occurrence et accepte deux composantes', () => {
    expect(extraireVersion('version 2.1 (ancienne version 1.9.0)', '')).toBe('2.1');
    expect(extraireVersion('version inconnue', 'aucun numéro disponible')).toBeUndefined();
  });
});

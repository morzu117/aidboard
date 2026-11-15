import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { empreinteChemin, empreinteMesh, normaliserGateway } from '../src/shared/meshes.js';
import { jsonCanonique } from '../src/shared/pda.js';

test.each(['http://h', 'http://h:80', 'HTTP://H/'])('normalise %s', (url) => {
  expect(normaliserGateway(url)).toBe('http://h');
});

test('conserve les ports non standards et retire 443 en https', () => {
  expect(normaliserGateway('HTTPS://EXAMPLE.COM:443/')).toBe('https://example.com');
  expect(normaliserGateway('https://example.com:8443/')).toBe('https://example.com:8443');
  expect(normaliserGateway('http://example.com:443')).toBe('http://example.com:443');
});

test.each([
  'http://principal@example.com',
  'http://principal:exemple@example.com',
  'http://@example.com',
  'http://example.com?',
  'http://example.com?q=1',
  'http://example.com#',
  'http://example.com#fragment',
  'http://example.com/chemin',
  'http://example.com/chemin/..',
  'ftp://example.com',
  'example.com',
  'http://',
])('refuse %s', (url) => {
  expect(() => normaliserGateway(url)).toThrow();
});

test('empreintes canoniques : couples non concaténés, gateway absent et chemins absolus', () => {
  const hacher = (valeur: unknown) =>
    createHash('sha256').update(jsonCanonique(valeur)).digest('base64url');
  expect(hacher(['a', 'bc'])).not.toBe(hacher(['ab', 'c']));
  expect(empreinteMesh('principal', 'HTTP://H:80/')).toBe(hacher(['principal', 'http://h']));
  expect(empreinteMesh('principal', 'http://h')).toBe(empreinteMesh('principal', 'http://h:80'));
  expect(empreinteMesh('principal')).toBe(hacher(['principal', '']));
  expect(empreinteMesh('principal')).not.toBe(empreinteMesh('perso'));
  expect(empreinteChemin('./proxy.sock')).toBe(hacher([resolve('./proxy.sock')]));
  expect(empreinteChemin('./proxy.sock')).toBe(empreinteChemin(resolve('./proxy.sock')));
  expect(empreinteChemin('./proxy.sock')).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

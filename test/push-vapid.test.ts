import { createPublicKey, verify } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { chargerOuCreerCles } from '../src/daemon/push/vapid.js';

const dossiers: string[] = [];
afterEach(() => {
  for (const dossier of dossiers.splice(0)) rmSync(dossier, { recursive: true, force: true });
});
function dossierEtat() {
  const dossier = mkdtempSync(join(tmpdir(), 'aid-push-'));
  dossiers.push(dossier);
  return dossier;
}

test('clés persistées en 0600, relues et permissions trop larges refusées', () => {
  const dossier = dossierEtat();
  const cles = chargerOuCreerCles(dossier);
  const chemin = join(dossier, 'vapid.pem');
  const initial = readFileSync(chemin);
  expect(statSync(chemin).mode & 0o777).toBe(0o600);
  expect(chargerOuCreerCles(dossier).clePubliqueBase64url()).toBe(cles.clePubliqueBase64url());
  expect(readFileSync(chemin)).toEqual(initial);
  chmodSync(chemin, 0o644);
  expect(() => chargerOuCreerCles(dossier)).toThrow('0600');
  expect(readFileSync(chemin)).toEqual(initial);
});

test('JWT ES256 vérifié en ieee-p1363, origine, expiration et Authorization', () => {
  const cles = chargerOuCreerCles(dossierEtat());
  const maintenant = 1_800_000_000;
  const endpoint = 'https://example.com:8443/push/chemin?parametre=1';
  const jeton = cles.jetonVapid(endpoint, maintenant);
  const parties = jeton.split('.');
  expect(parties).toHaveLength(3);
  for (const partie of parties) expect(partie).toMatch(/^[A-Za-z0-9_-]+$/);
  const [entete, charge, signature] = parties as [string, string, string];
  expect(JSON.parse(Buffer.from(entete, 'base64url').toString())).toEqual({
    typ: 'JWT',
    alg: 'ES256',
  });
  const contenu = JSON.parse(Buffer.from(charge, 'base64url').toString());
  expect(contenu.aud).toBe('https://example.com:8443');
  expect(contenu.exp).toBe(maintenant + 12 * 3600 - 60);
  expect(contenu.exp).toBeLessThanOrEqual(maintenant + 12 * 3600);
  expect(contenu.sub).toBe('https://github.com/morzu117/aidboard');
  const publique = Buffer.from(cles.clePubliqueBase64url(), 'base64url');
  expect(publique.length).toBe(65);
  expect(publique[0]).toBe(4);
  const cle = createPublicKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: publique.subarray(1, 33).toString('base64url'),
      y: publique.subarray(33).toString('base64url'),
    },
  });
  const verifier = (texte: string, sig: string) =>
    verify(
      'sha256',
      Buffer.from(texte),
      { key: cle, dsaEncoding: 'ieee-p1363' },
      Buffer.from(sig, 'base64url'),
    );
  expect(Buffer.from(signature, 'base64url').length).toBe(64);
  expect(verifier(`${entete}.${charge}`, signature)).toBe(true);
  expect(verifier(`${entete}.${charge}a`, signature)).toBe(false);
  const autorisation = cles.enTeteAuthorization(endpoint, maintenant);
  expect(autorisation).toMatch(/^vapid t=[A-Za-z0-9_.-]+, k=[A-Za-z0-9_-]+$/);
  expect(autorisation.endsWith(`, k=${cles.clePubliqueBase64url()}`)).toBe(true);
  const jwt = autorisation.slice('vapid t='.length).split(',')[0]!.split('.');
  expect(verifier(`${jwt[0]}.${jwt[1]}`, jwt[2]!)).toBe(true);
});

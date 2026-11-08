import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { expect, test } from 'vitest';
import { chiffrer, chiffrerEnregistrement, TAILLE_CLAIR } from '../src/daemon/push/chiffre.js';

// Valeurs reprises du texte officiel https://www.rfc-editor.org/rfc/rfc8291.txt,
// section 5 et appendice A (consulté pour ce point).
const publique =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const auth = 'BTBZMqHH6r4Tts7J_aSIgg';
const clair = Buffer.from('When I grow up, I want to be a watermelon');
const alea = {
  sel: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
  clePrivee: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'),
};

test('RFC 8291 : corps complet identique au vecteur sans remplissage', () => {
  const attendu = Buffer.from(
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
      'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
      'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    'base64url',
  );
  expect(chiffrerEnregistrement(publique, auth, clair, 0, alea)).toEqual(attendu);
});

function dechiffrer(corps: Buffer, abonne: ReturnType<typeof createECDH>, secret: Buffer) {
  expect(corps.readUInt32BE(16)).toBe(4096);
  expect(corps[20]).toBe(65);
  const serveur = corps.subarray(21, 86);
  const materiel = hkdfSync(
    'sha256',
    abonne.computeSecret(serveur),
    secret,
    Buffer.concat([Buffer.from('WebPush: info\0'), abonne.getPublicKey(), serveur]),
    32,
  );
  const cle = hkdfSync(
    'sha256',
    Buffer.from(materiel),
    corps.subarray(0, 16),
    Buffer.from('Content-Encoding: aes128gcm\0'),
    16,
  );
  const nonce = hkdfSync(
    'sha256',
    Buffer.from(materiel),
    corps.subarray(0, 16),
    Buffer.from('Content-Encoding: nonce\0'),
    12,
  );
  const dechiffreur = createDecipheriv('aes-128-gcm', Buffer.from(cle), Buffer.from(nonce));
  dechiffreur.setAuthTag(corps.subarray(-16));
  const rempli = Buffer.concat([dechiffreur.update(corps.subarray(86, -16)), dechiffreur.final()]);
  let fin = rempli.length - 1;
  while (rempli[fin] === 0) fin--;
  expect(rempli[fin]).toBe(2);
  return rempli.subarray(0, fin);
}

test('aller-retour, taille fixe, limites et intégrité', () => {
  const abonne = createECDH('prime256v1');
  abonne.generateKeys();
  const secret = randomBytes(16);
  const cle = abonne.getPublicKey().toString('base64url');
  const authentification = secret.toString('base64url');
  for (const message of [Buffer.alloc(0), Buffer.from('{"n":1}'), Buffer.alloc(TAILLE_CLAIR, 42)]) {
    const corps = chiffrer(cle, authentification, message);
    expect(corps.length).toBe(86 + TAILLE_CLAIR + 1 + 16);
    expect(dechiffrer(corps, abonne, secret)).toEqual(message);
    corps[86] = corps[86]! ^ 1;
    expect(() => dechiffrer(corps, abonne, secret)).toThrow();
  }
  expect(() => chiffrer(cle, authentification, Buffer.alloc(TAILLE_CLAIR + 1))).toThrow(
    'trop long',
  );
  expect(() => chiffrer('invalide', authentification, clair)).toThrow();
  expect(() => chiffrer(cle, 'invalide', clair)).toThrow();
  expect(() =>
    chiffrer(Buffer.alloc(65, 4).toString('base64url'), authentification, clair),
  ).toThrow();
  expect(() => chiffrer(cle, authentification, clair, { sel: Buffer.alloc(1) })).toThrow();
});

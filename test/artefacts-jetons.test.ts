import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { DUREE_JETON_MS, JetonsArtefacts } from '../src/daemon/artefacts/jetons.js';

// Chantier 30 (D163) : un jeton limité dans le temps, pas à un seul usage.

function horloge(debut = 1_000_000) {
  let t = debut;
  return { maintenant: () => t, avancer: (ms: number) => (t += ms) };
}

test('un jeton de 32 octets, en base64url, qui désigne le contenu lu et son empreinte', () => {
  const h = horloge();
  const j = new JetonsArtefacts(h.maintenant);
  const contenu = Buffer.from('<p>rapport</p>');
  const { jeton, expireA } = j.emettre(contenu, 'html');
  expect(jeton).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(expireA).toBe(h.maintenant() + DUREE_JETON_MS);
  const lu = j.lire(jeton)!;
  expect(lu.contenu.equals(contenu)).toBe(true);
  expect(lu.type).toBe('html');
  expect(lu.empreinte).toBe(createHash('sha256').update(contenu).digest('hex'));
});

test('réutilisable pendant 10 minutes, introuvable à la dixième minute', () => {
  const h = horloge();
  const j = new JetonsArtefacts(h.maintenant);
  const { jeton } = j.emettre(Buffer.from('x'), 'svg');
  expect(j.lire(jeton)).not.toBeNull();
  h.avancer(DUREE_JETON_MS - 1);
  expect(j.lire(jeton)).not.toBeNull();
  expect(j.lire(jeton)).not.toBeNull();
  h.avancer(1);
  expect(j.lire(jeton)).toBeNull();
  expect(j.taille).toBe(0);
});

test('un jeton inconnu ne rend rien', () => {
  expect(new JetonsArtefacts().lire('inconnu')).toBeNull();
});

test('les expirés sont purgés à chaque émission', () => {
  const h = horloge();
  const j = new JetonsArtefacts(h.maintenant);
  j.emettre(Buffer.from('a'), 'html');
  j.emettre(Buffer.from('b'), 'html');
  h.avancer(DUREE_JETON_MS);
  j.emettre(Buffer.from('c'), 'html');
  expect(j.taille).toBe(1);
});

test('au plafond, le plus ancien jeton part', () => {
  const j = new JetonsArtefacts(Date.now, 3);
  const a = j.emettre(Buffer.from('a'), 'html').jeton;
  const b = j.emettre(Buffer.from('b'), 'html').jeton;
  j.emettre(Buffer.from('c'), 'html');
  j.emettre(Buffer.from('d'), 'html');
  expect(j.taille).toBe(3);
  expect(j.lire(a)).toBeNull();
  expect(j.lire(b)).not.toBeNull();
});

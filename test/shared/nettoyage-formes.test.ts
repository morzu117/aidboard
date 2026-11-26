import { expect, it } from 'vitest';
import { nettoyer } from '../../src/shared/nettoyage.js';

const debutPgp = '-----BEGIN PGP PRIVATE KEY BLOCK-----';
const piedPgp = '-----END PGP PRIVATE KEY BLOCK-----';
const debutJeton = 'ghp_0123456789ab';
const finJeton = 'cdefghijklmnopqrstuvwxyz';

it.each([
  ['utilisateur vide', 'redis://:pw12@cache.example.com'],
  ['barre oblique dans le mot de passe', 'postgres://u:a/b@db.example.com/base'],
  ['deux-points dans le mot de passe', 'redis://u:a:b@cache.example.com'],
  ['arobase encodée dans le mot de passe', 'redis://u:a%40b@cache.example.com'],
  ['deux-points encodés dans le mot de passe', 'redis://u:a%3Ab@cache.example.com'],
])('refuse une URL avec identifiants (%s)', (_cas, texte) => {
  expect(nettoyer(texte)).toEqual({ ok: false, classe: 'ressemble à une clé API' });
});

it.each([
  ['PGP avec pied', `${debutPgp}\ncontenu factice\n${piedPgp}`],
  ['PGP sans pied', `${debutPgp}\ncontenu factice`],
  ['OpenSSH tronquée à son en-tête', '-----BEGIN OPENSSH PRIVATE KEY-----'],
])('refuse une clé privée (%s)', (_cas, texte) => {
  expect(nettoyer(texte)).toEqual({ ok: false, classe: 'ressemble à une clé API' });
});

it.each([
  ['sans caractère de format', ''],
  ['U+00AD', '\u00ad'],
  ['U+2063', '\u2063'],
  ['U+180E', '\u180e'],
])('refuse un jeton fabriqué (%s)', (_cas, caractere) => {
  expect(nettoyer(debutJeton + caractere + finJeton)).toEqual({
    ok: false,
    classe: 'ressemble à une clé API',
  });
});

it.each(['host:10.0.0.5', 'ip=192.168.1.2', '[fd00::1]', 'addr=172.16.0.9:8080'])(
  'refuse une adresse privée collée (%s)',
  (texte) => {
    expect(nettoyer(texte)).toEqual({ ok: false, classe: 'adresse privée' });
  },
);

it.each([
  ['URL dont le chemin contient deux-points et arobase', 'https://example.com/a:b@c'],
  ['adresse de documentation seule', '192.0.2.1'],
  ['adresse de documentation collée à un mot', 'host:192.0.2.10'],
  ['heure', '10:00:00'],
  ['en-tête de clé publique', '-----BEGIN PUBLIC KEY-----'],
  ['texte français avec une césure', 'Le compte-rendu est dispo\u00adnible.'],
])('accepte un texte non sensible (%s)', (_cas, texte) => {
  expect(nettoyer(texte)).toEqual({ ok: true });
});

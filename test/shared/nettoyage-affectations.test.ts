import { expect, it } from 'vitest';
import { nettoyer } from '../../src/shared/nettoyage.js';

const sha = '0123456789abcdef0123456789abcdef01234567';

it.each([
  ['password avec préfixe et signe égal', 'DB_PASSWORD=hunter22'],
  ['password avec préfixe et deux-points', 'POSTGRES_PASSWORD: s3cr3tValue'],
  ['key avec valeur hexadécimale de 32 caractères', 'SECRET_KEY=' + sha.slice(0, 32)],
  ['token avec espaces autour du signe égal', 'api_token = abcd1234'],
  ['password avec un mot d’exemple contenu dans la valeur', 'password=testHunter99'],
  ['passwd avec tiret et casse mixte', 'service-PaSsWd: abcd1234'],
  ['pwd avec deux séparateurs de segments', 'service-cache_PwD=abcd1234'],
  ['secret avec tiret et minuscules', 'service-secret = abcd1234'],
  ['token avec une valeur de quatre caractères', 'token=abcd'],
  ['access_token', 'access_token=abcd1234'],
  ['refresh_token', 'refresh_token: abcd1234'],
  ['client_secret', 'client_secret=abcd1234'],
  ['private_key', 'private_key=abcd1234'],
  ['passphrase avec préfixe en majuscules', 'DB_PASSPHRASE=abcd1234'],
  ['credential avec préfixe', 'service_credential=abcd1234'],
  ['credentials avec préfixe', 'aws_credentials=abcd1234'],
  ['clé password entre guillemets doubles', '"password": "hunter2"'],
  ['clé secret entre guillemets simples', "'secret': 'abcd1234'"],
  ['clé api_key entre guillemets avec signe égal', '"api_key" = "abcd1234"'],
  ['clé entre guillemets dans un YAML multiligne', 'description: exemple\n"password": "hunter2"'],
  [
    'clé entre guillemets dans un JSON multiligne',
    '{\n  "description": "exemple",\n  "password": "hunter2"\n}',
  ],
  ['password avec un exemple entre chevrons', 'password: <mot-de-passe>'],
  ['password avec le mot test', 'password=test'],
  [
    'passwd avec un exemple entre guillemets doubles et en casse mixte',
    'service-PaSsWd: "ExAmPlE"',
  ],
  ['secret avec un exemple entre guillemets simples et en majuscules', "service-secret = 'NONE'"],
])('refuse une affectation de secret (%s)', (_cas, texte) => {
  expect(nettoyer(texte)).toEqual({ ok: false, classe: 'ressemble à une clé API' });
});

it.each([
  ['sha seul dans une phrase', `Le commit ${sha} est documenté.`],
  ['sha affecté à commit', `commit=${sha}`],
  ['sha affecté à head', `head: ${sha}`],
  ['sha affecté à base', `base=${sha}`],
  ['token avec le mot example', 'token = example'],
  ['password avec préfixe et le mot example', 'DB_PASSWORD=example'],
  [
    'password entre guillemets dans un JSON avec une autre propriété',
    '{"description":"exemple","password":"example"}',
  ],
  ['key avec une valeur vide', 'SECRET_KEY='],
  ['token avec une valeur de trois caractères', 'token=abc'],
  ['password présent dans un segment qui précède le dernier', 'service-password-label=abcd1234'],
])('accepte une valeur non secrète (%s)', (_cas, texte) => {
  expect(nettoyer(texte)).toEqual({ ok: true });
});

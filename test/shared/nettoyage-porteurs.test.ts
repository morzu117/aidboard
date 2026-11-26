// On assemble les jetons factices à l’exécution pour éviter les faux positifs de la protection GitHub.
import { expect, it } from 'vitest';
import { nettoyer } from '../../src/shared/nettoyage.js';

it.each([
  ['Authorization Basic', ['Authorization: Basic ', 'dXNlcjpw', 'YXNzd29y', 'ZA=='].join('')],
  ['Authorization Token', ['Authorization: Token ', 'abcd1234', 'efgh'].join('')],
  [
    'Authorization Digest en minuscules',
    `authorization: Digest username="${'u'}", response="${['abcd', 'ef12'].join('')}"`,
  ],
  ['Cookie', ['Cookie: session=', 'abcd1234', 'efgh'].join('')],
  ['Set-Cookie', ['Set-Cookie: sid=', 'abcd1234', 'efgh', '; Path=/'].join('')],
  [
    'premier paramètre access_token',
    ['https://api.example.com/v1?access_token=', 'abcd1234'].join(''),
  ],
  ['second paramètre token', ['https://api.example.com/v1?page=2&token=', 'abcd1234'].join('')],
  ['second paramètre sig', ['https://api.example.com/v1?page=2&sig=', 'abcd1234'].join('')],
  ['paramètre signature à un caractère', ['https://api.example.com/v1?signature=', 'a'].join('')],
  [
    'paramètre X-Amz-Signature',
    ['https://api.example.com/v1?X-Amz-Signature=', 'abcdef01', '23456789'].join(''),
  ],
  [
    'paramètre X-Amz-Credential',
    ['https://api.example.com/v1?X-Amz-Credential=', 'AKIDEXAM', 'PLE%2F20', '261126'].join(''),
  ],
  [
    'webhook Slack',
    [
      'https://hooks.slack.com/services',
      'T0123456789',
      'B0123456789',
      'AbCdEf0123456789GhIjKlMn',
    ].join('/'),
  ],
  [
    'webhook Discord',
    [
      'https://discord.com/api/webhooks',
      '123456789012345678',
      ['AbCdEf0123456789GhIjKlMn', 'OpQrStUvWxYz0123456789', 'AbCdEf0123456789GhIjKlMn'].join(''),
    ].join('/'),
  ],
  ['OAuth Google', ['ya29.', 'Abcdef01', '23456789', 'abcdef01', '23456789'].join('')],
  [
    'clé privée age',
    `${['AGE', 'SECRET', 'KEY', '1'].join('-')}${'ACDEFGHJKLMNPQRSTUVWXYZ023456789'.repeat(2).slice(0, 58)}`,
  ],
  ['DigitalOcean', `${['dop', 'v1', ''].join('_')}${'0123456789abcdef'.repeat(4)}`],
  [
    'SendGrid',
    `${['SG', ''].join('.')}${'Abcdef01234'.repeat(2)}.${'Abcdef01234'.repeat(4).slice(0, 43)}`,
  ],
  [
    'jeton d’application Slack',
    ['xapp', '1', 'A0123456789', '1234567890123', 'AbCdEf0123456789GhIjKlMn'].join('-'),
  ],
  ['bot Telegram', `${['123456789', 'AA'].join(':')}${'Abcdef01234'.repeat(3)}`],
  ['Stripe sk_test_', ['sk', 'test', 'AbCdEf0123456789GhIjKlMn'].join('_')],
  ['Stripe rk_test_', ['rk', 'test', 'AbCdEf0123456789GhIjKlMn'].join('_')],
])('refuse un porteur de secret (%s)', (_cas, texte) => {
  expect(nettoyer(texte)).toEqual({ ok: false, classe: 'ressemble à une clé API' });
});

it.each([
  ['mention de l’en-tête Authorization', "l'en-tête Authorization: est requis"],
  ['paramètre de pagination', 'https://example.com/?page=2'],
  ['paramètre sig vide', 'https://example.com/?sig='],
  ['URL de canal Discord', 'https://discord.com/channels/123/456'],
  ['abréviation SG.', 'Le compte rendu porte la mention SG. en marge.'],
  ['ya29 sans point', 'Le libellé ya29 figure dans le texte.'],
  ['heure', '12:34:56'],
])('accepte un texte non sensible (%s)', (_cas, texte) => {
  expect(nettoyer(texte)).toEqual({ ok: true });
});

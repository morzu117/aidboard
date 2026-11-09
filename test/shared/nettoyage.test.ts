import { expect, it } from 'vitest';
import { nettoyer } from '../../src/shared/nettoyage.js';
const jeton = 'aB1cD2eF3gH4iJ5kL6mN7oP8qR9';
const motifs = [
  ['anthropic', 'sk-ant-' + 'X'.repeat(8)],
  ['openai', 'sk-' + 'X'.repeat(16)],
  ['openai projet', 'sk-proj-' + 'X'.repeat(16)],
  ['openai service', 'sk-svcacct-' + 'X'.repeat(16)],
  ['xai', 'xai-' + 'X'.repeat(16)],
  ['google', 'AIza' + 'X'.repeat(35)],
  ['google final tiret', 'AIza' + 'X'.repeat(34) + '-'],
  ['google accolé', 'xAIza' + 'X'.repeat(35)],
  ['google accolé tiret', 'xAIza' + 'X'.repeat(34) + '-'],
  ...['gho_', 'ghp_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_'].map((p) => [p, p + 'X'.repeat(20)]),
  ...['xoxb-', 'xoxa-', 'xoxp-', 'xoxr-', 'xoxs-'].map((p) => [p, p + 'X'.repeat(8)]),
  ['jwt court', 'eyJX.eyJX'],
  ['jwt', 'eyJXXXXX.eyJXXXXX.XXXXX'],
  ...['AKIA', 'ASIA'].map((p) => [p, p + 'X'.repeat(16)]),
  ['pem', '-----BEGIN PRIVATE KEY-----\nfaux\n-----END PRIVATE KEY-----'],
  ['affectation simple', 'password=faux'],
  ['aws secret', 'aws_secret_access_key=' + 'X'.repeat(20)],
  ['aws session', 'aws_session_token="' + 'X'.repeat(20) + '"'],
  ...['hf_', 'npm_', 'glpat-', 'pypi-', 'sk_live_', 'rk_live_'].map((p) => [p, p + 'X'.repeat(16)]),
  ['bearer', 'Bearer ' + 'X'.repeat(12)],
  ['uri', 'https://exemple:faux@example.com'],
  ['sans schéma', 'exemple:faux@example.com'],
  ['dsn', 'pgpassword=faux'],
  ['mysql court', 'mysql -pfaux'],
  ['mysql long', 'mysql --password=faux'],
  ['docker', 'docker login -p faux'],
  ['sshpass', 'sshpass -p faux'],
  ['curl', 'curl -u exemple:faux'],
  ['affectation entropie', 'custom_credential=' + jeton],
  ['jeton isolé', jeton],
];
it.each(motifs)('refuse le motif %s sans recopier sa valeur', (_nom, texte) => {
  expect(nettoyer(texte!)).toEqual({ ok: false, classe: 'ressemble à une clé API' });
  expect(JSON.stringify(nettoyer(texte!))).not.toContain(texte!);
});
it.each([
  '100.64.1.2',
  '10.0.0.1',
  '172.16.0.1',
  '192.168.0.1',
  '127.0.0.1',
  '169.254.0.1',
  'fc00::1',
  'fd00::1',
  '::1',
  'fe80::1%eth0',
  '::ffff:100.64.1.2',
  '64:ff9b::6440:102',
  '100.64.1.2:443',
])('refuse la plage privée : %s', (texte) => {
  expect(nettoyer(texte)).toEqual({ ok: false, classe: 'adresse privée' });
});
it('détecte les hôtes, normalise Unicode et accepte le texte ordinaire', () => {
  for (const texte of [
    'aid-e2e.ts.net',
    'AID-E2E.TS.NET.',
    'aid-e2e.\u200bts.net',
    'ａｉｄ-e2e.ts.net',
  ])
    expect(nettoyer(texte)).toEqual({ ok: false, classe: 'hôte privé' });
  expect(nettoyer('sub.example.com', { hotesPrives: ['EXAMPLE.COM.'] })).toEqual({
    ok: false,
    classe: 'hôte privé',
  });
  expect(nettoyer('autreexample.com', { hotesPrives: ['example.com'] })).toEqual({ ok: true });
  for (const texte of [
    'Texte ordinaire',
    'example.com',
    '192.0.2.1',
    '203.0.113.1',
    '100.128.1.2',
    '172.32.0.1',
    '2001:db8::1',
    'a'.repeat(32),
    '0123456789abcdef'.repeat(2),
    '00000000-0000-0000-0000-000000000001',
    'foo__' + jeton,
    '.' + jeton + '.',
  ])
    expect(nettoyer(texte)).toEqual({ ok: true });
  expect(nettoyer('a'.repeat(20001))).toEqual({ ok: false, classe: 'texte trop long' });
});

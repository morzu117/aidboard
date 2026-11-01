import { expect, test } from 'vitest';
import { hasSecret, MASK, maskDeep, maskSecrets } from '../src/daemon/secrets.js';

/** Chantier 20, M.1 (DM1) : le détecteur de secrets du texte libre. */
const a36 = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

test('clés privées : bloc entier, bloc coupé, texte autour gardé', () => {
  const cle = [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ==',
    '-----END OPENSSH PRIVATE KEY-----',
  ].join('\n');
  expect(maskSecrets(`avant\n${cle}\naprès`)).toBe(`avant\nclé privée ${MASK}\naprès`);
  for (const kind of ['RSA ', 'EC ', 'ENCRYPTED ', '']) {
    const k = `-----BEGIN ${kind}PRIVATE KEY-----\nMIIEvQ\n-----END ${kind}PRIVATE KEY-----`;
    expect(maskSecrets(k), kind).toBe(`clé privée ${MASK}`);
  }
  expect(
    maskSecrets(
      '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----',
    ),
  ).toBe(`clé privée ${MASK}`);
  // coupée par une sortie tronquée : masquée jusqu'au bout
  expect(maskSecrets('cat id\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow')).toBe(
    `cat id\nclé privée ${MASK}`,
  );
  // deux clés : chacune la sienne, le texte entre les deux reste
  expect(maskSecrets(`${cle}\nentre\n${cle}`)).toBe(
    `clé privée ${MASK}\nentre\nclé privée ${MASK}`,
  );
  // une clé publique n'est pas un secret
  const pub = '-----BEGIN PUBLIC KEY-----\nMFkw\n-----END PUBLIC KEY-----';
  expect(maskSecrets(pub)).toBe(pub);
});

test('identifiants d’URL : mot de passe ou jeton masqué, nom simple gardé', () => {
  expect(maskSecrets('git clone https://deploy:s3cr3t@git.exemple/o/r.git')).toBe(
    `git clone https://${MASK}@git.exemple/o/r.git`,
  );
  // un `@` dans le mot de passe : jusqu'au dernier avant l'hôte
  expect(maskSecrets('https://u:p@ss@h.x/y')).toBe(`https://${MASK}@h.x/y`);
  expect(maskSecrets('postgres://app:motdepasse@db:5432/prod')).toBe(
    `postgres://${MASK}@db:5432/prod`,
  );
  expect(maskSecrets('https://x9f8e7d6c5b4a3928170@github.com/o/r')).toBe(
    `https://${MASK}@github.com/o/r`,
  );
  for (const ordinaire of [
    'ssh://git@github.com/o/r.git',
    'git@github.com:o/r.git',
    'https://github.com/o/r',
    'écrire à julien@exemple.fr',
  ])
    expect(maskSecrets(ordinaire), ordinaire).toBe(ordinaire);
});

test('jetons à préfixe connu : le préfixe reste, le reste disparaît', () => {
  const cas: [string, string][] = [
    [`ghp_${a36}`, `ghp_${MASK}`],
    [`gho_${a36}`, `gho_${MASK}`],
    [`github_pat_11ABCDEFG0123456789_abcdefghijklmnop`, `github_pat_${MASK}`],
    ['glpat-AbCdEfGhIjKlMnOpQrSt', `glpat-${MASK}`],
    ['xoxb-1234567890-abcdefghij', `xoxb-${MASK}`],
    ['AKIAIOSFODNN7EXAMPLE', `AKIA${MASK}`],
    ['sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv', `sk-ant-${MASK}`],
    ['sk-proj-AbCdEfGhIjKlMnOpQrStUv', `sk-proj-${MASK}`],
    ['sk-AbCdEfGhIjKlMnOpQrStUvWx', `sk-${MASK}`],
    ['sk_live_AbCdEfGhIjKlMnOp', `sk_live_${MASK}`],
    ['rk_test_AbCdEfGhIjKlMnOp', `rk_test_${MASK}`],
    ['AIzaSyA-1234567890abcdefghijklmnopqrstu', `AIza${MASK}`],
    [`npm_${a36}`, `npm_${MASK}`],
    ['hf_AbCdEfGhIjKlMnOpQrStUvWxYz0123', `hf_${MASK}`],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N', MASK],
  ];
  for (const [jeton, attendu] of cas) {
    expect(maskSecrets(jeton), jeton).toBe(attendu);
    expect(maskSecrets(`export TOKEN="${jeton}" # fin`), jeton).toBe(
      `export TOKEN="${attendu}" # fin`,
    );
  }
});

test('faux positifs écartés, masquage idempotent', () => {
  for (const ordinaire of [
    'task-list',
    'sk-learn',
    'pip install sk-video',
    'AKIA123',
    'pk_live_AbCdEfGhIjKlMnOp',
    'ghp_court',
    'eyJ seul',
    'un texte ordinaire, sans rien.',
    '',
  ])
    expect(maskSecrets(ordinaire), ordinaire).toBe(ordinaire);
  const brut = `https://u:p@h/x ghp_${a36} -----BEGIN RSA PRIVATE KEY-----\nMII\n-----END RSA PRIVATE KEY----- AKIAIOSFODNN7EXAMPLE`;
  const une = maskSecrets(brut);
  expect(une).not.toMatch(/u:p|A1b2C3|MII|IOSFODNN/);
  expect(maskSecrets(une)).toBe(une);
  expect(hasSecret(brut)).toBe(true);
  expect(hasSecret(une)).toBe(false);
});

test('maskDeep : chaque chaîne en profondeur, les clés et les autres valeurs intactes', () => {
  const v = {
    command: `curl -H "x: ghp_${a36}"`,
    args: ['https://a:b@h/x', 3, null, true],
    nested: { 'https://a:b@h/clé': { s: 'AKIAIOSFODNN7EXAMPLE' } },
  };
  expect(maskDeep(v)).toEqual({
    command: `curl -H "x: ghp_${MASK}"`,
    args: [`https://${MASK}@h/x`, 3, null, true],
    nested: { 'https://a:b@h/clé': { s: `AKIA${MASK}` } },
  });
  // l'original n'est pas modifié
  expect(v.args[0]).toBe('https://a:b@h/x');
});

import { expect, test } from 'vitest';
import { fichierSensible, filtrerDiff } from '../src/daemon/host/filtreCode.js';

test.each([
  '.htpasswd',
  'cles.jks',
  'cles.keystore',
  'service-account-test.json',
  '.env',
  '.envrc',
  '.env-prod',
  '.environment',
  'config/.env.local',
  'a/b/ID_ED25519',
  'id_ecdsa',
  'cle.PEM',
  '.git-credentials',
  'prod.tfvars',
  'terraform.tfstate.backup',
  'kubeconfig-prod',
  'credentials.json',
  'secrets.yaml',
  'x.kdbx',
  'x.ppk',
  '.env.production',
  'x.key',
  'x.p12',
  'x.pfx',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.pgpass',
  'x.tfstate',
])('refuse le fichier sensible %s', (nom) => expect(fichierSensible(nom)).toBe(true));

// « secrets* » exige le s final : « secretary » est donc autorisé.
test.each([
  'id_rsa.pub',
  'src/identity.ts',
  'README.md',
  'environment.ts',
  'secretary.md',
  'x.tfstateful',
])('autorise %s', (nom) => expect(fichierSensible(nom)).toBe(false));

test('masque les PEM ajoutés et reprend après la fin correspondante', () => {
  expect(
    filtrerDiff([
      '+-----BEGIN PRIVATE KEY-----',
      '+exemple',
      '+-----END CERTIFICATE-----',
      '+-----END PRIVATE KEY-----',
      '+suite',
    ]),
  ).toEqual(['+[masqué]', '+[masqué]', '+[masqué]', '+[masqué]', '+suite']);
});

test.each([
  '+-----BEGIN CERTIFICATE-----exemple-----END CERTIFICATE-----',
  '+"-----BEGIN PRIVATE KEY-----\\nexemple\\n-----END PRIVATE KEY-----"',
])('masque un PEM sur une seule ligne', (ligne) => {
  expect(filtrerDiff([ligne, '+suite'])).toEqual(['+[masqué]', '+suite']);
});

test('masque jusqu’à la fin sans END et réinitialise entre appels', () => {
  expect(filtrerDiff([' -----BEGIN PRIVATE KEY-----', '-exemple', '+suite'])).toEqual([
    ' [masqué]',
    '-[masqué]',
    '+[masqué]',
  ]);
  expect(filtrerDiff(['+suite'])).toEqual(['+suite']);
});

test.each([
  ['+password: [REDACTED:DSN_CREDENTIAL]', '+password: [masqué]'],
  ['+"api_key": "abc123def",', '+"api_key": "[masqué]",'],
  ['-db_password: hunter2', '-db_password: [masqué]'],
  [' AUTH_TOKEN=xyz', ' AUTH_TOKEN=[masqué]'],
  ['+token := "exemple";', '+token := "[masqué]";'],
  ["+private-key => 'exemple',", "+private-key => '[masqué]',"],
  ['+pwd = null', '+pwd = [masqué]'],
  ['+secret: true', '+secret: [masqué]'],
  ['+dsn: 123', '+dsn: [masqué]'],
  ['+password: ""', '+password: ""'],
  ['+password=', '+password='],
  ['+DB_PASS=motdepasse', '+DB_PASS=[masqué]'],
  ['+access_key: xyz', '+access_key: [masqué]'],
  ['+{"token":"abc", "pwd":"def"}', '+{"token":"[masqué]", "pwd":"[masqué]"}'],
])('masque la valeur et garde la syntaxe : %s', (ligne, attendu) => {
  expect(filtrerDiff([ligne])).toEqual([attendu]);
});

test('conserve les en-têtes et filtre le contexte des hunks', () => {
  const entetes = [
    'diff --git a/exemple b/exemple',
    'index abc123..def456 100644',
    '--- a/exemple',
    '+++ b/exemple',
    '@@ -1,2 +1,2 @@',
  ];
  expect(filtrerDiff([...entetes, '@@ -1 +1 @@ password: exemple'])).toEqual([
    ...entetes,
    '@@ -1 +1 @@ password: [masqué]',
  ]);
});

test('ne coupe pas une ligne ordinaire de 500 caractères', () => {
  const ligne = '+' + 'é'.repeat(500);
  expect(filtrerDiff([ligne])).toEqual([ligne]);
});

// Faux positif accepté : les hashes git ressemblent aux secrets hexadécimaux.
test('masque volontairement un hash git de 40 caractères dans le contenu', () => {
  expect(filtrerDiff(['+revision ' + 'abcdef0123'.repeat(4)])).toEqual(['+revision [masqué]']);
});

test.each([
  'passwd',
  'apiKey',
  'X_AUTH_TOKEN',
  'credential',
  'privateKey',
  'dsn',
  'conn_string',
  'connection-string',
  'connectionString',
])('reconnaît le nom sensible %s dans un identifiant', (nom) => {
  expect(filtrerDiff([`+${nom}=exemple`])).toEqual([`+${nom}=[masqué]`]);
});

test('applique le filtre de valeurs même après le caractère 140', () => {
  expect(filtrerDiff(['+' + 'é'.repeat(500) + ' https://example.com'])).toEqual([
    '+' + 'é'.repeat(500) + ' [masqué]',
  ]);
});

test.each([
  ['+{ password: "hunter2" }', '+{ password: "[masqué]" }'],
  ['+{"user":"u","password":"p"}', '+{"user":"u","password":"[masqué]"}'],
  ['+a = 1, token = x', '+a = 1, token = [masqué]'],
  ['+f(x, apiKey = k)', '+f(x, apiKey = [masqué])'],
  ['+cfg = { password: "hunter2" }', '+cfg = { password: "[masqué]" }'],
  ['+const cfg = { password: "hunter2" }', '+const cfg = { password: "[masqué]" }'],
])('trouve la clé sensible après du code ordinaire : %s', (ligne, attendu) => {
  expect(filtrerDiff([ligne])).toEqual([attendu]);
});

test('conserve les espaces, les tabulations et l’indentation avec ou sans masque', () => {
  expect(
    filtrerDiff([
      '+  "apiKey":"sk_live_abc",',
      '-\t  const  valeur = 1;  ',
      '   password: "exemple"  ',
      '@@ -1 +1 @@  fonction  ordinaire',
    ]),
  ).toEqual([
    '+  "apiKey":"[masqué]",',
    '-\t  const  valeur = 1;  ',
    '   password: "[masqué]"  ',
    '@@ -1 +1 @@  fonction  ordinaire',
  ]);
});

test.each([
  ['+headers["Authorization"] = "Bearer abc"', '+headers["Authorization"] = "[masqué]"'],
  ["+h['x-api-key'] = k", "+h['x-api-key'] = [masqué]"],
  [
    '+fetch(u, { headers: { Authorization: `Bearer ${t}` } })',
    '+fetch(u, { headers: { Authorization: `[masqué]` } })',
  ],
  ['+curl -H "Authorization: Basic dXNlcjpwYXNz"', '+curl -H "Authorization: [masqué]"'],
])('masque les clés d’en-tête et leurs valeurs : %s', (ligne, attendu) => {
  expect(filtrerDiff([ligne])).toEqual([attendu]);
});

test.each(['Bearer', 'basic', 'TOKEN', 'dIgEsT'])(
  'masque le schéma HTTP %s sans clé sensible',
  (schema) => {
    expect(filtrerDiff([`+  envoyer("${schema} exemple suite");`])).toEqual([
      `+  envoyer("${schema} [masqué] suite");`,
    ]);
  },
);

// Faux positifs acceptés par le lab : « pass » est cherché en sous-chaîne.
test.each(['bypass:', 'compass ='])('masque volontairement %s', (cle) => {
  expect(filtrerDiff([`+${cle} exemple`])).toEqual([`+${cle} [masqué]`]);
});

test('les faux en-têtes dans un hunk sont du contenu, les fichiers suivants ont leurs en-têtes', () => {
  const premier = [
    'diff --git a/a.sql b/a.sql',
    'index abc..def 100644',
    '--- a/a.sql',
    '+++ b/a.sql',
    '@@ -1 +1 @@',
  ];
  const second = [
    'diff --git a/b.sql b/b.sql',
    'index abc..def 100644',
    '--- a/b.sql',
    '+++ b/b.sql',
    '@@ -1 +1 @@',
  ];
  expect(
    filtrerDiff([
      ...premier,
      '--- DB_PASSWORD=hunter2',
      '+++ token=abc',
      '\\ No newline at end of file',
      ...second,
      '+DB_PASS=exemple',
    ]),
  ).toEqual([
    ...premier,
    '--- DB_PASSWORD=[masqué]',
    '+++ token=[masqué]',
    '\\ No newline at end of file',
    ...second,
    '+DB_PASS=[masqué]',
  ]);
});

test('masque une clé sans BEGIN mais conserve une phrase et un identifiant court', () => {
  const phrase = 'Une phrase ordinaire avec des espaces reste visible ici même';
  const court = 'aZ'.repeat(15);
  expect(
    filtrerDiff([
      '@@ -1 +1 @@',
      '+' + 'aZ+/'.repeat(16),
      '+  ' + 'aZ_-'.repeat(16) + '  ',
      '+' + phrase,
      '+' + court,
    ]),
  ).toEqual(['@@ -1 +1 @@', '+[masqué]', '+[masqué]', '+' + phrase, '+' + court]);
});

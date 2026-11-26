import { expect, it } from 'vitest';
import { nettoyer } from '../../src/shared/nettoyage.js';

const valeur = ['lune', '7', 'rivage', '42'].join('');
const identifiantsBasic = Buffer.from([['u', 'x'].join(''), valeur].join(':')).toString('base64');

it.each([
  ['en-tête préfixé Authorization', `> Authorization: Basic ${identifiantsBasic}`],
  ['en-tête préfixé Set-Cookie', `< Set-Cookie: sid=${valeur}; Path=/`],
  ['en-tête préfixé Cookie', `> Cookie: sid=${valeur}`],
  ['clé camelCase dbPassword', `{ dbPassword: "${valeur}" }`],
  ['clé camelCase apiToken en JSON', `{"apiToken": "${valeur}"}`],
  ['clé camelCase clientSecret', `clientSecret = ${valeur}`],
  ['segment final DB_PASS', `DB_PASS=${valeur}`],
  ['segment final SMTP_PASS', `SMTP_PASS: ${valeur}`],
  ['option --token à valeur séparée', `--token ${valeur}`],
  ['option --api-key à valeur séparée', `--api-key ${valeur}`],
  ['ligne de configuration .netrc', `machine example.com login bob password ${valeur}`],
  ['passphrase dans la prose', 'la passphrase : soleilété ouvre le coffre'],
  [
    'charge Basic au milieu d’une ligne',
    `Le client transmet Basic ${identifiantsBasic} au serveur.`,
  ],
])('refuse un secret (%s)', (_cas, texte) => {
  expect(nettoyer(texte)).toEqual({ ok: false, classe: 'ressemble à une clé API' });
});

it.each([
  ['en-tête préfixé Authorization sans valeur', '> Authorization:'],
  ['en-tête préfixé Set-Cookie sans valeur', '< Set-Cookie:'],
  ['mot keyboard', 'keyboard: azerty'],
  ['mot monkey', 'monkey: banane'],
  ['référence dans apiToken', 'apiToken: ${API_TOKEN}'],
  ['pass seul', 'pass: true'],
  ['mot bypass', `bypass: ${valeur}`],
  ['mention de token en prose', 'le token est expiré'],
  ['mention de password en prose', 'change ton password demain'],
  ['exemption de prose pour token', 'absence de token : requête rejetée'],
  ['mention de Basic en prose', "l'authentification Basic est désactivée"],
  ['libellé Basic Authentication', 'Basic Authentication'],
])('accepte un texte non sensible (%s)', (_cas, texte) => {
  expect(nettoyer(texte)).toEqual({ ok: true });
});

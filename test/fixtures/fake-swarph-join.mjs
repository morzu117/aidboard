#!/usr/bin/env node
import process from 'node:process';
import console from 'node:console';
import { setTimeout, setInterval } from 'node:timers';
import { readFileSync, writeFileSync, mkdirSync, fstatSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Le scénario vient d'un fichier voisin du binaire, jamais de variables du daemon.
const dossier = dirname(fileURLToPath(import.meta.url));
const scenario = JSON.parse(readFileSync(join(dossier, 'scenario.json'), 'utf8'));
if (process.argv[2] === '--version') {
  console.log(scenario.version ?? 'swarph-cli 0.80.0');
  process.exit(0);
}
const repertoire = join(process.env.HOME, '.config', 'swarph');
mkdirSync(repertoire, { recursive: true, mode: 0o700 });
const jeton = join(repertoire, `${scenario.cell ?? 'peer-a'}.peer_token`);
const inscription = join(repertoire, `${scenario.cell ?? 'peer-a'}.join.json`);
const entree = fstatSync(0);
const nul = statSync('/dev/null');
writeFileSync(
  join(dossier, 'constat.json'),
  JSON.stringify({
    entree: entree.isCharacterDevice() && entree.rdev === nul.rdev ? '/dev/null' : 'autre',
    python: process.env.PYTHONUNBUFFERED,
    variables: Object.keys(process.env).filter((cle) =>
      [
        'AID_SECRET_TEST',
        'PYTHONPATH',
        'SWARPH_SELF',
        'MESH_GATEWAY_URL',
        'MESH_GATEWAY_TOKEN',
        'GH_TOKEN',
        'GITHUB_TOKEN',
      ].includes(cle),
    ),
    arguments: process.argv.slice(2),
  }),
);
const fauxJeton = 'FAUX-JETON-NE-JAMAIS-SERVIR';
if (scenario.reserve) {
  writeFileSync(jeton, scenario.nonVide ? fauxJeton : '', { mode: 0o600 });
  writeFileSync(inscription, '', { mode: 0o600 });
}
process.on('SIGINT', () => {
  writeFileSync(join(dossier, 'signal'), 'SIGINT');
  if (scenario.ignore) return;
  if (scenario.reserve && !scenario.conserve) {
    unlinkSync(jeton);
    unlinkSync(inscription);
  }
  process.exit(1);
});
console.log(scenario.code ?? 'Code: ABCD-EFGH (expires in 15 minutes).');
if (scenario.lignes) for (const ligne of scenario.lignes) console.log(ligne);
if (scenario.bruit) console.log('x'.repeat(10_000));
const programmer = scenario.pilotage ? setInterval : setTimeout;
programmer(() => {
  if (scenario.pilotage)
    Object.assign(scenario, JSON.parse(readFileSync(join(dossier, 'scenario.json'), 'utf8')));
  if (scenario.attente) return;
  if (scenario.erreurs) {
    for (const ligne of scenario.erreurs) console.error(ligne);
    process.exit(1);
  }
  if (scenario.jetonAvantErreur) writeFileSync(jeton, fauxJeton, { mode: 0o600 });
  if (scenario.raison) {
    console.error(`swarph join: ${scenario.raison}`);
    process.exit(1);
  }
  if (scenario.sansJeton) process.exit(0);
  writeFileSync(jeton, fauxJeton, { mode: 0o600 });
  console.log(fauxJeton);
  if (scenario.temoin)
    console.log(
      'No interactive answers were supplied; no handshake was sent. Send your own answers to peer-b.',
    );
  process.exit(scenario.inattendu ? 1 : 0);
}, 250);
setInterval(() => {}, 1000);

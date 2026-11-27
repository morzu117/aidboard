import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { sh } from '../helpers/git.js';

export const origineBoucle = 'https://exemple.test/x.git';

export function poserOrigineBoucle(depot: string) {
  sh(depot, 'remote', 'set-url', 'origin', origineBoucle);
}

export function nommerDepotPourLesPreuves(depot: string) {
  // Les preuves lisent le nom résolu par remote get-url et attendent propriétaire/dépôt.
  sh(depot, 'config', '--local', 'url.https://exemple.test/projet/x.git.insteadOf', origineBoucle);
}

interface AppelGit {
  commande: string[];
  cwd: string;
  agentSsh: string | null;
  helper: string;
  config: string;
  retourConfig: number | null;
  entrees: string[];
}

export function poserTemoinGitBoucle(
  dossier: string,
  depot: string,
  observer?: 'commandes' | 'identifiants' | 'config',
  chemin = process.env.PATH,
) {
  const tete = sh(depot, 'rev-parse', 'refs/remotes/origin/main');
  const git = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const bin = mkdtempSync(join(dossier, 'temoin-git-'));
  const journal = join(bin, 'git.jsonl');
  writeFileSync(journal, '');
  writeFileSync(
    join(bin, 'git'),
    `#!/usr/bin/env node
const { appendFileSync, readdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const git = ${JSON.stringify(git)};
const observer = ${JSON.stringify(observer ?? null)};
const commande = process.argv.slice(2);
let i = 0;
while (['-c', '-C', '--git-dir', '--work-tree'].includes(commande[i]) ||
  /^--(?:git-dir|work-tree)=/.test(commande[i] ?? '')) {
  i += commande[i].startsWith('--') && commande[i].includes('=') ? 1 : 2;
}
const distante = commande.includes('ls-remote');
if (observer && (observer !== 'config' || distante || commande[i] === 'status')) {
  const appel = { commande, cwd: process.cwd(), agentSsh: process.env.SSH_AUTH_SOCK ?? null };
  if (observer === 'identifiants' || observer === 'config') {
    const lecture = observer === 'config' ? ['--show-origin', '--list'] : ['--get', 'credential.helper'];
    const config = spawnSync(git, [...commande.slice(0, i), 'config', ...lecture], { encoding: 'utf8' });
    if (config.error || ![0, 1].includes(config.status)) process.exit(1);
    appel.retourConfig = config.status;
    appel.config = config.stdout;
    appel.helper = config.stdout.trim();
    appel.entrees = readdirSync('.');
  }
  appendFileSync(${JSON.stringify(journal)}, JSON.stringify(appel) + '\\n');
}
if (distante) {
  process.stdout.write(${JSON.stringify(`${tete}\trefs/heads/main\n`)});
  process.exit(0);
}
const resultat = spawnSync(git, commande, { stdio: 'inherit' });
process.exit(resultat.status ?? 1);
`,
    { mode: 0o755 },
  );
  return {
    tete,
    chemin: [bin, chemin].join(delimiter),
    lire: (): AppelGit[] =>
      readFileSync(journal, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((ligne) => JSON.parse(ligne) as AppelGit),
  };
}

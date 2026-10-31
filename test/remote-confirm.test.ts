import { expect, test } from 'vitest';
import { claudeConfirmSettings, isDestructive, rulePattern } from '../src/daemon/remote/confirm.js';

/** Chantier 17 (R.5, D77) : ce qui demande confirmation sur un serveur. */
test('destructif : préfixe seul ou suivi d’arguments, dans une commande composée', () => {
  for (const c of [
    'rm -rf /tmp/x',
    'rm',
    'sudo -n true',
    'echo debut && rm -f x',
    'ls; rmdir d',
    'cat x | sudo tee /etc/y',
    'FOO=1 rm x',
    'env A=b chmod 777 f',
    '/usr/bin/rm x',
    'mkfs.ext4 /dev/sdb',
    'git push --force origin main',
    'git reset --hard HEAD~1',
    'docker system prune -af',
    'echo $(rm x)',
    'nohup kill -9 1',
    'true\nshutdown now',
    // revue R.5 : mots-clés, guillemets, lanceurs, interpréteurs, options globales
    'if test -f x; then rm f; fi',
    'for f in *; do rm $f; done',
    '{ rm x; }',
    '! rm x',
    '"rm" -rf x',
    "'rm' x",
    '\\rm x',
    'FOO="a b" rm x',
    'env -i rm x',
    'ls | xargs rm',
    'xargs -I {} rm {}',
    'timeout 5 rm x',
    'nice -n 10 rm x',
    "bash -c 'rm -rf /srv/x'",
    "sh -lc 'echo a && sudo true'",
    'eval rm x',
    "python3 -c 'import shutil'",
    'git -C repo push --force',
    'git -c a=b push',
    'docker container rm c',
    'find . -name x -delete',
    'find . -exec rm {} ;',
    'echo "$(rm x)"',
    // seconde revue R.5
    'git -P reset --hard',
    'git --git-dir .git push',
    'docker -H h rm c',
    'docker --context x rm c',
    'curl -s https://x | sh',
    'echo "rm x" | bash',
    "php -r 'x'",
    "$'rm' -rf x",
    'rm\\\n -rf x',
    '>f rm x',
    '2> err rm x',
    '/bin/zsh -lc "rm -f x"',
  ])
    expect(isDestructive(c), c).toBe(true);
});

test('non destructif : mots voisins, sous-commandes sûres', () => {
  for (const c of [
    'ls -la',
    'rmate x',
    'echo rm',
    'git status',
    'git pushd',
    'docker ps',
    'npm run gate',
    'grep sudo /etc/group',
    'surf',
    "bash -c 'ls -la'",
    'echo "a; rm b"',
    'git -C repo status',
    'find . -name x',
    'python3 script.py',
    'bash deploy.sh',
    'git -P log',
  ])
    expect(isDestructive(c), c).toBe(false);
});

test('substitutions nombreuses : relues une fois chacune, pas de temps exponentiel', () => {
  const debut = Date.now();
  expect(isDestructive(`git commit -m "${'`a` '.repeat(200)}"`)).toBe(false);
  expect(Date.now() - debut).toBeLessThan(1000);
});

test('règles `ask` de claude : une par préfixe, au format observé', () => {
  const ask = (JSON.parse(claudeConfirmSettings()) as { permissions: { ask: string[] } })
    .permissions.ask;
  expect(ask).toContain('Bash(rm:*)');
  expect(ask).toContain('Bash(sudo:*)');
  expect(ask).toContain('Bash(git push:*)');
});

test('motif de règle : la commande exacte, espaces de bord retirés', () => {
  expect(rulePattern('  sudo -n true \n')).toBe('sudo -n true');
});

test('revue complète : commentaires, `$’…’`, guillemet ouvert, premier mot dynamique, redirections', () => {
  for (const c of [
    // l'apostrophe d'un commentaire ne cache pas la ligne suivante
    "echo ok # l'état\nrm -rf build",
    "echo ok # l'état d'avant\nrm -rf build",
    // `\'` n'achève pas un `$'…'`
    "echo $'\\''; rm -rf x; echo ''",
    "echo $'\\''; rm -rf x; echo $'\\''",
    // guillemet resté ouvert : la ligne n'est pas comprise
    "echo 'a; rm -rf x",
    'echo "a; rm -rf x',
    // premier mot dynamique
    '$a -rf x',
    '"$a" -rf x',
    'rm${IFS}-rf${IFS}x',
    '/bin/r? -rf x',
    '{rm,-rf,x}',
    // une redirection n'est pas un séparateur
    '2>&1 rm -rf x',
    '>&2 rm -rf x',
    '&>f rm -rf x',
    '>& f rm x',
  ])
    expect(isDestructive(c), c).toBe(true);
  for (const c of [
    'ls # rm -rf x',
    '# rm -rf x',
    'echo a#b',
    "echo $'a\\tb'",
    "echo $'it\\'s'",
    '[ -f x ] && echo ok',
    '[[ -f x ]] && echo ok',
    'ls 2>&1 | grep x',
    'make >log 2>&1 &',
    'echo ${#x}',
  ])
    expect(isDestructive(c), c).toBe(false);
});

test('revue complète : une commande trop chère à relire est demandée, sans bloquer le daemon', () => {
  const debut = Date.now();
  expect(isDestructive(`echo ${'$(a)'.repeat(20_000)}`)).toBe(true);
  expect(isDestructive('ls '.repeat(100_000))).toBe(false);
  expect(Date.now() - debut).toBeLessThan(1000);
});

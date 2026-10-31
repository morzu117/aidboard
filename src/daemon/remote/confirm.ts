import type { PendingOption } from '../../shared/model.js';

/**
 * Chantier 17 (R.5, D77) : commandes « sudo et destructives » confirmées sur un serveur, même en mode automatique.
 * Un préfixe vaut pour la commande seule ou suivie d'arguments (`rm`, `rm -rf x`, pas `rmdir` pour `rm`). La même
 * liste sert deux fois : règles `ask` passées à claude, qui les applique avec son propre analyseur, et tri du
 * daemon (`isDestructive`), qui penche vers la demande. Les deux divergent : claude en `auto` ne soumet que ce que
 * ses règles rattrapent, le tri du daemon ne voit que ce qui lui est soumis (revue R.5). C'est un garde-fou, pas un
 * bac à sable : un script, `mv`, `sed -i` ou une redirection ne sont pas vus.
 */
export const DESTRUCTIVE_PREFIXES: readonly string[] = [
  'sudo',
  'su',
  'doas',
  'rm',
  'rmdir',
  'unlink',
  'dd',
  'mkfs',
  'shred',
  'truncate',
  'chmod',
  'chown',
  'kill',
  'pkill',
  'killall',
  'reboot',
  'shutdown',
  'halt',
  'poweroff',
  'systemctl',
  'crontab',
  'git push',
  'git reset',
  'git clean',
  'git restore',
  'git branch -D',
  'git stash drop',
  'git stash clear',
  'docker rm',
  'docker rmi',
  'docker container rm',
  'docker image rm',
  'docker volume rm',
  'docker system prune',
  'docker compose down',
];

/** Les boutons de la carte de confirmation (§11.3) ; `always` écrit une règle du serveur. */
export const CONFIRM_OPTIONS: PendingOption[] = [
  { label: 'Autoriser', answer: 'yes' },
  { label: 'Refuser', answer: 'no' },
  { label: 'Toujours autoriser dans ce dossier', answer: 'always' },
];

/**
 * `--settings` de claude : une règle `ask` par préfixe. Observé (2.1.308, D77) : respectée en `auto` comme en
 * `acceptEdits`, y compris dans une commande composée ; la demande porte `decision_reason_type: "rule"`.
 */
export function claudeConfirmSettings(): string {
  const ask = DESTRUCTIVE_PREFIXES.map((p) => `Bash(${p}:*)`);
  return JSON.stringify({ permissions: { ask } });
}

/**
 * Les commandes d'une ligne shell, chacune en mots sans guillemets : coupées sur `;`, `&&`, `||`, `|`, `&`, un saut
 * de ligne, une parenthèse ou une substitution, hors guillemets. Le contenu d'une substitution est relu à part.
 */
class Unparsed extends Error {}

/** Au-delà, la relecture des substitutions coûterait trop : la commande est demandée (revue complète). */
const READ_BUDGET = 4_000_000;

function segments(command: string, substitutions = true): string[][] {
  const out: string[][] = [];
  let words: string[] = [];
  let word: string | null = null;
  let quote: '"' | "'" | null = null;
  // `$'…'` : dans ces guillemets simples, `\` échappe le caractère suivant, `\'` compris (revue complète)
  let ansi = false;
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) out.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "'" && ansi && ch === '\\' && i + 1 < command.length) {
      word = (word ?? '') + command[++i];
      continue;
    }
    if (quote === "'" && ch === "'") ansi = false;
    if (quote === null && ch === '#' && word === null) {
      // commentaire en début de mot : ignoré jusqu'au saut de ligne, qui sépare encore (revue complète)
      while (i + 1 < command.length && command[i + 1] !== '\n') i++;
      continue;
    }
    if (
      quote === null &&
      ch === '&' &&
      (command[i - 1] === '>' ||
        command[i - 1] === '<' ||
        (command[i + 1] === '>' && command[i - 1] !== '&'))
    ) {
      // `2>&1`, `>&2`, `&>f` : une redirection, pas un séparateur (revue complète)
      word = (word ?? '') + ch;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
    } else if (ch === '\\' && command[i + 1] === '\n') {
      // ligne continuée : ni le `\` ni le saut de ligne ne comptent
      i++;
    } else if (ch === '\\' && i + 1 < command.length) {
      word = (word ?? '') + command[++i];
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      word ??= '';
    } else if (ch === '$' && command[i + 1] === "'") {
      // `$'…'` : chaîne entre guillemets simples
      ansi = true;
    } else if (/\s/.test(ch) && ch !== '\n') {
      endWord();
    } else if (';&|\n()`'.includes(ch) || (ch === '$' && command[i + 1] === '(')) {
      endSegment();
    } else {
      word = (word ?? '') + ch;
    }
  }
  // guillemet resté ouvert : la ligne n'est pas comprise, elle est demandée (revue complète)
  if (quote !== null && substitutions) throw new Unparsed();
  endSegment();
  // une substitution s'exécute aussi entre guillemets doubles : le texte qui la suit est relu comme une commande.
  // Chaque suffixe une fois, sans relecture de ses propres substitutions : la boucle les visite déjà (revue R.5)
  if (substitutions)
    for (const m of command.matchAll(/\$\(|`/g))
      out.push(...segments(command.slice(m.index + m[0].length), false));
  return out;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
/** Mots qui laissent passer la commande qui suit : mots-clés du shell et lanceurs. */
const WRAPPERS = new Set([
  ...['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}'],
  ...['env', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'timeout', 'stdbuf'],
  ...['setsid', 'xargs', 'busybox', 'ionice', 'chroot'],
]);
/** Options qui prennent leur valeur au mot suivant, par outil : les autres n'en prennent pas (revue R.5). */
const VALUED: Record<string, ReadonlySet<string>> = {
  wrapper: new Set(['-u', '-n', '-I', '-s', '-k', '-P', '-L', '-d', '-E', '-c', '--unset']),
  git: new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']),
  docker: new Set(['-H', '--host', '-c', '--context', '--config', '-l', '--log-level']),
};
/** Interpréteurs dont le code en ligne (`-c`, `-e`, `-r`) n'est pas analysable : demandé par principe. */
const INLINE_CODE = /^(python[0-9.]*|perl|ruby|node|php|lua)$/;
/** Redirection placée devant la commande (`>f rm x`, `2> err rm x`). */
const REDIRECT = /^\d*(>>?&?|<<?&?|&>>?)/;

function destructiveWords(input: string[]): boolean {
  let words = input;
  let wrapped = false;
  for (;;) {
    const w = words[0];
    if (w === undefined) return false;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      words = words.slice(1);
    } else if (REDIRECT.test(w)) {
      // `>f` porte sa cible, `>` seul la prend au mot suivant
      words = words.slice(REDIRECT.exec(w)![0] === w ? 2 : 1);
    } else if (WRAPPERS.has(w.replace(/^.*\//, ''))) {
      words = words.slice(1);
      wrapped = true;
    } else if (wrapped && w.startsWith('-')) {
      words = words.slice(VALUED.wrapper!.has(w) ? 2 : 1);
    } else if (wrapped && /^\d+[smhd]?$/.test(w)) {
      // durée de `timeout`, priorité de `nice`
      words = words.slice(1);
    } else break;
  }
  // premier mot dynamique (`$a`, `rm${IFS}-rf`, `/bin/r?`, `{rm,-rf,x}`) : illisible ici, demandé (revue complète)
  if (words[0] !== '[' && words[0] !== '[[' && /[$*?[{]/.test(words[0]!)) return true;
  // un chemin vaut son nom (`/usr/bin/rm`), `mkfs.ext4` vaut `mkfs`
  const first = words[0]!.replace(/^.*\//, '').replace(/^(mkfs)\..*$/, '$1');
  let rest = words.slice(1);
  if (first === 'eval') return isDestructive(rest.join(' '));
  if (SHELLS.has(first)) {
    const c = rest.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
    if (c >= 0) return rest[c + 1] !== undefined && isDestructive(rest[c + 1]!);
    // sans `-c` ni script : le shell lit son entrée (`curl … | sh`), rien d'analysable
    return rest.every((a) => a.startsWith('-'));
  }
  if (INLINE_CODE.test(first) && rest.some((a) => /^-[a-zA-Z]*[cer]$/.test(a))) return true;
  if (first === 'find') {
    if (rest.includes('-delete')) return true;
    const x = rest.findIndex((a) => a === '-exec' || a === '-execdir' || a === '-ok');
    return x >= 0 && destructiveWords(rest.slice(x + 1).filter((a) => a !== ';' && a !== '+'));
  }
  // options globales de git et docker, avant la sous-commande (`git -C dépôt push`)
  const valued = VALUED[first];
  if (valued && first !== 'wrapper') {
    while (rest[0]?.startsWith('-')) rest = rest.slice(valued.has(rest[0]) ? 2 : 1);
  }
  const h = [first, ...rest].join(' ');
  return DESTRUCTIVE_PREFIXES.some((p) => h === p || h.startsWith(`${p} `));
}

export function isDestructive(command: string): boolean {
  const substitutions = command.match(/\$\(|`/g)?.length ?? 0;
  if (command.length * (substitutions + 1) > READ_BUDGET) return true;
  try {
    return segments(command).some(destructiveWords);
  } catch (err) {
    if (err instanceof Unparsed) return true;
    throw err;
  }
}

/** Règle « Toujours autoriser sur ce serveur » : la commande exacte, espaces de bord retirés. */
export const rulePattern = (command: string): string => command.trim();

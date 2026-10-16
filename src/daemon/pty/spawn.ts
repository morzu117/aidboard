import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { findAssetDir } from '../assets.js';

export type SpawnKind = 'claude' | 'codex' | 'shell';

export function agentCommand(kind: SpawnKind, env: NodeJS.ProcessEnv): string[] {
  if (kind === 'shell') return [env.SHELL || '/bin/bash', '-l'];
  return [kind];
}

export function resolveOnPath(bin: string, pathVar: string): string | null {
  const executable = (p: string) => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (isAbsolute(bin)) return executable(bin) ? bin : null;
  for (const dir of pathVar.split(delimiter)) {
    const candidate = join(dir, bin);
    if (dir && executable(candidate)) return candidate;
  }
  return null;
}

// Marqueurs de la session Claude Code qui a éventuellement lancé le daemon : hérités, ils font croire à un `claude` lancé
// dans un sujet qu'il est un sous-processus de cette session (transcriptions coupées, mauvais canal de messagerie).
const SESSION_MARKERS =
  /^(CLAUDECODE|CLAUDE_PID|CLAUDE_AGENT_SDK_.+|CLAUDE_CODE_(CHILD_SESSION|SESSION_.+|ENTRYPOINT|EXECPATH|MESSAGING_.+|SSE_PORT))$/;

// Seuls les AID_* et le terminal sont ajoutés (§2 : A-I-D n'injecte rien d'autre dans un agent).
export function agentEnv(
  base: NodeJS.ProcessEnv,
  strip: string[],
  aid: Record<`AID_${string}`, string>,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of strip) delete env[key];
  for (const key of Object.keys(env)) if (SESSION_MARKERS.test(key)) delete env[key];
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...aid };
}

/**
 * Ce qu'il faut aux hooks Claude Code pour remonter les statuts (plan 06, E1) : le script livré et de quoi lancer la
 * CLI sans dépendre du PATH. Sans CLI construite (tests unitaires sur les sources), pas de hooks : ils ne font rien.
 */
export function hookEnv(
  find: (name: string, marker: string) => string = findAssetDir,
): Record<`AID_${string}`, string> {
  try {
    return {
      AID_HOOK: join(find('scripts/hooks', 'aid-hook.sh'), 'aid-hook.sh'),
      AID_NODE: process.execPath,
      AID_CLI: join(find('dist/cli', 'aid.js'), 'aid.js'),
    };
  } catch {
    return {};
  }
}

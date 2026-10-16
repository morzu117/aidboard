#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readVersion } from './version.js';

const HELP = `aidboard ${readVersion()} : cockpit local des agents de code

  aid             lance le daemon s'il ne tourne pas, puis ouvre le navigateur
  aid open        ouvre le navigateur sur le daemon qui tourne
  aid status      dit si le daemon tourne, et combien de sujets et d'agents
  aid stop        arrête le daemon (refusé s'il reste des agents ; --force pour tout arrêter)
  aid doctor      vérifie la machine (node-pty, git, claude, codex, codegraph…)
  aid daemon      lance le daemon au premier plan
  aid emit        publie un événement d'agent (appelé par les hooks ; sans effet hors A-I-D)
  aid hooks       état des hooks Claude Code ; install | uninstall modifient ~/.claude/settings.json
`;

async function main(): Promise<number> {
  // ses propres options, appelée par les hooks : avant l'analyse stricte des options globales
  if (process.argv[2] === 'emit') {
    const { runEmit } = await import('./commands/emit.js');
    return runEmit(process.argv.slice(3));
  }
  if (process.argv[2] === 'hook') {
    const { runHook } = await import('./commands/hook.js');
    return runHook(process.argv[3] ?? '');
  }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      force: { type: 'boolean' },
      foreground: { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const command = positionals[0] ?? 'start';
  if (values.version) {
    console.log(`aidboard ${readVersion()}`);
    return 0;
  }
  if (values.help || command === 'help') {
    console.log(HELP);
    return 0;
  }

  const { resolvePaths } = await import('../daemon/paths.js');
  const paths = resolvePaths();

  switch (command) {
    case 'daemon': {
      const { startDaemon } = await import('../daemon/main.js');
      let stopRequested: () => void = () => undefined;
      const handle = await startDaemon({
        logger: true,
        onStopRequested: () => stopRequested(),
      }).catch((err: Error) => {
        console.error(err.message);
        process.exit(1);
      });
      const stop = () => void handle.stop().then(() => process.exit(0));
      stopRequested = stop;
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return -1; // reste en vie
    }
    case 'start': {
      const { ensureRunning, StartFailed } = await import('./commands/start.js');
      const { openInBrowser } = await import('./commands/open.js');
      try {
        await openInBrowser(await ensureRunning(paths));
        return 0;
      } catch (err) {
        if (!(err instanceof StartFailed)) throw err;
        console.error(err.message);
        return 1;
      }
    }
    case 'open': {
      const { runningDaemon } = await import('./daemonInfo.js');
      const { openInBrowser } = await import('./commands/open.js');
      const info = await runningDaemon(paths);
      if (!info) {
        console.error('daemon arrêté : lancer aid');
        return 1;
      }
      await openInBrowser(info);
      return 0;
    }
    case 'status': {
      const { runningDaemon } = await import('./daemonInfo.js');
      const { statusLines } = await import('./commands/status.js');
      for (const l of await statusLines(await runningDaemon(paths))) console.log(l);
      return 0;
    }
    case 'stop': {
      const { runningDaemon } = await import('./daemonInfo.js');
      const { stopDaemon } = await import('./commands/stop.js');
      return stopDaemon(await runningDaemon(paths), values.force === true);
    }
    case 'hooks': {
      const { runHooks } = await import('./commands/hooks.js');
      return runHooks(positionals[1] ?? 'status');
    }
    case 'doctor': {
      const { runDoctor } = await import('./commands/doctor.js');
      return runDoctor(paths);
    }
    default:
      console.error(`commande inconnue : ${command}\n\n${HELP}`);
      return 1;
  }
}

const code = await main();
if (code >= 0) process.exit(code);

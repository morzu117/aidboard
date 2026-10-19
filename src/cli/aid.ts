#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { readVersion } from './version.js';

const HELP = `aidboard ${readVersion()} : cockpit local des agents de code

  aid             lance le daemon s'il ne tourne pas, puis ouvre le navigateur
  aid --cycle     comme \`aid\`, mais si un daemon tourne déjà : interrompt proprement ses
                  agents (résumé écrit, repris après coup), met à jour si possible, puis
                  relance quand même — c'est ce qu'ouvre AID.app, pas la commande nue
  aid open        ouvre le navigateur sur le daemon qui tourne (--reset : déconnecte d'abord
                  tous les navigateurs, y compris une app épinglée au Dock)
  aid status      dit si le daemon tourne, et combien de sujets et d'agents
  aid stop        arrête le daemon (refusé s'il reste des agents ; --force pour tout arrêter)
  aid doctor      vérifie la machine (node-pty, git, claude, codex, codegraph…)
  aid daemon      lance le daemon au premier plan
  aid emit        publie un événement d'agent (appelé par les hooks ; sans effet hors A-I-D)
  aid hooks       état des hooks Claude Code ; install | uninstall modifient ~/.claude/settings.json
  aid kernel install [--check]   matérialise le noyau multi-agents dans ~/.agent-kernel
  aid mem …       la mémoire des agents : get, put, search, list, rm, export, import, reindex
  aid mcp         serveur MCP « aid » (stdio) : mémoire et index structurel pour un agent
`;

async function main(): Promise<number> {
  // ces sous-commandes ont leurs propres options, appelées par les hooks ou directement :
  // avant l'analyse stricte des options globales
  const first = process.argv[2];
  if (first === 'emit') {
    const { runEmit } = await import('./commands/emit.js');
    return runEmit(process.argv.slice(3));
  }
  if (first === 'hook') {
    const { runHook } = await import('./commands/hook.js');
    return runHook(process.argv[3] ?? '');
  }
  if (first === 'mem') {
    const { resolvePaths } = await import('../daemon/paths.js');
    const { runMem } = await import('./commands/mem.js');
    return runMem(process.argv.slice(3), resolvePaths());
  }
  if (first === 'mcp') {
    const { resolvePaths } = await import('../daemon/paths.js');
    const { runMcp } = await import('./commands/mcp.js');
    await runMcp(resolvePaths());
    return -1; // vit tant que le client MCP tient stdin
  }
  if (first === 'kernel') {
    const { runKernel } = await import('./commands/kernel.js');
    return runKernel(process.argv[3] ?? '', process.argv.slice(4));
  }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      force: { type: 'boolean' },
      reset: { type: 'boolean' },
      cycle: { type: 'boolean' },
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
      const { checkForUpdate, repoRootFrom } = await import('../daemon/updateCheck.js');
      const { pullAndBuild, spawnRespawnWatcher } = await import('../daemon/selfUpdate.js');
      let stopRequested: () => void = () => undefined;
      let updateRequested: () => void = () => undefined;
      let cycleRequested: () => void = () => undefined;
      const handle = await startDaemon({
        logger: true,
        onStopRequested: () => stopRequested(),
        onUpdateRequested: () => updateRequested(),
        onCycleRequested: () => cycleRequested(),
      }).catch((err: Error) => {
        console.error(err.message);
        process.exit(1);
      });
      const stop = () => void handle.stop().then(() => process.exit(0));
      stopRequested = stop;
      // Bouton « Mettre à jour » de l'UI : pull + build pendant que ce daemon sert encore, puis
      // seulement s'ils réussissent, relance et sort. Un échec laisse l'ancien build tourner.
      updateRequested = () => {
        void (async () => {
          const entry = realpathSync(process.argv[1] ?? '');
          const dir = repoRootFrom(dirname(entry));
          if (!dir) {
            console.error('mise à jour : dépôt introuvable depuis le build en cours');
            return;
          }
          const result = await pullAndBuild(dir);
          if (!result.ok) {
            console.error(`mise à jour échouée (${result.step}) : ${result.error}`);
            return;
          }
          spawnRespawnWatcher(process.pid, entry, paths.home);
          stop();
        })();
      };
      // Ouverture d'AID.app avec un daemon déjà présent : interrompt proprement les agents vivants
      // (résumé écrit avant l'arrêt, repris au prochain démarrage via resumeFromManifest), met à
      // jour si un nouveau commit est dispo, puis relance toujours — même sans rien de nouveau.
      cycleRequested = () => {
        void (async () => {
          const { gracefulInterrupt } = await import('../daemon/pty/reprise.js');
          const { writeFileSync } = await import('node:fs');
          const entries = await gracefulInterrupt(handle.agents);
          if (entries.length > 0) writeFileSync(paths.repriseJson, JSON.stringify(entries));
          const entry = realpathSync(process.argv[1] ?? '');
          const dir = repoRootFrom(dirname(entry));
          if (dir) {
            const status = await checkForUpdate(dir).catch(() => null);
            if (status?.available) {
              const result = await pullAndBuild(dir);
              if (!result.ok)
                console.error(
                  `mise à jour échouée (${result.step}) : ${result.error} — relance sur le build actuel`,
                );
            }
          }
          spawnRespawnWatcher(process.pid, entry, paths.home);
          stop();
        })();
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return -1; // reste en vie
    }
    case 'start': {
      const { openInBrowser } = await import('./commands/open.js');
      if (values.cycle) {
        // --cycle (AID.app) : jamais une simple réutilisation (voir /api/daemon/cycle). Sans ce
        // drapeau, `aid` garde son comportement habituel (réutilise, ne redémarre jamais) : des
        // scripts/hooks en dépendent.
        const { runningDaemon, daemonFetch, pidAlive } = await import('./daemonInfo.js');
        const existing = await runningDaemon(paths);
        if (existing) {
          console.log('daemon déjà présent : interruption propre des agents, puis relance…');
          await daemonFetch(existing, 'POST', '/api/daemon/cycle');
          const deadline = Date.now() + 30_000;
          while (pidAlive(existing.pid) && Date.now() < deadline)
            await new Promise((r) => setTimeout(r, 150));
          let info = await runningDaemon(paths);
          while (!info && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 150));
            info = await runningDaemon(paths);
          }
          if (!info) {
            console.error('le nouveau daemon ne répond pas après le cycle');
            return 1;
          }
          await openInBrowser(info);
          return 0;
        }
      }
      const { ensureRunning, StartFailed } = await import('./commands/start.js');
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
      if (values.reset) {
        const { daemonFetch } = await import('./daemonInfo.js');
        const r = await daemonFetch(info, 'POST', '/api/session/reset');
        if (r.status !== 204) {
          console.error(`révocation refusée (${r.status}) : ${String(r.json.error ?? '')}`);
          return 1;
        }
        console.log('Sessions navigateur révoquées.');
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

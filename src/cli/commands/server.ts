import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { currentServer, installMode, serverDir } from '../../daemon/install.js';
import type { AidPaths } from '../../daemon/paths.js';
import { latestRelease, RELEASES_API_BASE, releaseByVersion } from '../../daemon/releaseCheck.js';
import {
  installedServers,
  installRelease,
  pruneServers,
  switchCurrent,
} from '../../daemon/selfUpdate.js';
import { repoRootFrom } from '../../daemon/updateCheck.js';
import { readVersion } from '../version.js';

export interface ServerDeps {
  fetchFn?: typeof fetch;
  /** base de l'API des releases (tests : un serveur local) */
  apiBase?: string;
  /** le build qui tourne (tests : un faux sous ~/.aid/server) */
  entry?: string;
  out?: (s: string) => void;
}

const REDEMARRER = 'Redémarre le daemon (aid stop, puis aid) pour la prendre.';

/**
 * `aid server status | install [version] | use <version>` (13.5, DR4) : l'installation d'AID
 * Server sous ~/.aid/server. `install` n'a de sens qu'en mode release — en mode repo, c'est le
 * clone qui fait foi ; pour passer en release, install-server.sh.
 */
export async function runServer(
  args: string[],
  paths: AidPaths,
  deps: ServerDeps = {},
): Promise<number> {
  const out = deps.out ?? console.log;
  const entry = deps.entry ?? realpathSync(process.argv[1] ?? '');
  const mode = installMode(entry, paths.home);
  const dir = serverDir(paths.home);
  const sub = args[0] ?? 'status';
  switch (sub) {
    case 'status': {
      out(`aidboard ${readVersion()}`);
      if (mode === 'repo') out(`installation : mode repo (clone ${repoRootFrom(dirname(entry))})`);
      else if (mode === 'release') out(`installation : release (${dir})`);
      else out(`installation : mode inconnu (${dirname(entry)}) — mise à jour désactivée`);
      const current = currentServer(paths.home)?.version;
      const list = installedServers(paths.home);
      if (list.length === 0) out(`aucune version sous ${dir}`);
      else
        out(
          `versions installées : ${list.map((v) => (v === current ? `${v} (current)` : v)).join(', ')}`,
        );
      return 0;
    }
    case 'install': {
      if (mode !== 'release') {
        out(
          `cette CLI tourne en mode ${mode} : rien à installer ici — install-server.sh installe AID Server sous ${dir}`,
        );
        return 1;
      }
      const wanted = args[1];
      const base = deps.apiBase ?? RELEASES_API_BASE;
      const release = wanted
        ? await releaseByVersion(wanted, deps.fetchFn, base)
        : await latestRelease(deps.fetchFn, `${base}/latest`);
      if (!release) {
        out(
          wanted
            ? `release ${wanted} introuvable (ou hors ligne)`
            : 'aucune release trouvée (hors ligne, quota GitHub, ou rien de publié)',
        );
        return 1;
      }
      if (currentServer(paths.home)?.version === release.version) {
        out(`${release.version} est déjà la version courante`);
        return 0;
      }
      const r = await installRelease(release, paths.home, { fetchFn: deps.fetchFn, log: out });
      if (!r.ok) {
        out(`installation échouée (${r.step}) : ${r.error}`);
        return 1;
      }
      const removed = pruneServers(paths.home);
      if (removed.length > 0) out(`versions retirées : ${removed.join(', ')}`);
      out(`AID Server ${release.version} installé : current → ${release.version}. ${REDEMARRER}`);
      return 0;
    }
    case 'use': {
      const v = args[1];
      if (!v) {
        out('usage : aid server use <version>');
        return 1;
      }
      if (!installedServers(paths.home).includes(v)) {
        out(`version ${v} absente de ${dir} : aid server install ${v}`);
        return 1;
      }
      switchCurrent(paths.home, v);
      out(`current → ${v}. ${REDEMARRER}`);
      return 0;
    }
    default:
      out(`sous-commande inconnue : ${sub} (status | install [version] | use <version>)`);
      return 1;
  }
}

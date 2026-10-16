import {
  hooksStatus,
  installHooks,
  settingsPath,
  uninstallHooks,
} from '../../daemon/hooks/claudeSettings.js';

/** `aid hooks [status|install|uninstall]` */
export function runHooks(action: string, out: (l: string) => void = console.log): number {
  const path = settingsPath();
  try {
    switch (action) {
      case 'status': {
        const s = hooksStatus(path);
        out(
          s.installed
            ? `✓ hooks Claude Code installés dans ${path}`
            : `⚠ hooks Claude Code absents (${s.missing.join(', ')}) : aid hooks install`,
        );
        return 0;
      }
      case 'install': {
        const r = installHooks(path);
        if (!r.changed) out(`✓ hooks déjà installés dans ${path}`);
        else {
          out(`✓ hooks installés dans ${path}`);
          if (r.backup) out(`  sauvegarde : ${r.backup}`);
          out('  les sessions claude déjà ouvertes ne les verront qu’après redémarrage');
        }
        return 0;
      }
      case 'uninstall': {
        const r = uninstallHooks(path);
        out(r.changed ? `✓ hooks A-I-D retirés de ${path}` : '✓ aucun hook A-I-D à retirer');
        if (r.changed && r.backup) out(`  sauvegarde : ${r.backup}`);
        return 0;
      }
      default:
        console.error(`aid hooks : action inconnue « ${action} » (status, install, uninstall)`);
        return 1;
    }
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}

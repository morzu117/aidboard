import type { AidPaths } from '../../daemon/paths.js';
import { openBrowser } from '../browser.js';
import { openUrl, type DaemonInfo } from '../daemonInfo.js';

export async function openInBrowser(
  info: DaemonInfo,
  out: (s: string) => void = console.log,
): Promise<void> {
  const url = openUrl(info);
  out(`A-I-D : ${url}`);
  if (process.env.AID_NO_BROWSER === '1') return;
  if (!(await openBrowser(url))) out('Navigateur introuvable : ouvre le lien ci-dessus à la main.');
}

export type { AidPaths };

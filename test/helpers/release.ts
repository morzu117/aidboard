import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetName } from '../../src/daemon/install.js';
import type { Release } from '../../src/daemon/releaseCheck.js';

export interface FakeReleaseServer {
  base: string;
  /** base de l'API des releases servie par ce serveur (…/releases) */
  apiBase: string;
  release: Release;
  close(): Promise<void>;
}

/**
 * Une fausse archive AID Server (bin/aid répond à --version, node/bin/node et dist/cli/aid.js
 * présents) servie par un serveur HTTP local, avec son SHA256SUMS — juste ou faux (`corrupt`),
 * et l'API GitHub minimale (/releases/latest, /releases/tags/v<version>). Jamais de réseau.
 */
export async function fakeReleaseServer(
  version: string,
  opts: { corrupt?: boolean; withoutAsset?: boolean } = {},
): Promise<FakeReleaseServer> {
  const work = mkdtempSync(join(tmpdir(), 'aid-rel-'));
  const stage = join(work, 'x');
  for (const d of ['bin', 'node/bin', 'dist/cli']) mkdirSync(join(stage, d), { recursive: true });
  writeFileSync(join(stage, 'bin', 'aid'), `#!/bin/sh\necho "aidboard ${version}"\n`);
  chmodSync(join(stage, 'bin', 'aid'), 0o755);
  writeFileSync(join(stage, 'node', 'bin', 'node'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(stage, 'dist', 'cli', 'aid.js'), '');
  writeFileSync(join(stage, 'VERSION'), `${version}\n`);
  const name = assetName(version);
  const archive = join(work, name);
  execFileSync('tar', ['czf', archive, '-C', stage, '.']);
  const bytes = readFileSync(archive);
  const sum = createHash('sha256').update(bytes).digest('hex');
  const sums = `${opts.corrupt ? '0'.repeat(64) : sum}  ${name}\n`;

  let base = '';
  const api = () => ({
    tag_name: `v${version}`,
    assets: [
      ...(opts.withoutAsset ? [] : [{ name, browser_download_url: `${base}/download/${name}` }]),
      { name: 'SHA256SUMS', browser_download_url: `${base}/download/SHA256SUMS` },
    ],
  });
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url === `/download/${name}`) return res.writeHead(200).end(bytes);
    if (url === '/download/SHA256SUMS') return res.writeHead(200).end(sums);
    if (url === '/releases/latest' || url === `/releases/tags/v${version}`)
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(api()));
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const release: Release = {
    version,
    assets: Object.fromEntries(api().assets.map((a) => [a.name, a.browser_download_url])),
  };
  return {
    base,
    apiBase: `${base}/releases`,
    release,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/** Une version « installée » sans archive : juste ce que installedServers/switchCurrent regardent. */
export function fakeInstalled(home: string, version: string): string {
  const dir = join(home, 'server', version);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  mkdirSync(join(dir, 'dist', 'cli'), { recursive: true });
  writeFileSync(join(dir, 'bin', 'aid'), `#!/bin/sh\necho "aidboard ${version}"\n`);
  chmodSync(join(dir, 'bin', 'aid'), 0o755);
  writeFileSync(join(dir, 'dist', 'cli', 'aid.js'), '');
  return dir;
}

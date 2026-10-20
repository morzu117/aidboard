import { expect, test } from 'vitest';
import { latestRelease, newerThan, parseVersion } from '../src/daemon/releaseCheck.js';

const github = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

const release = {
  tag_name: 'v0.3.0',
  assets: [
    {
      name: 'aid-server-0.3.0-darwin-arm64.tar.gz',
      browser_download_url:
        'https://github.com/x/y/releases/download/v0.3.0/aid-server-0.3.0-darwin-arm64.tar.gz',
    },
    {
      name: 'SHA256SUMS',
      browser_download_url: 'https://github.com/x/y/releases/download/v0.3.0/SHA256SUMS',
    },
    { name: 'sans-url' },
  ],
};

test('latestRelease : version sans le v, assets nom → URL (ceux sans URL ignorés)', async () => {
  const r = await latestRelease(github(release));
  expect(r).toEqual({
    version: '0.3.0',
    assets: {
      'aid-server-0.3.0-darwin-arm64.tar.gz':
        'https://github.com/x/y/releases/download/v0.3.0/aid-server-0.3.0-darwin-arm64.tar.gz',
      SHA256SUMS: 'https://github.com/x/y/releases/download/v0.3.0/SHA256SUMS',
    },
  });
});

test('latestRelease : hors ligne, quota (403), aucune release (404), tag qui n’est pas une version → null, jamais d’exception', async () => {
  const down = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  expect(await latestRelease(down)).toBeNull();
  expect(await latestRelease(github({ message: 'API rate limit exceeded' }, 403))).toBeNull();
  expect(await latestRelease(github({ message: 'Not Found' }, 404))).toBeNull();
  expect(await latestRelease(github({ tag_name: 'nightly', assets: [] }))).toBeNull();
  const garbage = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;
  expect(await latestRelease(garbage)).toBeNull();
});

test('latestRelease : interroge l’URL donnée avec un User-Agent (GitHub le refuse sinon)', async () => {
  let seen: { url: string; ua: string | undefined } | null = null;
  const spy = (async (url: string, init?: RequestInit) => {
    seen = { url, ua: (init?.headers as Record<string, string>)['user-agent'] };
    return new Response(JSON.stringify(release), { status: 200 });
  }) as unknown as typeof fetch;
  await latestRelease(spy, 'http://127.0.0.1:1/releases/latest');
  expect(seen).toEqual({ url: 'http://127.0.0.1:1/releases/latest', ua: 'aidboard' });
});

test('parseVersion et newerThan : semver, préversion jamais plus récente que sa finale', () => {
  expect(parseVersion('v0.2.0')).toBe('0.2.0');
  expect(parseVersion('0.2.0-rc1')).toBe('0.2.0-rc1');
  expect(parseVersion('latest')).toBeNull();
  expect(parseVersion(undefined)).toBeNull();
  expect(newerThan('0.2.0', '0.3.0')).toBe(true);
  expect(newerThan('0.2.9', '0.10.0')).toBe(true);
  expect(newerThan('0.3.0', '0.3.0')).toBe(false);
  expect(newerThan('0.3.0', '0.2.9')).toBe(false);
  expect(newerThan('0.3.0', '0.3.0-rc1')).toBe(false);
  expect(newerThan('0.3.0-rc1', '0.3.0')).toBe(true);
  expect(newerThan('0.3.0-rc1', '0.3.0-rc2')).toBe(true);
  expect(newerThan('0.3.0', 'nightly')).toBe(false);
});

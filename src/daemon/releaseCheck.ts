// Chantier 13.4 (DR6) : la dernière release GitHub du dépôt public, sans jeton. 60 requêtes/h/IP
// suffisent à un sondage toutes les 30 min ; un 403 (quota) ou un 404 (aucune release) valent
// « on ne sait pas », jamais une erreur affichée. Tout passe par `fetchFn` : les tests n'ont
// pas de réseau.

export const RELEASES_LATEST_URL = 'https://api.github.com/repos/morzu117/aidboard/releases/latest';

export interface Release {
  version: string;
  /** nom d'asset → URL de téléchargement (browser_download_url) */
  assets: Record<string, string>;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** `v0.2.0` ou `0.2.0` → `0.2.0` ; null pour tout tag qui n'est pas une version. */
export function parseVersion(tag: string | undefined | null): string | null {
  if (!tag) return null;
  const v = tag.startsWith('v') ? tag.slice(1) : tag;
  return SEMVER.test(v) ? v : null;
}

/** `latest` est-elle strictement plus récente que `current` ? Une préversion n'est jamais plus récente que sa version finale. */
export function newerThan(current: string, latest: string): boolean {
  const a = SEMVER.exec(current);
  const b = SEMVER.exec(latest);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(b[i]) - Number(a[i]);
    if (d !== 0) return d > 0;
  }
  const preA = a[4];
  const preB = b[4];
  if (preA === preB) return false;
  if (!preB) return true; // 0.3.0 > 0.3.0-rc1
  if (!preA) return false; // 0.3.0-rc1 < 0.3.0
  return preB > preA;
}

export async function latestRelease(
  fetchFn: typeof fetch = fetch,
  url = RELEASES_LATEST_URL,
): Promise<Release | null> {
  try {
    const res = await fetchFn(url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'aidboard' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      tag_name?: string;
      assets?: Array<{ name?: string; browser_download_url?: string }>;
    };
    const version = parseVersion(body.tag_name);
    if (!version) return null;
    const assets: Record<string, string> = {};
    for (const a of body.assets ?? []) {
      if (a.name && a.browser_download_url) assets[a.name] = a.browser_download_url;
    }
    return { version, assets };
  } catch {
    return null;
  }
}

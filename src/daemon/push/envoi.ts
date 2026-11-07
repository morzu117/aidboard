import { isIP } from 'node:net';
import { chiffrer } from './chiffre.js';
import type { ClesVapid } from './vapid.js';

export const HOTES_PUSH: readonly string[] = Object.freeze([
  'web.push.apple.com',
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
]);
export const TOPIC = 'aid';

export function verifierEndpoint(url: string): URL | null {
  try {
    const endpoint = new URL(url);
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.username !== '' ||
      endpoint.password !== '' ||
      (endpoint.port !== '' && endpoint.port !== '443')
    ) {
      return null;
    }
    const hote = endpoint.hostname;
    if (
      hote.endsWith('.') ||
      isIP(hote.replace(/^\[|\]$/g, '')) !== 0 ||
      !HOTES_PUSH.some((autorise) => hote === autorise || hote.endsWith('.' + autorise))
    ) {
      return null;
    }
    return endpoint;
  } catch {
    return null;
  }
}

export interface AbonnementPush {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface DependancesEnvoi {
  clesVapid: ClesVapid;
  /** Instant Unix en secondes. */
  maintenant?: () => number;
  transport?: (endpoint: URL, options: RequestInit) => Promise<Pick<Response, 'status' | 'body'>>;
}

export interface ResultatEnvoi {
  statut: 'ok' | 'expire' | 'echec';
  code?: number;
}

export async function envoyer(
  abonnement: AbonnementPush,
  n: number,
  deps: DependancesEnvoi,
): Promise<ResultatEnvoi> {
  const endpoint = verifierEndpoint(abonnement.endpoint);
  if (!endpoint) return { statut: 'echec' };
  try {
    const corps = chiffrer(abonnement.p256dh, abonnement.auth, Buffer.from(JSON.stringify({ n })));
    const reponse = await (deps.transport ?? fetch)(endpoint, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: {
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '300',
        Urgency: 'high',
        Topic: TOPIC,
        Authorization: deps.clesVapid.enTeteAuthorization(
          endpoint.href,
          deps.maintenant?.() ?? Math.floor(Date.now() / 1000),
        ),
      },
      body: new Uint8Array(corps),
    });
    // Libérer la connexion sans lire ni conserver le contenu du service distant.
    void reponse.body?.cancel().catch(() => {});
    const code = reponse.status;
    if (code === 404 || code === 410) return { statut: 'expire', code };
    return { statut: code >= 200 && code < 300 ? 'ok' : 'echec', code };
  } catch {
    // Les erreurs du transport peuvent contenir l'endpoint : ne jamais les propager.
    return { statut: 'echec' };
  }
}

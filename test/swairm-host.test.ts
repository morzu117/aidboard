import { afterEach, expect, test } from 'vitest';
import { RegistreAppareils } from '../src/daemon/host/appareils.js';
import { COOKIE_APPAREIL } from '../src/daemon/host/serveur.js';
import type { TailscaleExec } from '../src/daemon/mesh/tailscale.js';
import { startTestDaemon, type TestDaemon } from './helpers/daemon.js';

const nom = 'aid-e2e.ts.net';
let t: TestDaemon | undefined;
afterEach(async () => {
  await t?.d.stop();
});
const tailnet: TailscaleExec = async (_bin, args) =>
  args[0] === 'status'
    ? {
        stdout: JSON.stringify({
          BackendState: 'Running',
          Self: { DNSName: `${nom}.`, UserID: 1 },
          User: {},
        }),
        code: null,
      }
    : { stdout: '', code: null };
test('les cinq routes ask sont absentes du serveur host, même authentifié', async () => {
  t = await startTestDaemon(undefined, { tailscaleExec: tailnet });
  await t.d.app.inject({
    method: 'PUT',
    url: '/api/host',
    headers: t.headers,
    payload: { actif: true },
  });
  const { jeton } = new RegistreAppareils(t.db).emettre({ nom: 'Téléphone', identite: null });
  const app = t.d.modeHost.instance()!;
  for (const [method, url] of [
    ['GET', '/api/swairm/board'],
    ['GET', '/api/swairm/board/1/commits'],
    ['POST', '/api/swairm/ask'],
    ['POST', '/api/swairm/ask/annuler'],
    ['GET', '/api/swairm/ask/etat'],
    ['GET', '/api/swairm/asks'],
    ['GET', '/api/swairm/asks/20261109T071500Z-3f2a'],
  ] as const) {
    const r = await app.inject({
      method,
      url,
      headers: {
        host: nom,
        'sec-fetch-site': 'same-origin',
        'x-aid-cockpit': '1',
        origin: `https://${nom}`,
        cookie: `${COOKIE_APPAREIL}=${jeton}`,
        'X-AID-Confirm': 'ask',
      },
    });
    expect(r.statusCode, url).toBe(404);
  }
});

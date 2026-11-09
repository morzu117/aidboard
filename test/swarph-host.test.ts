import { afterEach, expect, test } from 'vitest';
import { RegistreAppareils } from '../src/daemon/host/appareils.js';
import { COOKIE_APPAREIL } from '../src/daemon/host/serveur.js';
import { startTestDaemon, type TestDaemon } from './helpers/daemon.js';
let t: TestDaemon | undefined;
afterEach(async () => {
  await t?.d.stop();
});
test('les lectures swarph restent absentes du serveur host authentifié', async () => {
  const nom = 'aid-e2e.ts.net';
  t = await startTestDaemon(undefined, {
    tailscaleExec: async (_bin, args) =>
      args[0] === 'status'
        ? {
            stdout: JSON.stringify({
              BackendState: 'Running',
              Self: { DNSName: `${nom}.`, UserID: 1 },
              User: {},
            }),
            code: null,
          }
        : { stdout: '', code: null },
  });
  await t.d.app.inject({
    method: 'PUT',
    url: '/api/host',
    headers: t.headers,
    payload: { actif: true },
  });
  const { jeton } = new RegistreAppareils(t.db).emettre({ nom: 'Téléphone', identite: null });
  const host = t.d.modeHost.instance()!;
  expect(host).toBeTruthy();
  for (const route of [
    'cells',
    'federation?q=test',
    'memory?tag=test',
    'memory/page?slug=page-test',
    'reglages',
  ]) {
    const r = await host.inject({
      url: `/api/swarph/${route}`,
      headers: {
        host: nom,
        'sec-fetch-site': 'same-origin',
        origin: `https://${nom}`,
        cookie: `${COOKIE_APPAREIL}=${jeton}`,
      },
    });
    expect(r.statusCode).toBe(404);
  }
});

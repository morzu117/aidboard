import { RegistreAppareils } from '../src/daemon/host/appareils.js';
import { COOKIE_APPAREIL } from '../src/daemon/host/serveur.js';
import { expect, test } from 'vitest';
import { issueRunToken } from '../src/daemon/security.js';
import { startTestDaemon } from './helpers/daemon.js';

test('clé PDA : admin sur Mac, rotation partagée avec le script des appareils', async () => {
  const t = await startTestDaemon(undefined, {
    tailscaleExec: async (_bin, args) =>
      args[0] === 'status'
        ? {
            stdout: JSON.stringify({
              BackendState: 'Running',
              Self: { DNSName: 'aid-e2e.ts.net.', UserID: 1 },
              User: {},
            }),
            code: null,
          }
        : { stdout: '', code: null },
  });
  try {
    await t.d.app.inject({
      method: 'PUT',
      url: '/api/host',
      headers: t.headers,
      payload: { actif: true },
    });
    const serveur = t.d.modeHost.instance()!;
    const { jeton } = new RegistreAppareils(t.db).emettre({ nom: 'Téléphone', identite: null });
    const headersAppareil = {
      host: 'aid-e2e.ts.net',
      origin: 'https://aid-e2e.ts.net',
      'sec-fetch-site': 'same-origin',
      'x-aid-cockpit': '1',
      cookie: `${COOKIE_APPAREIL}=${jeton}`,
    };
    const nonAdmin = {
      host: t.headers.host!,
      authorization: `Bearer ${issueRunToken(t.d.auth, 'test')}`,
    };
    for (const [method, url] of [
      ['GET', '/api/host/pda/cle'],
      ['POST', '/api/host/pda/cle/tourner'],
    ] as const) {
      expect((await t.d.app.inject({ method, url, headers: nonAdmin })).statusCode).toBe(403);
      expect((await serveur.inject({ method, url, headers: headersAppareil })).statusCode).toBe(
        404,
      );
    }
    const avant = await t.d.app.inject({ url: '/api/host/pda/cle', headers: t.headers });
    expect(avant.statusCode).toBe(200);
    const scriptAvant = await serveur.inject({
      url: '/pda-cle.js',
      headers: headersAppareil,
    });
    expect(scriptAvant.body).toContain(avant.json().clePublique);
    const rotation = await t.d.app.inject({
      method: 'POST',
      url: '/api/host/pda/cle/tourner',
      headers: t.headers,
    });
    expect(rotation.statusCode).toBe(200);
    expect(rotation.json().clePublique).not.toBe(avant.json().clePublique);
    const script = await serveur.inject({
      url: '/pda-cle.js',
      headers: headersAppareil,
    });
    expect(script.body).toContain(rotation.json().clePublique);
    expect((await t.d.app.inject({ url: '/api/host/pda/cle', headers: t.headers })).json()).toEqual(
      rotation.json(),
    );
    const etat = await t.d.app.inject({ url: '/api/host', headers: t.headers });
    expect(etat.json().pda).toEqual({ actif: false, relais: null });
  } finally {
    await t.d.stop();
  }
});

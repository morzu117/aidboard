import { afterEach, expect, test } from 'vitest';
import type { TailscaleExec } from '../src/daemon/mesh/tailscale.js';
import { issueRunToken } from '../src/daemon/security.js';
import type { EtatModeHost } from '../src/shared/host.js';
import { startTestDaemon, type TestDaemon } from './helpers/daemon.js';

// Chantier 31 (D172, D173) : GET /api/host, sur le port du Mac, admin seulement.

let t: TestDaemon | null = null;
afterEach(async () => {
  await t?.d.stop();
  t = null;
});

const NOM = 'mac-synthetique.exemple.ts.net';

test('31.3 : éteint par défaut ; le port des appareils et la commande, Tailscale lu à la demande', async () => {
  const appels: string[][] = [];
  const exec: TailscaleExec = async (_bin, args) => {
    appels.push(args);
    if (args[0] === 'status') {
      return {
        stdout: JSON.stringify({
          BackendState: 'Running',
          Self: { DNSName: `${NOM}.`, UserID: 1 },
          User: { '1': { LoginName: 'utilisateur@exemple' } },
        }),
        code: null,
      };
    }
    return { stdout: '{}', code: null };
  };
  t = await startTestDaemon(undefined, { tailscaleExec: exec, config: { port: 0 } });
  expect(appels).toEqual([]); // rien au démarrage, rien en tâche de fond
  const r = await t.d.app.inject({ url: '/api/host', headers: t.headers });
  expect(r.statusCode).toBe(200);
  expect(r.headers['cache-control']).toBe('no-store');
  const e = r.json<EtatModeHost>();
  expect(e.actif).toBe(false);
  expect(e.tailnet).toEqual({ etat: 'running', nom: NOM, compte: 'utilisateur@exemple' });
  expect(e.serve).toEqual({ etat: 'absent', funnel: false, interdits: [] });
  expect(e.commande).toBe(`tailscale serve --bg --https=443 http://127.0.0.1:${e.port}`);
  expect(appels.map((a) => a.join(' ')).sort()).toEqual(['serve status --json', 'status --json']);
});

test('31.3 : un jeton de run n’y a pas accès ; sans authentification, 401', async () => {
  t = await startTestDaemon();
  const sans = await t.d.app.inject({ url: '/api/host', headers: { host: t.headers.host! } });
  expect(sans.statusCode).toBe(401);
  const jeton = issueRunToken(t.d.auth, 'run-synthetique');
  const run = await t.d.app.inject({
    url: '/api/host',
    headers: { host: t.headers.host!, authorization: `Bearer ${jeton}` },
  });
  expect(run.statusCode).toBe(403);
  expect(JSON.stringify(run.json())).not.toContain('tailnet');
});

test('31.3 : sans Tailscale (binaire absent), l’état le dit sans lever', async () => {
  t = await startTestDaemon();
  const e = (await t.d.app.inject({ url: '/api/host', headers: t.headers })).json<EtatModeHost>();
  expect(e.tailnet.etat).toBe('absent');
  expect(e.serve.etat).toBe('absent');
});

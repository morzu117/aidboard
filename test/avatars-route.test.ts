import { rmSync } from 'node:fs';
import { expect, test } from 'vitest';
import { issueRunToken, SESSION_COOKIE } from '../src/daemon/security.js';
import { startTestDaemon } from './helpers/daemon.js';

test('GET /api/avatars : config locale et même garde que GET /api/meshes', async () => {
  const avatars = {
    'peer-a': { initiales: 'A1', couleur: 'bleu' as const },
    'peer-b': { couleur: 'rose' as const },
  };
  const t = await startTestDaemon(undefined, { config: { avatars } });
  try {
    const reponse = await t.d.app.inject({ url: '/api/avatars', headers: t.headers });
    expect(reponse.statusCode).toBe(200);
    expect(reponse.json()).toEqual({ avatars });
    const hote = { host: t.headers.host! };
    const run = issueRunToken(t.d.auth, 'run-avatar');
    const cas = [
      { headers: hote, statut: 401 },
      { headers: { ...hote, authorization: `Bearer ${run}` }, statut: 403 },
      { headers: t.headers, statut: 200 },
      {
        headers: {
          ...hote,
          cookie: `${SESSION_COOKIE}=${t.d.auth.sessionToken}`,
          'sec-fetch-site': 'same-origin',
        },
        statut: 200,
      },
      { headers: { ...hote, cookie: `${SESSION_COOKIE}=${t.d.auth.sessionToken}` }, statut: 403 },
      { headers: { ...t.headers, origin: 'https://example.com' }, statut: 403 },
      { headers: { ...t.headers, host: 'example.com' }, statut: 421 },
    ];
    for (const { headers, statut } of cas) {
      for (const url of ['/api/avatars', '/api/meshes']) {
        expect((await t.d.app.inject({ url, headers })).statusCode, url).toBe(statut);
      }
    }
  } finally {
    await t.d.stop();
    rmSync(t.home, { recursive: true, force: true });
  }
});

test('GET /api/avatars : sans surcharge, table vide', async () => {
  const t = await startTestDaemon();
  try {
    const reponse = await t.d.app.inject({ url: '/api/avatars', headers: t.headers });
    expect(reponse.statusCode).toBe(200);
    expect(reponse.json()).toEqual({ avatars: {} });
  } finally {
    await t.d.stop();
    rmSync(t.home, { recursive: true, force: true });
  }
});

import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';

// Chantier 31, point 31.2 (lab M3) : la sonde de Tailscale Serve, lancée comme Julien la lancera.

const SONDE = join(import.meta.dirname, '..', 'scripts', 'sonde-serve.mjs');
let enfant: ChildProcess | null = null;
afterEach(() => {
  enfant?.kill();
  enfant = null;
});

async function lancer(): Promise<{ base: string; sortie: string }> {
  enfant = spawn(process.execPath, [SONDE, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let sortie = '';
  const base = await new Promise<string>((resolve, reject) => {
    enfant!.stdout!.on('data', (c: Buffer) => {
      sortie += c.toString();
      const m = /sonde: (http:\/\/127\.0\.0\.1:\d+)/.exec(sortie);
      if (m && sortie.includes('serve reset')) resolve(m[1]!);
    });
    enfant!.once('exit', (code) => reject(new Error(`sonde sortie en ${code}`)));
  });
  return { base, sortie };
}

test('31.2 : la sonde écoute sur 127.0.0.1 et rappelle le reset', async () => {
  const { base, sortie } = await lancer();
  expect(base).toMatch(/^http:\/\/127\.0\.0\.1:/);
  expect(sortie).toContain('tailscale serve --bg --https=443 http://127.0.0.1:');
  expect(sortie).toContain('tailscale serve reset');
  expect(sortie).toContain('tailscale serve status');
});

test('31.2 : Host, adresse et Tailscale-* avec leur valeur ; des autres, le nom seul', async () => {
  const { base } = await lancer();
  const r = await fetch(`${base}/mesure?secret=valeur-de-requete`, {
    headers: {
      'Tailscale-User-Login': 'forge@example',
      'X-Forwarded-For': '203.0.113.9',
      Cookie: 'aid_session=valeur-synthetique-du-cookie',
      Authorization: 'Bearer jeton-synthetique',
    },
  });
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('no-store');
  const texte = await r.text();
  const corps = JSON.parse(texte) as {
    chemin: string;
    entetes: Record<string, string>;
    autresEntetes: string[];
  };
  expect(corps.chemin).toBe('/mesure');
  expect(corps.entetes['tailscale-user-login']).toBe('forge@example');
  expect(corps.entetes['x-forwarded-for']).toBe('203.0.113.9');
  expect(corps.entetes.host).toMatch(/^127\.0\.0\.1:\d+$/);
  expect(corps.autresEntetes).toEqual(expect.arrayContaining(['authorization', 'cookie']));
  // jamais une valeur de cookie, de jeton ni de requête
  expect(texte).not.toContain('valeur-synthetique-du-cookie');
  expect(texte).not.toContain('jeton-synthetique');
  expect(texte).not.toContain('valeur-de-requete');
});

test('31.2 : un port invalide sort en code 2', async () => {
  const code = await new Promise<number | null>((resolve) => {
    const p = spawn(process.execPath, [SONDE, '--port', 'x'], { stdio: 'ignore' });
    p.once('exit', resolve);
  });
  expect(code).toBe(2);
});

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openDb } from '../src/daemon/db.js';
import { Appairages } from '../src/daemon/host/appairage.js';
import { RegistreAppareils } from '../src/daemon/host/appareils.js';
import { ouvrirServeurAppareils } from '../src/daemon/host/serveur.js';
import { creerFournisseurClePda } from '../src/daemon/pda/cle.js';
import { startTestDaemon } from './helpers/daemon.js';

const NOM = 'aid-e2e.ts.net';
const csp = (relais = '') =>
  `default-src 'none'; script-src 'self'; connect-src 'self' wss://${NOM}${relais}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; manifest-src 'self'; worker-src 'self'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'`;

test('43.7 : CSP exacte et configuration du relais relue sans redémarrage', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aid-coque-'));
  const db = openDb(join(home, 'state.db'));
  const config = { pda: true, relais: null as string | null };
  const fournisseur = creerFournisseurClePda(home);
  const serveur = await ouvrirServeurAppareils({
    port: 0,
    interdits: [],
    nom: () => NOM,
    registre: new RegistreAppareils(db),
    appairages: new Appairages(),
    webRoot: null,
    pda: { db, actif: () => config.pda },
    clePda: fournisseur,
    relaisPda: () => config.relais,
  });
  if (!serveur.disponible) throw new Error(serveur.raison);
  try {
    const lire = () => serveur.app.inject({ url: '/pda-cle.js', headers: { host: NOM } });
    expect((await lire()).headers['content-security-policy']).toBe(csp());
    config.pda = false;
    config.relais = 'https://example.com';
    const avant = await lire();
    expect(avant.headers['content-security-policy']).toBe(csp());
    expect(avant.statusCode).toBe(200);
    expect(avant.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(avant.headers['cache-control']).toBe('no-cache');
    expect(avant.body).toBe(
      `export const CLE_DAEMON = "${fournisseur.clePubliqueRaw()}"; export const RELAIS = null;`,
    );
    fournisseur.tourner();
    const apres = await lire();
    expect(apres.body).not.toBe(avant.body);
    expect(apres.body).toBe(
      `export const CLE_DAEMON = "${fournisseur.clePubliqueRaw()}"; export const RELAIS = null;`,
    );
    config.pda = true;
    expect((await lire()).body).toContain('export const RELAIS = "https://example.com";');
    expect((await lire()).headers['content-security-policy']).toBe(csp(' https://example.com'));
    config.relais = 'https://relais.example.com';
    expect((await lire()).headers['content-security-policy']).toBe(
      csp(' https://relais.example.com'),
    );
    expect(
      (await serveur.app.inject({ url: '/pda-cle.js', headers: { host: 'example.com' } }))
        .statusCode,
    ).toBe(421);
  } finally {
    await serveur.app.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('43.7 : le port du Mac réservé à l’admin ne sert pas la clé', async () => {
  const t = await startTestDaemon();
  try {
    const reponse = await t.d.app.inject({ url: '/pda-cle.js', headers: t.headers });
    expect(reponse.statusCode).toBe(404);
    expect(reponse.body).not.toContain('CLE_DAEMON');
  } finally {
    await t.d.stop();
  }
});

test('43.7 : aucun script inline dans le HTML livré', () => {
  const chemin = existsSync('dist/web/index.html') ? 'dist/web/index.html' : 'web/index.html';
  const html = readFileSync(chemin, 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  expect(scripts.length).toBeGreaterThan(0);
  for (const [, attributs, corps] of scripts) {
    expect(attributs).toMatch(/\bsrc\s*=\s*["'][^"']+["']/);
    expect(corps!.trim()).toBe('');
  }
});

test('43.7 : le service worker installe la clé dans le cache versionné de la coque', () => {
  const sw = readFileSync('web/public/sw.js', 'utf8');
  expect(sw).toContain("const COQUE = ['/pda-cle.js']");
  expect(sw).toContain('cache.addAll(COQUE)');
  expect(sw).toContain("const CACHE = 'aid-shell-v2'");
});

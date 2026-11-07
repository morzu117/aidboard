import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { startTestDaemon } from './helpers/daemon.js';

const publicWeb = resolve('web/public');

test('32.8 : manifeste valide et icônes copiées à leurs dimensions originales', () => {
  const manifeste = JSON.parse(readFileSync(resolve(publicWeb, 'manifest.webmanifest'), 'utf8'));
  expect(manifeste).toMatchObject({
    name: 'A-I-D',
    short_name: 'A-I-D',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0D0F12',
    theme_color: '#0D0F12',
  });
  expect(manifeste.icons).toHaveLength(2);
  for (const taille of [256, 512]) {
    const icone = readFileSync(resolve(publicWeb, `icons/icon-${taille}.png`));
    expect(icone.readUInt32BE(16)).toBe(taille);
    expect(icone.readUInt32BE(20)).toBe(taille);
    expect(icone).toEqual(
      readFileSync(
        taille === 512 ? 'app/src-tauri/icons/icon.png' : 'app/src-tauri/icons/128x128@2x.png',
      ),
    );
    expect(manifeste.icons).toContainEqual({
      src: `/icons/icon-${taille}.png`,
      sizes: `${taille}x${taille}`,
      type: 'image/png',
    });
  }
  const html = readFileSync('web/index.html', 'utf8');
  expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"');
  expect(html).toContain('<meta name="theme-color" content="#0D0F12"');
  expect(html).toContain('<link rel="apple-touch-icon" href="/icons/icon-256.png"');
  expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes"');
});

test('32.8 : le port du Mac sert le manifeste en application/manifest+json et les icônes', async () => {
  const t = await startTestDaemon(undefined, { webRoot: publicWeb });
  try {
    const manifeste = await t.d.app.inject({ url: '/manifest.webmanifest', headers: t.headers });
    expect(manifeste.statusCode).toBe(200);
    expect(manifeste.headers['content-type']).toMatch(/^application\/manifest\+json/);
    for (const taille of [256, 512]) {
      const icone = await t.d.app.inject({ url: `/icons/icon-${taille}.png`, headers: t.headers });
      expect(icone.statusCode).toBe(200);
      expect(icone.headers['content-type']).toBe('image/png');
    }
  } finally {
    await t.d.stop();
  }
});

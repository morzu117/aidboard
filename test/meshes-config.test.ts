import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { stringify } from 'yaml';
import { ConfigError, DEFAULT_CONFIG, parseConfig } from '../src/daemon/config.js';
import { meshPaths } from '../src/daemon/mesh/paths.js';

const principal = { cell: 'principal', gateway: 'http://example.com', home: '/tmp/principal' };
const perso = { cell: 'perso', gateway: 'https://example.com', home: '/tmp/perso' };
const lire = (meshes: unknown, mesh?: unknown) =>
  parseConfig(stringify({ meshes, ...(mesh === undefined ? {} : { mesh }) }));

test('ancienne forme : principal, globaux conservés et HOME par défaut', () => {
  const cfg = parseConfig(stringify({ mesh: { cell: 'principal' } }));
  expect(cfg.mesh.cell).toBe('principal');
  expect(cfg.meshes.principal).toMatchObject({
    cell: 'principal',
    home: process.env.HOME ?? homedir(),
  });
  expect(cfg.meshes.principal).not.toHaveProperty('bin');
  expect(cfg.meshes.principal).not.toHaveProperty('tailscale');
});

test('nouvelle forme : principal reste accessible aux appelants, globaux dans mesh', () => {
  const cfg = lire({ principal, perso }, { bin: 'swarph', tailscale: { manage: true } });
  expect(cfg.mesh).toEqual({
    ...DEFAULT_CONFIG.mesh,
    ...principal,
    tailscale: { ...DEFAULT_CONFIG.mesh.tailscale, manage: true },
  });
  expect(Object.keys(cfg.meshes)).toEqual(['principal', 'perso']);
  expect(lire({ perso }).mesh.cell).toBe('');
  expect(lire({ principal: {}, perso: {} }).meshes.perso!.cell).toBe('');
});

test('refuse les deux formes et les globaux à l’intérieur des meshes', () => {
  expect(() => lire({ principal }, { cell: 'principal' })).toThrow('les deux formes');
  for (const globaux of [{ bin: 'swarph' }, { tailscale: {} }])
    expect(() => lire({ principal: { ...principal, ...globaux } })).toThrow('clé inconnue');
});

test.each(['Principal', '1principal', '-principal', 'a_b', 'a'.repeat(33), '', '__proto__'])(
  'refuse le nom %j',
  (nom) => {
    expect(() => lire({ [nom]: principal })).toThrow('nom de mesh invalide');
  },
);

test('nom de 32 caractères accepté ; formes non objets et home invalide refusés', () => {
  expect(Object.keys(lire({ ['a'.repeat(32)]: principal }).meshes)).toHaveLength(1);
  for (const valeur of [null, [], 'principal', 1]) {
    expect(() => lire(valeur)).toThrow(ConfigError);
    expect(() => lire({ principal: valeur })).toThrow(ConfigError);
  }
  for (const home of ['', 1, null])
    expect(() => lire({ principal: { ...principal, home } })).toThrow('home');
});

test.each(['http://example.com', 'http://example.com:80', 'HTTP://EXAMPLE.COM/'])(
  'refuse le même couple normalisé : %s',
  (gateway) => {
    expect(() => lire({ principal, perso: { ...principal, gateway, home: '/tmp/perso' } })).toThrow(
      'même couple cell/gateway',
    );
  },
);

test('même cell : home commun refusé, homes distincts acceptés', () => {
  expect(() =>
    lire({ principal, perso: { ...perso, cell: 'principal', home: principal.home } }),
  ).toThrow('même fichier de jeton');
  const cfg = lire({ principal, perso: { ...perso, cell: 'principal' } });
  expect(cfg.meshes.perso!.cell).toBe('principal');
  expect(meshPaths(cfg.meshes.perso!).tokenFile).toBe(
    '/tmp/perso/.config/swarph/principal.peer_token',
  );
});

test.each([
  [{ cellFile: '/tmp/cell.yaml' }, { cellFile: '/tmp/a/../cell.yaml' }, 'fichier de cell'],
  [{ inboxLog: '/tmp/inbox.log' }, { inboxLog: '/tmp/a/../inbox.log' }, 'inbox.log'],
  [
    { stateRoot: '/tmp/etat' },
    { cell: 'principal', stateRoot: '/tmp/a/../etat' },
    'dossier d’état',
  ],
] as const)('refuse les chemins absolus identiques (%j)', (a, b, message) => {
  expect(() => lire({ principal: { ...principal, ...a }, perso: { ...perso, ...b } })).toThrow(
    `même ${message}`,
  );
});

test('les chemins suivent home, sans changer le résultat avec HOME courant', () => {
  const home = process.env.HOME ?? homedir();
  const cfg = { ...DEFAULT_CONFIG.mesh, cell: 'principal' };
  expect(meshPaths({ ...cfg, home })).toEqual(meshPaths(cfg, home));
  expect(meshPaths({ ...cfg, home: '/tmp/perso' }, '/tmp/principal')).toEqual({
    cellFile: '/tmp/perso/.config/swarph/cells/principal.yaml',
    tokenFile: '/tmp/perso/.config/swarph/principal.peer_token',
    stateRoot: '/tmp/perso/swarph_state',
    inboxLog: '/tmp/perso/swarph_state/principal/mesh-sidecar/inbox.log',
  });
  expect(lire({ principal: { home: '.' } }).meshes.principal!.home).toBe(resolve('.'));
});

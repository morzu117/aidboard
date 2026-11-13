import { expect, test } from 'vitest';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import { meshPaths } from '../src/daemon/mesh/paths.js';
import { parseTailscaleStatus, tailscaleState } from '../src/daemon/mesh/tailscale.js';

// 12.2 : chemins swarph dérivés de la config, et lecture de l'état Tailscale sans jamais le piloter.

test('meshPaths : dérivés de HOME et de la cell, ou repris de la config', () => {
  const cfg = { ...DEFAULT_CONFIG.mesh, cell: 'cell-aid' };
  expect(meshPaths(cfg, '/home/j')).toEqual({
    cellFile: '/home/j/.config/swarph/cells/cell-aid.yaml',
    tokenFile: '/home/j/.config/swarph/cell-aid.peer_token',
    stateRoot: '/home/j/swarph_state',
    inboxLog: '/home/j/swarph_state/cell-aid/mesh-sidecar/inbox.log',
  });
  expect(
    meshPaths({ ...cfg, cellFile: '/etc/cell.yaml', stateRoot: '/var/swarph' }, '/home/j'),
  ).toMatchObject({
    cellFile: '/etc/cell.yaml',
    tokenFile: '/home/j/.config/swarph/cell-aid.peer_token',
    inboxLog: '/var/swarph/cell-aid/mesh-sidecar/inbox.log',
  });
});

test('parseTailscaleStatus : Running, tout autre état, ou du non-JSON', () => {
  expect(parseTailscaleStatus('{"BackendState":"Running","Peer":{}}')).toBe('running');
  expect(parseTailscaleStatus('{"BackendState":"Stopped"}')).toBe('stopped');
  expect(parseTailscaleStatus('{"BackendState":"NeedsLogin"}')).toBe('stopped');
  expect(parseTailscaleStatus('Tailscale is stopped.')).toBe('stopped');
});

test('tailscaleState : binaire absent, app arrêtée (code 1 mais JSON), connecté', async () => {
  const fake = (stdout: string, code: string | null) => async () => ({ stdout, code });
  expect(await tailscaleState('/nope', fake('', 'ENOENT'))).toBe('absent');
  expect(await tailscaleState('ts', fake('{"BackendState":"Stopped"}', 'ERR'))).toBe('stopped');
  expect(await tailscaleState('ts', fake('{"BackendState":"Running"}', null))).toBe('running');
  expect(await tailscaleState('ts', fake('', null))).toBe('stopped');
  expect(await tailscaleState('ts', fake('', 'ERR'))).toBe('absent');
});

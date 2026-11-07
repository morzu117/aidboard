import { expect, test } from 'vitest';
import {
  commandeServe,
  lireServe,
  lireTailnet,
  parseServe,
  parseTailnet,
  type TailscaleExec,
} from '../src/daemon/mesh/tailscale.js';

// Chantier 31 (D173) : ce que le mode host lit de Tailscale. Sorties synthétiques seulement :
// jamais le vrai binaire, aucun nom ni login réel.

const NOM = 'mac-synthetique.exemple.ts.net';
const statut = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    BackendState: 'Running',
    Self: { DNSName: `${NOM}.`, UserID: 42 },
    User: { '42': { LoginName: 'julien@exemple' }, '7': { LoginName: 'autre@exemple' } },
    ...over,
  });

test('31.3 (D173) : le nom sans point final et le login du compte du Mac', () => {
  expect(parseTailnet(statut())).toEqual({
    etat: 'running',
    nom: NOM,
    compte: 'julien@exemple',
  });
});

test('31.3 (D173) : arrêté, nœud taggé, MagicDNS coupé, ou du non-JSON', () => {
  expect(parseTailnet(statut({ BackendState: 'Stopped' }))).toEqual({
    etat: 'stopped',
    nom: null,
    compte: null,
  });
  const tague = parseTailnet(statut({ User: { '42': { LoginName: 'tagged-devices' } } }));
  expect(tague.compte).toBeNull();
  expect(tague.nom).toBe(NOM);
  expect(parseTailnet(statut({ Self: { UserID: 42 } })).nom).toBeNull();
  expect(parseTailnet('pas du json')).toEqual({ etat: 'stopped', nom: null, compte: null });
});

test('31.3 (D173) : binaire absent, ou sortie vide', async () => {
  const absent: TailscaleExec = async () => ({ stdout: '', code: 'ENOENT' });
  expect(await lireTailnet('tailscale', absent)).toEqual({
    etat: 'absent',
    nom: null,
    compte: null,
  });
  expect((await lireServe('tailscale', { appareils: 4890, interdits: [] }, absent)).etat).toBe(
    'absent',
  );
  const vide: TailscaleExec = async () => ({ stdout: '', code: null });
  expect((await lireTailnet('tailscale', vide)).etat).toBe('stopped');
});

const PORTS = { appareils: 4890, interdits: [4870, 4871, 4880] };
const serve = (proxy: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    TCP: { '443': { HTTPS: true } },
    Web: { [`${NOM}:443`]: { Handlers: { '/': { Proxy: proxy } } } },
    ...over,
  });

test('31.3 (D173) : Serve vers le port des appareils en HTTPS', () => {
  for (const proxy of [
    'http://127.0.0.1:4890',
    'http://localhost:4890',
    '127.0.0.1:4890',
    '4890',
  ]) {
    expect(parseServe(serve(proxy), PORTS), proxy).toEqual({
      etat: 'ok',
      funnel: false,
      interdits: [],
    });
  }
});

test('31.3 (D173) : aucun service, un autre port, du HTTP seul, ou illisible', () => {
  expect(parseServe('', PORTS).etat).toBe('absent');
  expect(parseServe('{}', PORTS).etat).toBe('absent');
  expect(parseServe(serve('http://127.0.0.1:3000'), PORTS).etat).toBe('autre');
  expect(parseServe(serve('http://127.0.0.1:4890', { TCP: { '443': {} } }), PORTS).etat).toBe(
    'autre',
  );
  expect(parseServe('[', PORTS).etat).toBe('illisible');
  expect(parseServe('[]', PORTS).etat).toBe('illisible');
});

test('31.3 (D182) : un Funnel actif, et les ports interdits exposés', () => {
  const funnel = parseServe(
    serve('http://127.0.0.1:4890', { AllowFunnel: { [`${NOM}:443`]: true } }),
    PORTS,
  );
  expect(funnel).toEqual({ etat: 'ok', funnel: true, interdits: [] });
  const interdits = parseServe(
    JSON.stringify({
      TCP: {
        '443': { HTTPS: true },
        '8443': { HTTPS: true },
        '9000': { TCPForward: '127.0.0.1:4871' },
      },
      Web: {
        [`${NOM}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4870' } } },
        [`${NOM}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4880' } } },
      },
    }),
    PORTS,
  );
  expect(interdits).toEqual({ etat: 'autre', funnel: false, interdits: [4870, 4871, 4880] });
});

test('31.3 (D173) : la commande à copier, que A-I-D ne lance pas', () => {
  expect(commandeServe(4890)).toBe('tailscale serve --bg --https=443 http://127.0.0.1:4890');
});

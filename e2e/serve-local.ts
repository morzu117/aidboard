import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer, type Server } from 'node:https';
import { connect } from 'node:net';
import { join } from 'node:path';

// Chantier 31 (31.11) : un frontal HTTPS local qui joue Tailscale Serve devant le port des
// appareils. Certificat autosigné créé par openssl pour le nom synthétique, jamais un vrai nom du
// tailnet. Comme Serve sur un nœud d'utilisateur (à confirmer par la mesure de 31.2), il garde
// `Host`, pose l'identité et l'adresse, et remplace celles que le client aurait mises.

export const NOM_E2E = 'aid-e2e.ts.net';
export const LOGIN_E2E = 'julien@exemple';

export function certificat(dir: string): { key: Buffer; cert: Buffer } {
  const key = join(dir, 'serve.key');
  const cert = join(dir, 'serve.crt');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      key,
      '-out',
      cert,
      '-subj',
      `/CN=${NOM_E2E}`,
      '-addext',
      `subjectAltName=DNS:${NOM_E2E}`,
    ],
    { stdio: 'ignore', timeout: 30_000 },
  );
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

function entetes(h: NodeJS.Dict<string | string[]>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined || k.startsWith('tailscale-') || k.startsWith('x-forwarded-')) continue;
    out[k] = v;
  }
  out['tailscale-user-login'] = LOGIN_E2E;
  out['tailscale-user-name'] = 'Julien';
  // une adresse de documentation (RFC 5737), jamais une adresse du tailnet
  out['x-forwarded-for'] = '192.0.2.10';
  return out;
}

export async function ouvrirServeLocal(opts: {
  dir: string;
  port: number;
  versPort: number;
}): Promise<Server> {
  const srv = createServer(certificat(opts.dir), (req, res) => {
    const amont = request(
      {
        host: '127.0.0.1',
        port: opts.versPort,
        method: req.method,
        path: req.url,
        headers: entetes(req.headers),
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    amont.on('error', () => res.writeHead(502).end());
    req.pipe(amont);
  });
  srv.on('upgrade', (req, socket, tete) => {
    const amont = connect(opts.versPort, '127.0.0.1', () => {
      const lignes = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(entetes(req.headers))) {
        for (const x of Array.isArray(v) ? v : [v]) lignes.push(`${k}: ${x}`);
      }
      amont.write(`${lignes.join('\r\n')}\r\n\r\n`);
      if (tete.length > 0) amont.write(tete);
      amont.pipe(socket);
      socket.pipe(amont);
    });
    const fin = () => {
      amont.destroy();
      socket.destroy();
    };
    amont.on('error', fin);
    socket.on('error', fin);
  });
  await new Promise<void>((r) => srv.listen(opts.port, '127.0.0.1', r));
  return srv;
}

/** La sortie synthétique de `tailscale` : running, le nom e2e, Serve vers le port des appareils. */
export function fauxTailscale(portAppareils: number): string {
  const status = JSON.stringify({
    BackendState: 'Running',
    Self: { DNSName: `${NOM_E2E}.`, UserID: 1 },
    User: { '1': { LoginName: LOGIN_E2E } },
  });
  const serve = JSON.stringify({
    TCP: { '443': { HTTPS: true } },
    Web: {
      [`${NOM_E2E}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${portAppareils}` } } },
    },
  });
  return [
    '#!/bin/sh',
    '# synthétique (chantier 31) : jamais le vrai tailscale, aucun réseau',
    'case "$1 $2" in',
    `  "status --json") echo '${status}' ;;`,
    `  "serve status") echo '${serve}' ;;`,
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n');
}

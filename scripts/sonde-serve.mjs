#!/usr/bin/env node
// Chantier 31, point 31.2 (lab M3) : la sonde de Tailscale Serve.
//
// Elle écoute sur 127.0.0.1 seulement et renvoie, à celui qui l'appelle et à lui seul, ce que
// Serve lui a transmis : Host, les en-têtes d'adresse (X-Forwarded-*, Forwarded, X-Real-IP) et les
// en-têtes Tailscale-*, valeurs comprises. Des autres en-têtes, elle ne renvoie que le nom, jamais
// la valeur (un cookie n'est jamais recopié). Elle ne journalise rien.
//
// Usage, sur la décision du propriétaire du poste (docs/mesure-serve-31.md) :
//   node scripts/sonde-serve.mjs            # 127.0.0.1:4899
//   node scripts/sonde-serve.mjs --port 0   # port libre, affiché au démarrage
// Puis `tailscale serve reset` à la fin : sinon la sonde reste joignable sur le tailnet.

import { createServer } from 'node:http';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const HOTE = '127.0.0.1';
export const PORT_PAR_DEFAUT = 4899;

const ADRESSE = new Set([
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'forwarded',
  'x-real-ip',
]);

/** Ce que la sonde renvoie pour une requête : rien d'autre ne sort. */
export function releve(method, url, headers) {
  const valeurs = {};
  const autres = [];
  for (const [nom, valeur] of Object.entries(headers)) {
    const n = nom.toLowerCase();
    if (n === 'host' || ADRESSE.has(n) || n.startsWith('tailscale-')) valeurs[n] = valeur;
    else autres.push(n);
  }
  return {
    sonde: 'aid-31.2',
    methode: method,
    // le chemin seul : une requête de mesure n'a pas besoin de sa query
    chemin: (url ?? '').split('?')[0],
    entetes: valeurs,
    autresEntetes: autres.sort(),
  };
}

export function ouvrirSonde(port = PORT_PAR_DEFAUT) {
  const serveur = createServer((req, res) => {
    const corps = JSON.stringify(releve(req.method, req.url, req.headers), null, 2);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    });
    res.end(corps);
  });
  return new Promise((resolve, reject) => {
    serveur.once('error', reject);
    serveur.listen(port, HOTE, () => resolve(serveur));
  });
}

const lance = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (lance) {
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? Number(process.argv[i + 1]) : PORT_PAR_DEFAUT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write('port invalide\n');
    process.exit(2);
  }
  const serveur = await ouvrirSonde(port);
  const { port: reel } = serveur.address();
  process.stdout.write(`sonde: http://${HOTE}:${reel}\n`);
  process.stdout.write(
    `À lancer ensuite : tailscale serve --bg --https=443 http://${HOTE}:${reel}\n`,
  );
  process.stdout.write(
    'Et à la fin : tailscale serve reset, puis tailscale serve status (vide).\n',
  );
}

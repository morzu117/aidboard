// Préchargé uniquement dans le daemon du harnais PDA, jamais dans le produit.
import process from 'node:process';
const { URL, Request } = globalThis;

const origine = 'https://relais.aid-e2e.example';
const port = Number(process.env.AID_E2E_RELAIS_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port e2e invalide');
const transport = globalThis.fetch;
globalThis.fetch = (entree, options) => {
  const url = new URL(entree instanceof Request ? entree.url : entree);
  if (url.origin !== origine) return transport(entree, options);
  url.protocol = 'http:';
  url.hostname = '127.0.0.1';
  url.port = String(port);
  return transport(entree instanceof Request ? new Request(url, entree) : url, options);
};

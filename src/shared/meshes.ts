import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { jsonCanonique } from './pda.js';

/** L'identité du gateway ne contient ni secret, ni chemin d'API. */
export function normaliserGateway(url: string): string {
  const forme = /^https?:\/\/([^/?#]+)\/?$/i.exec(url);
  if (!forme || forme[1]!.includes('@'))
    throw new Error('URL http(s) de gateway attendue, sans userinfo, requête, fragment ni chemin');
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash)
    throw new Error('Gateway : userinfo, requête, fragment et chemin interdits');
  return parsed.origin;
}

export function empreinteChemin(chemin: string): string {
  return createHash('sha256')
    .update(jsonCanonique([chemin === '' ? '' : resolve(chemin)]))
    .digest('base64url');
}

export function empreinteMesh(cell: string, gateway = ''): string {
  // Une cell sans gateway configuré est identifiée par la chaîne vide, sans URL implicite.
  return createHash('sha256')
    .update(jsonCanonique([cell, gateway === '' ? '' : normaliserGateway(gateway)]))
    .digest('base64url');
}

export function empreinteGateway(url: string): string {
  return createHash('sha256')
    .update(jsonCanonique([normaliserGateway(url)]))
    .digest('base64url');
}

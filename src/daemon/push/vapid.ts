import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import {
  constants,
  mkdirSync,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface ClesVapid {
  clePubliqueBase64url(): string;
  /** maintenant est un instant Unix en secondes, comme exp dans le JWT. */
  jetonVapid(endpoint: string, maintenant: number): string;
  enTeteAuthorization(endpoint: string, maintenant: number): string;
}

function construireCles(privee: KeyObject): ClesVapid {
  if (
    privee.asymmetricKeyType !== 'ec' ||
    privee.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
  ) {
    throw new Error('Clé VAPID P-256 attendue');
  }
  const jwk = createPublicKey(privee).export({ format: 'jwk' });
  const publique = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x!, 'base64url'),
    Buffer.from(jwk.y!, 'base64url'),
  ]).toString('base64url');
  const jetonVapid = (endpoint: string, maintenant: number): string => {
    if (!Number.isSafeInteger(maintenant) || maintenant < 0)
      throw new Error('Instant VAPID invalide');
    const encoder = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
    const entete = encoder({ typ: 'JWT', alg: 'ES256' });
    const charge = encoder({
      aud: new URL(endpoint).origin,
      // Marge de 60 secondes pour le transport et le décalage des horloges.
      exp: maintenant + 12 * 60 * 60 - 60,
      sub: 'https://github.com/morzu117/aidboard',
    });
    const contenu = `${entete}.${charge}`;
    const signature = sign('sha256', Buffer.from(contenu), {
      key: privee,
      dsaEncoding: 'ieee-p1363',
    });
    return `${contenu}.${signature.toString('base64url')}`;
  };
  return {
    clePubliqueBase64url: () => publique,
    jetonVapid,
    enTeteAuthorization: (endpoint, maintenant) =>
      `vapid t=${jetonVapid(endpoint, maintenant)}, k=${publique}`,
  };
}

/** Une instance par dossier d'état : aucune clé globale partagée entre daemons. */
export function chargerOuCreerCles(dossierEtat: string): ClesVapid {
  mkdirSync(dossierEtat, { recursive: true, mode: 0o700 });
  const chemin = join(dossierEtat, 'vapid.pem');
  try {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    writeFileSync(chemin, privateKey.export({ format: 'pem', type: 'pkcs8' }), {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (erreur) {
    if ((erreur as NodeJS.ErrnoException).code !== 'EEXIST') throw erreur;
  }
  const fichier = openSync(
    chemin,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const statut = fstatSync(fichier);
    // Refus explicite, sans correction silencieuse des permissions existantes.
    if (!statut.isFile() || (statut.mode & 0o077) !== 0) {
      throw new Error('Le fichier VAPID doit être privé (0600)');
    }
    return construireCles(createPrivateKey(readFileSync(fichier)));
  } finally {
    closeSync(fichier);
  }
}

/** Fournisseur local au daemon ; une coupure oublie l'objet, jamais le fichier. */
export function creerFournisseurCles(dossierEtat: string, charger = chargerOuCreerCles) {
  let cles: ClesVapid | undefined;
  return {
    obtenir: () => (cles ??= charger(dossierEtat)),
    couper: () => {
      cles = undefined;
    },
  };
}

import { createCipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';

// D198 : 128 octets utiles au maximum, puis délimiteur final et zéros.
export const TAILLE_CLAIR = 128;

export interface AleaChiffrement {
  sel?: Buffer;
  clePrivee?: Buffer;
}

function decoder(valeur: string, taille: number): Buffer {
  const resultat = Buffer.from(valeur, 'base64url');
  if (resultat.length !== taille || resultat.toString('base64url') !== valeur) {
    throw new Error('Clé Web Push invalide');
  }
  return resultat;
}

/** Bas niveau RFC 8291 : remplissage exprimé en octets nuls après le délimiteur. */
export function chiffrerEnregistrement(
  p256dh: string,
  auth: string,
  clair: Buffer,
  remplissage: number,
  alea: AleaChiffrement = {},
): Buffer {
  if (!Number.isSafeInteger(remplissage) || remplissage < 0 || clair.length + remplissage > 3993) {
    throw new Error('Taille du message Web Push invalide');
  }
  const publiqueAbonne = decoder(p256dh, 65);
  const secret = decoder(auth, 16);
  if (publiqueAbonne[0] !== 4) throw new Error('Point P-256 non compressé attendu');
  const sel = alea.sel ?? randomBytes(16);
  if (sel.length !== 16) throw new Error('Le sel doit contenir 16 octets');
  const ephemere = createECDH('prime256v1');
  if (alea.clePrivee) ephemere.setPrivateKey(alea.clePrivee);
  else ephemere.generateKeys();
  const publiqueServeur = ephemere.getPublicKey();
  // computeSecret vérifie aussi que le point reçu appartient à la courbe.
  const partage = ephemere.computeSecret(publiqueAbonne);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), publiqueAbonne, publiqueServeur]);
  const materiel = hkdfSync('sha256', partage, secret, info, 32);
  const cle = hkdfSync(
    'sha256',
    Buffer.from(materiel),
    sel,
    Buffer.from('Content-Encoding: aes128gcm\0'),
    16,
  );
  const nonce = hkdfSync(
    'sha256',
    Buffer.from(materiel),
    sel,
    Buffer.from('Content-Encoding: nonce\0'),
    12,
  );
  const chiffreur = createCipheriv('aes-128-gcm', Buffer.from(cle), Buffer.from(nonce));
  const rempli = Buffer.concat([clair, Buffer.from([2]), Buffer.alloc(remplissage)]);
  const entete = Buffer.alloc(21);
  sel.copy(entete);
  entete.writeUInt32BE(4096, 16);
  entete[20] = publiqueServeur.length;
  return Buffer.concat([
    entete,
    publiqueServeur,
    chiffreur.update(rempli),
    chiffreur.final(),
    chiffreur.getAuthTag(),
  ]);
}

/** API publique : aucune possibilité de désactiver le remplissage fixe. */
export function chiffrer(
  p256dh: string,
  auth: string,
  clair: Buffer,
  alea: AleaChiffrement = {},
): Buffer {
  if (clair.length > TAILLE_CLAIR) throw new Error('Clair Web Push trop long');
  return chiffrerEnregistrement(p256dh, auth, clair, TAILLE_CLAIR - clair.length, alea);
}

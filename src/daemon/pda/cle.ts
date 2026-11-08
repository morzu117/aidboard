import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
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
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';

export function creerFournisseurClePda(dossierEtat: string) {
  const chemin = join(dossierEtat, 'pda-signature.pem');
  let privee: KeyObject | undefined;
  const generer = () =>
    generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({
      format: 'pem',
      type: 'pkcs8',
    });
  function charger(): KeyObject {
    const fichier = openSync(
      chemin,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const statut = fstatSync(fichier);
      if (!statut.isFile() || (statut.mode & 0o077) !== 0)
        throw new Error('Le fichier PDA doit être privé (0600)');
      const cle = createPrivateKey(readFileSync(fichier));
      if (cle.asymmetricKeyType !== 'ec' || cle.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
        throw new Error('Clé PDA P-256 attendue');
      return cle;
    } finally {
      closeSync(fichier);
    }
  }
  function obtenir(): KeyObject {
    if (privee) return privee;
    mkdirSync(dossierEtat, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(chemin, generer(), { flag: 'wx', mode: 0o600 });
    } catch (erreur) {
      if ((erreur as NodeJS.ErrnoException).code !== 'EEXIST') throw erreur;
    }
    return (privee = charger());
  }
  return {
    obtenir,
    clePubliqueJwk: () => createPublicKey(obtenir()).export({ format: 'jwk' }),
    clePubliqueRaw: () => {
      const jwk = createPublicKey(obtenir()).export({ format: 'jwk' });
      return Buffer.concat([
        Buffer.from([4]),
        Buffer.from(jwk.x!, 'base64url'),
        Buffer.from(jwk.y!, 'base64url'),
      ]).toString('base64url');
    },
    tourner: () => {
      obtenir();
      // Vérifier aussi le fichier courant : une rotation ne répare pas un fichier hostile.
      charger();
      const temporaire = `${chemin}.${randomBytes(16).toString('hex')}.tmp`;
      writeFileSync(temporaire, generer(), { flag: 'wx', mode: 0o600 });
      try {
        renameSync(temporaire, chemin);
        privee = charger();
      } finally {
        rmSync(temporaire, { force: true });
      }
    },
  };
}

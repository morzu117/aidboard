import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { openDb, type Db } from '../../src/daemon/db.js';
import { creerFournisseurClePda } from '../../src/daemon/pda/cle.js';
import { RegistrePda } from '../../src/daemon/pda/registre.js';
import { defiReponse } from '../../src/shared/pda.js';

export function preparerPda() {
  const dossier = mkdtempSync(join(tmpdir(), 'aid-pda-file-'));
  const db = openDb(join(dossier, 'state.db'));
  const fournisseur = creerFournisseurClePda(dossier);
  const journal = vi.fn();
  const registre = new RegistrePda(db, journal);
  async function appareil() {
    const paire = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const relais = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const { kty, crv, x, y } = relais.publicKey.export({ format: 'jwk' });
    const { id } = await registre.enregistrer('acces', {
      nom: 'Exemple',
      credId: paire.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      passkey: paire.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      algorithme: -7,
      relais: { kty: kty!, crv: crv!, x: x!, y: y! },
    });
    registre.activer(id);
    return { id, cle: paire.privateKey, relais: relais.privateKey };
  }
  return {
    db,
    fournisseur,
    journal,
    registre,
    appareil,
    nettoyer() {
      db.close();
      rmSync(dossier, { recursive: true, force: true });
    },
  };
}
export async function assertionPda(
  db: Db,
  id: string,
  appareil: { id: string; cle: KeyObject },
  valeur: 'oui' | 'non' = 'oui',
  numeroSaisi?: string,
) {
  const demande = db
    .prepare('SELECT id, h_demande AS hDemande, numero, echeance FROM pda_demandes WHERE id = ?')
    .get(id) as { id: string; hDemande: string; numero: string; echeance: number };
  const defi = await defiReponse({
    ...demande,
    appareil: appareil.id,
    valeur,
    numero: valeur === 'non' ? '' : (numeroSaisi ?? demande.numero),
  });
  const client = Buffer.from(
    JSON.stringify({
      type: 'webauthn.get',
      origin: 'https://aid-e2e.ts.net',
      challenge: Buffer.from(defi).toString('base64url'),
    }),
  );
  const auth = Buffer.concat([
    createHash('sha256').update('aid-e2e.ts.net').digest(),
    Buffer.from([5]),
    Buffer.alloc(4),
  ]);
  const signature = sign(
    'sha256',
    Buffer.concat([auth, createHash('sha256').update(client).digest()]),
    appareil.cle,
  );
  return {
    appareil: appareil.id,
    demande: id,
    rawId: (
      db.prepare('SELECT cred_id FROM pda_appareils WHERE id = ?').get(appareil.id) as {
        cred_id: string;
      }
    ).cred_id,
    authenticatorData: auth.toString('base64url'),
    clientDataJSON: client.toString('base64url'),
    signature: signature.toString('base64url'),
    valeur,
    numero: valeur === 'oui' ? (numeroSaisi ?? demande.numero) : null,
  };
}

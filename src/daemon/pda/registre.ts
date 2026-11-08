import { createPublicKey, randomBytes } from 'node:crypto';
import { decoderBase64url, empreintePda, type ClesPda } from '../../shared/pda.js';
import type { Db } from '../db.js';
import { nomAppareil } from '../host/appareils.js';

export interface EnregistrementPda extends ClesPda {
  nom: string;
  algorithme: number;
}
interface Ligne {
  id: string;
  nom: string;
  cred_id: string;
  cle_publique: string;
  cle_relais: string;
  etat: 'attente' | 'actif' | 'revoque';
  cree_a: string;
  active_a: string | null;
  revoque_a: string | null;
}
export class RefusPda extends Error {
  constructor(readonly raison: 'cle' | 'connu') {
    super(raison);
  }
}

export class RegistrePda {
  constructor(
    private readonly db: Db,
    private readonly journal: (type: 'pda.active' | 'pda.revoque', donnees: { id: string }) => void,
    private readonly now: () => number = Date.now,
  ) {}

  async enregistrer(appareilId: string, entree: EnregistrementPda) {
    try {
      const cle = createPublicKey({
        key: Buffer.from(decoderBase64url(entree.passkey)),
        format: 'der',
        type: 'spki',
      });
      const relais = entree.relais;
      if (
        entree.algorithme !== -7 ||
        cle.asymmetricKeyType !== 'ec' ||
        cle.asymmetricKeyDetails?.namedCurve !== 'prime256v1' ||
        Object.keys(relais).sort().join(',') !== 'crv,kty,x,y' ||
        relais.kty !== 'EC' ||
        relais.crv !== 'P-256' ||
        decoderBase64url(relais.x).length !== 32 ||
        decoderBase64url(relais.y).length !== 32 ||
        decoderBase64url(entree.credId).length === 0
      )
        throw new Error('clé');
      createPublicKey({ key: relais, format: 'jwk' });
    } catch {
      throw new RefusPda('cle');
    }
    const empreinte = await empreintePda(entree);
    if (this.db.prepare('SELECT id FROM pda_appareils WHERE cred_id = ?').get(entree.credId))
      throw new RefusPda('connu');
    const id = randomBytes(16).toString('base64url');
    try {
      this.db
        .prepare(
          `INSERT INTO pda_appareils
        (id, appareil_id, nom, cred_id, cle_publique, cle_relais, etat, cree_a)
        VALUES (?, ?, ?, ?, ?, ?, 'attente', ?)`,
        )
        .run(
          id,
          appareilId,
          nomAppareil(entree.nom),
          entree.credId,
          entree.passkey,
          JSON.stringify(entree.relais),
          new Date(this.now()).toISOString(),
        );
    } catch (err) {
      if (
        err instanceof Error &&
        'code' in err &&
        err.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
        err.message === 'UNIQUE constraint failed: pda_appareils.cred_id'
      )
        throw new RefusPda('connu');
      throw err;
    }
    return { id, empreinte };
  }

  async lister() {
    const lignes = this.db
      .prepare('SELECT * FROM pda_appareils ORDER BY cree_a DESC, id')
      .all() as Ligne[];
    return Promise.all(
      lignes.map(async (l) => ({
        id: l.id,
        nom: l.nom,
        etat: l.etat,
        empreinte: await empreintePda({
          credId: l.cred_id,
          passkey: l.cle_publique,
          relais: JSON.parse(l.cle_relais),
        }),
        cree_a: l.cree_a,
        active_a: l.active_a,
        revoque_a: l.revoque_a,
      })),
    );
  }
  activer(id: string): boolean {
    const r = this.db
      .prepare(
        "UPDATE pda_appareils SET etat = 'actif', active_a = ? WHERE id = ? AND etat = 'attente'",
      )
      .run(new Date(this.now()).toISOString(), id);
    if (r.changes) this.journal('pda.active', { id });
    return r.changes > 0;
  }
  revoquer(id: string): boolean {
    const r = this.db
      .prepare(
        "UPDATE pda_appareils SET etat = 'revoque', revoque_a = ? WHERE id = ? AND etat IN ('attente', 'actif')",
      )
      .run(new Date(this.now()).toISOString(), id);
    if (r.changes) this.journal('pda.revoque', { id });
    return r.changes > 0;
  }
  actif(id: string) {
    const l = this.db.prepare('SELECT * FROM pda_appareils WHERE id = ?').get(id) as
      Ligne | undefined;
    return l
      ? { id: l.id, credId: l.cred_id, clePublique: l.cle_publique, actif: l.etat === 'actif' }
      : null;
  }
}

export const CorpsEnregistrementPda = {
  type: 'object',
  additionalProperties: false,
  required: ['nom', 'credId', 'passkey', 'algorithme', 'relais'],
  properties: {
    nom: { type: 'string', minLength: 1, maxLength: 40 },
    credId: { type: 'string', minLength: 1, maxLength: 2048 },
    passkey: { type: 'string', minLength: 1, maxLength: 2048 },
    algorithme: { type: 'integer' },
    relais: {
      type: 'object',
      additionalProperties: false,
      required: ['kty', 'crv', 'x', 'y'],
      properties: Object.fromEntries(
        ['kty', 'crv', 'x', 'y'].map((c) => [c, { type: 'string', minLength: 1, maxLength: 64 }]),
      ),
    },
  },
} as const;

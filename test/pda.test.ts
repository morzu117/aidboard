import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, chmodSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { creerFournisseurClePda } from '../src/daemon/pda/cle.js';
import { creerSigneurDemande } from '../src/daemon/pda/demande.js';
import {
  defiReponse,
  jsonCanonique,
  lireCorpsDemande,
  verifierEnveloppe,
} from '../src/shared/pda.js';

const dossiers: string[] = [];
afterEach(() => {
  for (const dossier of dossiers.splice(0)) rmSync(dossier, { recursive: true, force: true });
});
function contexte() {
  const dossier = mkdtempSync(join(tmpdir(), 'aid-pda-'));
  dossiers.push(dossier);
  const fournisseur = creerFournisseurClePda(dossier);
  return { dossier, fournisseur, signerDemande: creerSigneurDemande(fournisseur) };
}
const entree = { action: 'essai' as const, sujet: 'Sujet exemple', maintenant: 1000 };

describe('format PDA', () => {
  it('trie récursivement les clés et refuse les valeurs non JSON', () => {
    expect(jsonCanonique({ z: [{ b: 2, a: 1 }], a: true })).toBe(
      jsonCanonique({ a: true, z: [{ a: 1, b: 2 }] }),
    );
    const cycle: unknown[] = [];
    cycle.push(cycle);
    for (const valeur of [
      undefined,
      NaN,
      Infinity,
      1.5,
      1n,
      () => 0,
      Symbol(),
      new Date(),
      new Map(),
      { a: undefined },
      [undefined],
      Array(2),
      cycle,
    ])
      expect(() => jsonCanonique(valeur)).toThrow();
  });
  it('signe en r‖s, vérifie avec Node et WebCrypto et refuse les altérations', async () => {
    const { fournisseur, signerDemande } = contexte();
    const { corps, enveloppe, hDemande } = await signerDemande(entree);
    expect(corps.echeance).toBe(entree.maintenant + 300000);
    expect(corps.numero).toMatch(/^\d{4}$/);
    const octets = Buffer.from(enveloppe.corps, 'base64url');
    expect(Buffer.from(corps.id, 'base64url')).toHaveLength(16);
    expect(Buffer.from(fournisseur.clePubliqueRaw(), 'base64url')).toHaveLength(65);
    expect(
      verify(
        'sha256',
        octets,
        {
          key: createPublicKey({ key: fournisseur.clePubliqueJwk(), format: 'jwk' }),
          dsaEncoding: 'ieee-p1363',
        },
        Buffer.from(enveloppe.sig, 'base64url'),
      ),
    ).toBe(true);
    expect(await verifierEnveloppe(enveloppe, fournisseur.clePubliqueRaw())).toEqual(corps);
    expect(hDemande).toBe(createHash('sha256').update(octets).digest('base64url'));
    for (const champ of ['corps', 'sig'] as const) {
      const altere = Buffer.from(enveloppe[champ], 'base64url');
      altere[0] = altere[0]! ^ 1;
      expect(
        await verifierEnveloppe(
          { ...enveloppe, [champ]: altere.toString('base64url') },
          fournisseur.clePubliqueRaw(),
        ),
      ).toBeNull();
    }
    const reponse = {
      id: corps.id,
      hDemande,
      numero: corps.numero,
      valeur: 'oui' as const,
      echeance: corps.echeance,
      appareil: 'exemple',
    };
    expect(Buffer.from(await defiReponse(reponse))).toEqual(
      createHash('sha256').update(jsonCanonique(reponse)).digest(),
    );
  });
  it('renvoie null pour un corps invalide correctement signé', async () => {
    const { fournisseur, signerDemande } = contexte();
    const { corps } = await signerDemande(entree);
    for (const texte of [JSON.stringify({ ...corps, trop: true }), '{']) {
      const octets = Buffer.from(texte);
      const sig = sign('sha256', octets, {
        key: fournisseur.obtenir(),
        dsaEncoding: 'ieee-p1363',
      });
      await expect(
        verifierEnveloppe(
          { corps: octets.toString('base64url'), sig: sig.toString('base64url') },
          fournisseur.clePubliqueRaw(),
        ),
      ).resolves.toBeNull();
    }
  });
  it('refuse les schémas et les tailles hors limites', async () => {
    const { signerDemande } = contexte();
    const { corps } = await signerDemande(entree);
    for (const patch of [
      { trop: true },
      { action: 'autre' },
      { sujet: 'a'.repeat(81) },
      { numero: '123' },
      { id: 'abc' },
      { emise: 1.5 },
      { v: 2 },
    ])
      expect(() => lireCorpsDemande(Buffer.from(JSON.stringify({ ...corps, ...patch })))).toThrow();
    for (const cle of Object.keys(corps)) {
      const incomplet = { ...corps } as Record<string, unknown>;
      delete incomplet[cle];
      expect(() => lireCorpsDemande(Buffer.from(JSON.stringify(incomplet)))).toThrow();
    }
    expect(() => lireCorpsDemande(Buffer.alloc(16385, 32))).toThrow();
    expect(() => lireCorpsDemande(new Uint8Array([255]))).toThrow();
  });
});

describe('clé PDA', () => {
  it('crée en 0600, charge une fois et effectue une rotation', async () => {
    const { dossier, fournisseur, signerDemande } = contexte();
    const cle = fournisseur.obtenir();
    const publique = fournisseur.clePubliqueRaw();
    const { enveloppe } = await signerDemande(entree);
    const chemin = join(dossier, 'pda-signature.pem');
    expect(statSync(chemin).mode & 0o777).toBe(0o600);
    unlinkSync(chemin);
    expect(fournisseur.obtenir()).toBe(cle);
    expect(fournisseur.clePubliqueRaw()).toBe(publique);
    // Un autre fournisseur recrée le fichier supprimé, puis la rotation recharge.
    creerFournisseurClePda(dossier).obtenir();
    fournisseur.tourner();
    expect(fournisseur.clePubliqueRaw()).not.toBe(publique);
    expect(statSync(chemin).mode & 0o777).toBe(0o600);
    expect(await verifierEnveloppe(enveloppe, fournisseur.clePubliqueRaw())).toBeNull();
    expect(creerFournisseurClePda(dossier).clePubliqueRaw()).toBe(fournisseur.clePubliqueRaw());
  });
  it('refuse 0644 et les liens symboliques', () => {
    const { dossier, fournisseur } = contexte();
    fournisseur.obtenir();
    const chemin = join(dossier, 'pda-signature.pem');
    chmodSync(chemin, 0o644);
    expect(() => creerFournisseurClePda(dossier).obtenir()).toThrow();
    expect(() => fournisseur.tourner()).toThrow();
    unlinkSync(chemin);
    symlinkSync(join(dossier, 'absent.pem'), chemin);
    expect(() => creerFournisseurClePda(dossier).obtenir()).toThrow();
    expect(() => fournisseur.tourner()).toThrow();
  });
});

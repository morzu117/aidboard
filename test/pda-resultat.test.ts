import { generateKeyPairSync, sign } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import {
  CONTEXTE_DEMANDE,
  CONTEXTE_RELAIS,
  CONTEXTE_RESULTAT,
  CODES_RESULTAT,
  RAISONS_RESULTAT,
  RESULTATS_PDA,
  CLASSE_ACTION,
  signerResultat,
  verifierResultat,
  verifierEnveloppe,
  jsonCanonique,
} from '../src/shared/pda.js';
import { signerDemande } from '../src/daemon/pda/demande.js';
import { preparerPda } from './helpers/pda.js';

const paire = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = paire.publicKey.export({ format: 'jwk' });
const cle = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(jwk.x!, 'base64url'),
  Buffer.from(jwk.y!, 'base64url'),
]).toString('base64url');
const corps = {
  v: 1,
  id: Buffer.alloc(16).toString('base64url'),
  action: 'essai',
  resultat: 'executee',
  raison: null,
  code: null,
  emis: 1800000000000,
};
const signer = (octets: Uint8Array) =>
  sign('sha256', octets, { key: paire.privateKey, dsaEncoding: 'ieee-p1363' });
function forger(entree: unknown) {
  const texte = JSON.stringify(entree, Object.keys(entree as object).sort());
  return {
    corps: Buffer.from(texte).toString('base64url'),
    sig: signer(Buffer.from(CONTEXTE_RESULTAT + texte)).toString('base64url'),
  };
}

test('les trois contextes sont distincts et aucun ne préfixe un autre', () => {
  const contextes = [CONTEXTE_DEMANDE, CONTEXTE_RELAIS, CONTEXTE_RESULTAT];
  for (let i = 0; i < contextes.length; i++)
    for (let j = 0; j < contextes.length; j++)
      if (i !== j) expect(contextes[i]!.startsWith(contextes[j]!)).toBe(false);
});

test('résultat canonique signé et vérifié, falsification refusée', async () => {
  const enveloppe = signerResultat(corps, signer)!;
  expect(Buffer.from(enveloppe.corps, 'base64url').toString()).toBe(jsonCanonique(corps));
  expect(await verifierResultat(enveloppe, cle)).toEqual(corps);
  expect(
    await verifierResultat(
      { ...enveloppe, corps: forger({ ...corps, resultat: 'annulee' }).corps },
      cle,
    ),
  ).toBeNull();
  expect(
    signerResultat(corps, () => {
      throw new Error();
    }),
  ).toBeNull();
});

test('contextes croisés : demande et résultat ne sont jamais interchangeables', async () => {
  const t = preparerPda();
  try {
    const demande = await signerDemande(
      { action: 'essai', sujet: 'Exemple', maintenant: corps.emis },
      t.fournisseur,
    );
    expect(await verifierResultat(demande.enveloppe, t.fournisseur.clePubliqueRaw())).toBeNull();
    const resultat = signerResultat(corps, (octets) =>
      sign('sha256', octets, { key: t.fournisseur.obtenir(), dsaEncoding: 'ieee-p1363' }),
    )!;
    expect(await verifierEnveloppe(resultat, t.fournisseur.clePubliqueRaw())).toBeNull();
  } finally {
    t.nettoyer();
  }
});

for (const [champ, valeurs] of Object.entries({
  action: Object.keys(CLASSE_ACTION),
  resultat: RESULTATS_PDA,
  raison: [...RAISONS_RESULTAT, null],
  code: [...CODES_RESULTAT, null],
})) {
  test(`liste fermée ${champ} : toutes les valeurs admises`, async () => {
    for (const valeur of valeurs) {
      const entree = { ...corps, [champ]: valeur };
      expect(await verifierResultat(signerResultat(entree, signer)!, cle)).toEqual(entree);
    }
  });
}
for (const [champ, valeur] of [
  ['v', 2],
  ['id', 'a'.repeat(21)],
  ['id', 'a'.repeat(23)],
  ['id', '!'.repeat(22)],
  ['id', 'B'.repeat(22)],
  ['action', '__proto__'],
  ['action', 'texte'],
  ['resultat', 'texte'],
  ['raison', 'texte serveur'],
  ['code', 'texte serveur'],
  ['emis', 1.5],
  ['emis', null],
  ['detail', 'texte serveur'],
] as const) {
  test(`refuse ${champ}=${String(valeur)} avant signature et après signature valide`, async () => {
    const entree = { ...corps, [champ]: valeur };
    const signature = vi.fn(signer);
    expect(signerResultat(entree, signature)).toBeNull();
    expect(signature).not.toHaveBeenCalled();
    expect(await verifierResultat(forger(entree), cle)).toBeNull();
  });
}

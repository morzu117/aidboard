import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { expect, it } from 'vitest';
import { verifierAssertion } from '../src/daemon/pda/webauthn.js';
import { defiReponse, jsonCanonique } from '../src/shared/pda.js';

const paire = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const paireB = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const ctx = {
  appareil: {
    id: 'A',
    credId: 'YQ',
    clePublique: paire.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    actif: true,
  },
  demande: { id: 'demande', hDemande: 'hachage', numero: '1234', echeance: 1000 },
  origine: 'https://example.com',
  rpId: 'example.com',
  maintenant: 1000,
};
async function assertion(
  valeur: 'oui' | 'non' = 'oui',
  options: {
    client?: Record<string, unknown>;
    rpId?: string;
    flags?: number;
    autreAppareil?: boolean;
  } = {},
) {
  const numero = valeur === 'oui' ? ctx.demande.numero : '';
  const reponse = { ...ctx.demande, appareil: options.autreAppareil ? 'B' : 'A', valeur, numero };
  const defi = await defiReponse(reponse);
  expect(Buffer.from(defi)).toEqual(createHash('sha256').update(jsonCanonique(reponse)).digest());
  const client = Buffer.from(
    JSON.stringify({
      type: 'webauthn.get',
      origin: ctx.origine,
      challenge: Buffer.from(defi).toString('base64url'),
      ...options.client,
    }),
  );
  // Le compteur reste à zéro, comme celui des passkeys synchronisées.
  const authentificateur = Buffer.concat([
    createHash('sha256')
      .update(options.rpId ?? ctx.rpId)
      .digest(),
    Buffer.from([options.flags ?? 5]),
    Buffer.alloc(4),
  ]);
  const signature = sign(
    'sha256',
    Buffer.concat([authentificateur, createHash('sha256').update(client).digest()]),
    options.autreAppareil ? paireB.privateKey : paire.privateKey,
  );
  return {
    appareil: options.autreAppareil ? 'B' : 'A',
    demande: 'demande',
    rawId: options.autreAppareil ? 'Yg' : 'YQ',
    authenticatorData: authentificateur.toString('base64url'),
    clientDataJSON: client.toString('base64url'),
    signature: signature.toString('base64url'),
    valeur,
    numero: valeur === 'oui' ? numero : null,
  };
}
it('accepte oui et non avec un compteur nul, et non sans numéro', async () => {
  for (const valeur of ['oui', 'non'] as const)
    expect(await verifierAssertion(await assertion(valeur), ctx)).toEqual({ ok: true, valeur });
  const sansNumero: Record<string, unknown> = await assertion('non');
  delete sansNumero.numero;
  expect(await verifierAssertion(sansNumero, ctx)).toEqual({ ok: true, valeur: 'non' });
});
it('refuse chaque étape dans l’ordre', async () => {
  const valide = await assertion();
  const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
    .publicKey.export({ format: 'der', type: 'spki' })
    .toString('base64url');
  const signature = Buffer.from(valide.signature, 'base64url');
  signature[signature.length - 1] = signature[signature.length - 1]! ^ 1;
  const cas = [
    [{ ...valide, extra: true }, ctx, 'schema'],
    [{ ...valide, appareil: 'x'.repeat(8192) }, ctx, 'taille'],
    [{ ...valide, rawId: 'YQ==' }, ctx, 'schema'],
    [valide, { ...ctx, appareil: { ...ctx.appareil, actif: false } }, 'appareil'],
    [{ ...valide, rawId: 'Yg' }, ctx, 'appareil'],
    [{ ...(await assertion('oui', { autreAppareil: true })), appareil: 'A' }, ctx, 'appareil'],
    [valide, { ...ctx, appareil: { ...ctx.appareil, clePublique: p384 } }, 'algorithme'],
    [await assertion('oui', { client: { type: 'webauthn.create' } }), ctx, 'client'],
    [await assertion('oui', { client: { origin: 'https://autre.example.com' } }), ctx, 'client'],
    [await assertion('oui', { client: { crossOrigin: true } }), ctx, 'client'],
    [await assertion('oui', { rpId: 'autre.example.com' }), ctx, 'rpid'],
    [await assertion('oui', { flags: 1 }), ctx, 'presence'],
    [await assertion('oui', { flags: 4 }), ctx, 'presence'],
    [{ ...valide, numero: '9999' }, ctx, 'defi'],
    [{ ...(await assertion('non')), valeur: 'oui', numero: '1234' }, ctx, 'defi'],
    [{ ...valide, signature: signature.toString('base64url') }, ctx, 'signature'],
    [valide, { ...ctx, maintenant: 1001 }, 'echeance'],
  ] as const;
  for (const [entree, contexte, raison] of cas)
    expect(await verifierAssertion(entree, contexte)).toEqual({ ok: false, raison });
});

it('borne les binaires et refuse les champs absents', async () => {
  const valide = await assertion();
  for (const [champ, longueur, raison] of [
    ['clientDataJSON', 2049, 'taille'],
    ['authenticatorData', 513, 'taille'],
    ['authenticatorData', 36, 'schema'],
    ['signature', 73, 'taille'],
  ] as const) {
    expect(
      await verifierAssertion(
        { ...valide, [champ]: Buffer.alloc(longueur).toString('base64url') },
        ctx,
      ),
    ).toEqual({ ok: false, raison });
  }
  for (const champ of Object.keys(valide).filter((champ) => champ !== 'numero')) {
    const incomplet: Record<string, unknown> = { ...valide };
    delete incomplet[champ];
    expect(await verifierAssertion(incomplet, ctx)).toEqual({ ok: false, raison: 'schema' });
  }
});
it('normalise le numéro du défi non en chaîne vide', async () => {
  const reponse = { ...ctx.demande, appareil: 'A', valeur: 'non' as const };
  expect(Buffer.from(await defiReponse(reponse))).toEqual(
    createHash('sha256')
      .update(jsonCanonique({ ...reponse, numero: '' }))
      .digest(),
  );
});

it('reporte le faux numéro signé après les autres vérifications', async () => {
  const entree = await assertion();
  expect(
    await verifierAssertion(entree, { ...ctx, demande: { ...ctx.demande, numero: '9999' } }),
  ).toEqual({ ok: false, raison: 'numero', signee: true });
});

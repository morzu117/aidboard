import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CLASSE_ACTION,
  defiReponse,
  lireCorpsDemande,
  resumeAction,
  type ActionConfirmee,
  type ParametresActions,
} from '../src/shared/pda.js';
import { verifierAssertion } from '../src/daemon/pda/webauthn.js';

const tete = 'abcdef0' + '1'.repeat(33);
const exemples: ParametresActions = {
  merge: {
    topicId: 'sujet_1',
    depot: 'exemple/projet',
    pr: 42,
    tete,
    strategie: 'squash',
    supprimerBranche: true,
    nettoyer: false,
    teteNettoyage: null,
  },
  push: { topicId: 'sujet_1', branche: 'sujet/test', tete, distante: null },
  nettoyage: {
    topicId: 'sujet_1',
    branche: 'sujet/test',
    tete: null,
    etat: 'closed',
    nonFusionnes: null,
    sale: 'refuser',
  },
  'projet.retirer': { workspaceId: 'projet_1', racine: '/projets/projet' },
  appairage: { appairageId: 'pair_1', nom: 'Téléphone', hIdentite: null, sansIdentite: true },
  'pda.activer': { appareilId: 'pda_1', nom: 'Téléphone', empreinte: 'ABCD-2345' },
  'host.option': { option: 'code', actif: true },
  reglage: { action: 'merge', actif: false },
  desarmement: {},
  essai: {},
};
function corps(action: ActionConfirmee) {
  const params = exemples[action];
  return {
    v: 2,
    id: 'AAAAAAAAAAAAAAAAAAAAAA',
    action,
    classe: CLASSE_ACTION[action],
    params,
    resume: resumeAction(action, params),
    numero: CLASSE_ACTION[action] === 'toujours' ? null : '0123',
    emise: 1000,
    echeance: 901000,
  };
}
const lire = (objet: unknown) => lireCorpsDemande(Buffer.from(JSON.stringify(objet)));
for (const action of Object.keys(exemples) as ActionConfirmee[]) {
  describe(action, () => {
    it('accepte le corps valide et refuse les altérations', () => {
      const c = corps(action);
      expect(lire(c)).toEqual(c);
      expect(() => lire({ ...c, params: { ...c.params, extra: true } })).toThrow();
      const cles = Object.keys(c.params);
      // Pour les schémas vides, il n'existe aucune clé requise à retirer.
      for (const cle of cles) {
        const params = { ...c.params } as Record<string, unknown>;
        delete params[cle];
        expect(() => lire({ ...c, params })).toThrow();
      }
      const sansParams: Record<string, unknown> = { ...c };
      delete sansParams.params;
      expect(() => lire(sansParams)).toThrow();
      expect(() =>
        lire({ ...c, classe: c.classe === 'toujours' ? 'defaut' : 'toujours' }),
      ).toThrow();
      expect(() => lire({ ...c, resume: c.resume + '!' })).toThrow();
      expect(() => lire({ ...c, numero: c.numero === null ? '0123' : null })).toThrow();
      expect(() => lire({ ...c, echeance: c.echeance + 1 })).toThrow();
      expect(() => lire({ ...c, echeance: c.emise - 1 })).toThrow();
      expect(() => lire({ ...c, extra: true })).toThrow();
      expect(() => lire({ ...c, numero: '0123\n' })).toThrow();
    });
  });
}
it('limite le v1 à essai', () => {
  const v1 = {
    v: 1,
    id: 'AAAAAAAAAAAAAAAAAAAAAA',
    action: 'essai',
    sujet: 'Test',
    numero: '0123',
    emise: 1000,
    echeance: 2000,
  };
  expect(lire(v1)).toEqual(v1);
  for (const action of Object.keys(exemples).filter((a) => a !== 'essai'))
    expect(() => lire({ ...v1, action })).toThrow();
});
it('refuse les caractères de contrôle et bidi dans les textes affichés', () => {
  const caracteres = [
    ...Array.from({ length: 32 }, (_, i) => i),
    ...Array.from({ length: 33 }, (_, i) => i + 127),
    0x2028,
    0x2029,
    0x200e,
    0x200f,
    ...Array.from({ length: 5 }, (_, i) => i + 0x202a),
    ...Array.from({ length: 4 }, (_, i) => i + 0x2066),
  ];
  for (const [action, cle] of [
    ['appairage', 'nom'],
    ['pda.activer', 'nom'],
    ['push', 'branche'],
    ['projet.retirer', 'racine'],
  ] as const) {
    const c = corps(action);
    for (const code of caracteres)
      expect(() =>
        lire({ ...c, params: { ...c.params, [cle]: `a${String.fromCodePoint(code)}b` } }),
      ).toThrow();
  }
});
it('refuse les branches et les réglages invalides', () => {
  for (const branche of ['-test', '/test', 'a..b', 'a b', '', 'a'.repeat(201)])
    expect(() => resumeAction('push', { ...exemples.push, branche })).toThrow();
  expect(() => lire({ ...corps('reglage'), params: { action: 'merge', actif: true } })).toThrow();
  expect(() => lire({ ...corps('reglage'), params: { action: 'essai', actif: false } })).toThrow();
});
it('valide les bornes et types des paramètres sans conversion implicite', () => {
  const invalides: Partial<Record<ActionConfirmee, Record<string, unknown[]>>> = {
    merge: {
      topicId: ['', 'a'.repeat(65), 'a.b', 'sujet\n'],
      depot: ['a', '/b', 'a/b/c', 'exemple/projet\n', 'a/'.concat('b'.repeat(99))],
      pr: [0, 1e9 + 1, 1.5, '1'],
      tete: ['A'.repeat(40), 'a'.repeat(39), tete + '\n'],
      strategie: ['autre'],
      supprimerBranche: [1],
      nettoyer: ['false'],
    },
    push: { distante: ['', 'A'.repeat(40)] },
    nettoyage: { tete: [''], etat: ['a'.repeat(61)] },
    appairage: {
      nom: ['a'.repeat(41)],
      hIdentite: ['a'.repeat(42), 'a'.repeat(44), '+'.repeat(43)],
      sansIdentite: [0],
    },
    'projet.retirer': { racine: ['a'.repeat(1025), '/projets/' + 'a'.repeat(61)] },
    'pda.activer': { nom: ['a'.repeat(41)], empreinte: ['abcd-2345', 'ABCD-0189', 'ABCD-2345\n'] },
    'host.option': { option: ['autre'], actif: [0] },
  };
  for (const [action, champs] of Object.entries(invalides)) {
    const c = corps(action as ActionConfirmee);
    for (const [cle, valeurs] of Object.entries(champs))
      for (const valeur of valeurs)
        expect(() => lire({ ...c, params: { ...c.params, [cle]: valeur } })).toThrow();
  }
  expect(() =>
    lire({ ...corps('push'), params: { ...exemples.push, branche: 'a'.repeat(160) } }),
  ).toThrow();
  expect(() => lireCorpsDemande(Buffer.alloc(16385))).toThrow();
  expect(() => lireCorpsDemande(new Uint8Array([255]))).toThrow();
  expect(() => lireCorpsDemande(Buffer.from('{} trailing'))).toThrow();
});
it('construit exactement les invites D229', () => {
  const attendus: Record<ActionConfirmee, string> = {
    merge: 'Merge de exemple/projet#42 (abcdef0), squash, branche supprimée oui',
    push: 'Push de sujet/test (abcdef0)',
    nettoyage: 'Nettoyage du sujet sujet/test',
    'projet.retirer': 'Retrait du projet projet',
    appairage: "Approuver l'appareil Téléphone",
    'host.option': 'Montrer le code aux appareils',
    reglage: 'Confirmations : merge coupée',
    'pda.activer': 'Activer le PDA Téléphone, empreinte ABCD-2345',
    essai: "Demande d'essai",
    desarmement: 'Désarmer les confirmations',
  };
  for (const [action, attendu] of Object.entries(attendus))
    expect(resumeAction(action as ActionConfirmee, exemples[action as ActionConfirmee])).toBe(
      attendu,
    );
  expect(resumeAction('host.option', { option: 'push', actif: false })).toBe(
    'Notifications push sur les appareils',
  );
  expect(resumeAction('merge', { ...exemples.merge, supprimerBranche: false })).toBe(
    'Merge de exemple/projet#42 (abcdef0), squash, branche supprimée non',
  );
});
it('vérifie le numéro externe quand le corps ne le contient pas', async () => {
  const paire = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ctx = {
    appareil: {
      id: 'appareil',
      credId: 'YQ',
      clePublique: paire.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      actif: true,
    },
    demande: { id: 'demande', hDemande: 'hachage', numero: null, echeance: 1000 },
    origine: 'https://example.com',
    rpId: 'example.com',
    maintenant: 1000,
  };
  const challenge = await defiReponse({
    ...ctx.demande,
    appareil: 'appareil',
    valeur: 'oui',
    numero: '0123',
  });
  const client = Buffer.from(
    JSON.stringify({
      type: 'webauthn.get',
      origin: ctx.origine,
      challenge: Buffer.from(challenge).toString('base64url'),
    }),
  );
  const authentificateur = Buffer.concat([
    createHash('sha256').update(ctx.rpId).digest(),
    Buffer.from([5]),
    Buffer.alloc(4),
  ]);
  const signature = sign(
    'sha256',
    Buffer.concat([authentificateur, createHash('sha256').update(client).digest()]),
    paire.privateKey,
  );
  const entree = {
    appareil: 'appareil',
    demande: 'demande',
    rawId: 'YQ',
    authenticatorData: authentificateur.toString('base64url'),
    clientDataJSON: client.toString('base64url'),
    signature: signature.toString('base64url'),
    valeur: 'oui',
    numero: '0123',
  };
  expect(await verifierAssertion(entree, { ...ctx, numeroAttendu: '0123' })).toEqual({
    ok: true,
    valeur: 'oui',
  });
  expect(
    await verifierAssertion({ ...entree, numero: '9999' }, { ...ctx, numeroAttendu: '0123' }),
  ).toEqual({ ok: false, raison: 'numero' });
  expect(await verifierAssertion(entree, ctx)).toEqual({ ok: false, raison: 'numero' });
});

it('accepte les variantes aux bornes des schémas', () => {
  expect(resumeAction('push', { ...exemples.push, distante: tete })).toBe(
    'Push de sujet/test (abcdef0)',
  );
  expect(resumeAction('nettoyage', { ...exemples.nettoyage, tete })).toBe(
    'Nettoyage du sujet sujet/test',
  );
  expect(resumeAction('merge', { ...exemples.merge, pr: 1e9, strategie: 'rebase' })).toContain(
    '#1000000000',
  );
  expect(resumeAction('appairage', { ...exemples.appairage, nom: 'a'.repeat(40) })).toBe(
    "Approuver l'appareil " + 'a'.repeat(40),
  );
  expect(
    resumeAction('projet.retirer', {
      ...exemples['projet.retirer'],
      racine: '/' + 'a/'.repeat(508) + 'projet/',
    }),
  ).toBe('Retrait du projet projet');
});
it('signe les options de nettoyage et les explique dans le résumé', () => {
  for (const teteNettoyage of ['', 'A'.repeat(40), 'a'.repeat(39)])
    expect(() =>
      resumeAction('merge', { ...exemples.merge, nettoyer: true, teteNettoyage }),
    ).toThrow();
  expect(() => resumeAction('merge', { ...exemples.merge, teteNettoyage: tete })).toThrow();
  expect(resumeAction('merge', { ...exemples.merge, nettoyer: true, teteNettoyage: tete })).toBe(
    'Merge de exemple/projet#42 (abcdef0), squash, branche supprimée oui, puis nettoyage',
  );
  expect(
    resumeAction('merge', { ...exemples.merge, nettoyer: true, teteNettoyage: null }),
  ).toContain('puis nettoyage');
  for (const nonFusionnes of [-1, 1.5, 1000001, '3'])
    expect(() =>
      resumeAction('nettoyage', {
        ...exemples.nettoyage,
        nonFusionnes,
      } as ParametresActions['nettoyage']),
    ).toThrow();
  for (const nonFusionnes of [null, 0, 1000000])
    expect(resumeAction('nettoyage', { ...exemples.nettoyage, nonFusionnes })).toContain(
      'Nettoyage du sujet',
    );
  expect(resumeAction('nettoyage', { ...exemples.nettoyage, nonFusionnes: 3, sale: 'force' })).toBe(
    'Nettoyage du sujet sujet/test, 3 commits non fusionnés perdus, modifications locales perdues',
  );
  expect(resumeAction('nettoyage', { ...exemples.nettoyage, sale: 'stash' })).toBe(
    'Nettoyage du sujet sujet/test, modifications locales mises de côté',
  );
  expect(() =>
    lire({ ...corps('nettoyage'), params: { ...exemples.nettoyage, sale: 'autre' } }),
  ).toThrow();
});

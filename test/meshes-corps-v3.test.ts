import { RAISON_BASELINE_ABSENT } from '../src/shared/avis-mesh-api.js';
import { createHash } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { ACTIONS_MESH } from '../src/shared/confirmations.js';
import {
  jsonCanonique,
  lireCorpsDemande,
  resumeActionMesh,
  CLASSE_ACTION,
  type ActionConfirmee,
  type ParamsAction,
} from '../src/shared/pda.js';
import { empreinteChemin, empreinteGateway } from '../src/shared/meshes.js';
import { signerDemande } from '../src/daemon/pda/demande.js';
import { preparerPda } from './helpers/pda.js';

const mesh = {
  nom: 'principal',
  cell: 'principal',
  gateway: empreinteGateway('http://gateway.example.com'),
  proxy: empreinteChemin('/tmp/principal.sock'),
};
const echeances = {
  positions: '2027-01-01T12:00:00Z',
  rebuttal: '2027-01-01T13:00:00Z',
  vote: '2027-01-01T14:00:00Z',
};
const exemples = {
  'mesh.ecrire': {
    action: 'dm.envoyer',
    params: { pair: 'perso', fil: null, kind: 'fyi', texte: 'Bonjour' },
  },
  'mesh.etat': {
    action: 'obligation.prendre',
    params: { carte: 1, obligation: 1, attendu: { status: 'open' } },
  },
  'mesh.avis': {
    params: {
      id: '20261112T120000Z-abcd',
      nom: 'avis-test',
      carte: 1,
      sieges: [],
      echeances,
      texte: 'Question',
    },
  },
  'mesh.avis.motion': {
    params: { id: '20261112T120000Z-abcd', canal: 'avis-test', texte: 'Question', echeances },
  },
  'mesh.avis.baseline-absent': {
    params: {
      id: '20261112T120000Z-abcd',
      canal: 'avis-test',
      motion: 1,
      raison: RAISON_BASELINE_ABSENT,
    },
  },
} as const;
const params = exemples['mesh.ecrire'];
const corps = () => ({
  v: 3,
  id: Buffer.alloc(16, 1).toString('base64url'),
  action: 'mesh.ecrire',
  classe: 'toujours',
  params,
  resume: resumeActionMesh(mesh, 'mesh.ecrire', params),
  numero: null,
  emise: Date.now(),
  echeance: Date.now() + 60_000,
  mesh: { ...mesh },
});
const lire = (c: unknown) => lireCorpsDemande(Buffer.from(jsonCanonique(c)));
const nettoyages: (() => void)[] = [];
afterEach(() => {
  for (const f of nettoyages.splice(0)) f();
});

test('empreintes : gateway normalisé et absence de proxy sans chemin implicite', () => {
  expect(empreinteGateway('HTTP://gateway.example.com:80/')).toBe(mesh.gateway);
  expect(empreinteChemin('')).toBe(
    createHash('sha256')
      .update(jsonCanonique(['']))
      .digest('base64url'),
  );
});
test('v3 valide, résumé préfixé, contexte et empreintes sans chemins', () => {
  expect(lire(corps())).toMatchObject({ v: 3, mesh, resume: '[principal] DM fyi à perso' });
});
for (const niveau of ['corps', 'mesh'] as const) {
  test(`v3 : chaque clé manquante et toute clé supplémentaire dans ${niveau}`, () => {
    const c = corps();
    const objet = niveau === 'corps' ? c : c.mesh;
    for (const cle of Object.keys(objet)) {
      const modifie = structuredClone(c);
      delete (niveau === 'corps' ? modifie : modifie.mesh)[cle as never];
      expect(() => lire(modifie)).toThrow();
    }
    expect(() =>
      lire(niveau === 'corps' ? { ...c, autre: true } : { ...c, mesh: { ...mesh, autre: true } }),
    ).toThrow();
  });
}
for (const nom of ['', 'Principal', 'principal@archive', 'a'.repeat(33), 'principal\n']) {
  test(`v3 : nom refusé ${JSON.stringify(nom)}`, () =>
    expect(() => lire({ ...corps(), mesh: { ...mesh, nom } })).toThrow());
}
for (const cell of ['', 'a b', 'a\nb', 'a\u0000b', 'a\u007fb', 'a'.repeat(65)]) {
  test(`v3 : cell refusée ${JSON.stringify(cell)}`, () =>
    expect(() => lire({ ...corps(), mesh: { ...mesh, cell } })).toThrow());
}
for (const champ of ['gateway', 'proxy']) {
  test(`v3 : empreinte ${champ} strictement sha256 base64url`, () => {
    for (const valeur of ['', 'a'.repeat(42), 'a'.repeat(44), '/'.repeat(43), 'a'.repeat(42) + 'B'])
      expect(() => lire({ ...corps(), mesh: { ...mesh, [champ]: valeur } })).toThrow();
  });
}
test('v3 : action hors mesh et résumé falsifié refusés ; v2 avec mesh refusée', () => {
  expect(() => lire({ ...corps(), action: 'push', classe: CLASSE_ACTION.push })).toThrow();
  expect(() => lire({ ...corps(), resume: 'Faux résumé' })).toThrow();
  expect(() => lire({ ...corps(), v: 2 })).toThrow();
});
for (const action of ACTIONS_MESH) {
  test(`signature v3 obligatoire pour ${action}`, async () => {
    const t = preparerPda();
    nettoyages.push(t.nettoyer);
    const entree = {
      action: action as ActionConfirmee,
      params: exemples[action as keyof typeof exemples],
      maintenant: Date.now(),
    } as ParamsAction & { maintenant: number };
    const demande = await signerDemande({ ...entree, mesh }, t.fournisseur);
    expect(lireCorpsDemande(Buffer.from(demande.enveloppe.corps, 'base64url'))).toMatchObject({
      v: 3,
      mesh,
    });
    expect(demande.corps.v !== 1 && demande.corps.resume.startsWith('[principal] ')).toBe(true);
    await expect(signerDemande(entree, t.fournisseur)).rejects.toThrow('mesh_requis');
  });
}

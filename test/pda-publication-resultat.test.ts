import { afterEach, expect, test, vi } from 'vitest';
import { FilePda } from '../src/daemon/pda/file.js';
import { ClientRelais, type RelaisPda, type ReponseRelais } from '../src/daemon/pda/relais.js';
import { creerPorte, type ActionsPorte } from '../src/daemon/confirmations/porte.js';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import { AidHttpError } from '../src/daemon/errors.js';
import { verifierResultat, type Enveloppe, type ParamsAction } from '../src/shared/pda.js';
import { assertionPda, preparerPda } from './helpers/pda.js';

const nettoyages: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const nettoyer of nettoyages.splice(0).reverse()) await nettoyer();
  vi.useRealTimers();
});
type Cas =
  | 'succes'
  | 'script'
  | 'delai'
  | 'conflit'
  | 'perimee'
  | 'json'
  | 'schema'
  | 'changement'
  | 'mesh'
  | 'mesh-echec'
  | 'mesh-hachage'
  | 'numero'
  | 'annuler';
async function preparer(cas: Cas = 'succes', reecrire = false) {
  const t = preparerPda();
  nettoyages.push(t.nettoyer);
  const appareil = await t.appareil();
  let heure = 1_800_000_000_000;
  const config = structuredClone(DEFAULT_CONFIG);
  config.modeHost.actif = true;
  config.modeHost.pda = true;
  config.modeHost.relais = 'https://example.com';
  let reponses: ReponseRelais[] = [];
  const relais = {
    publierAutorises: vi.fn<RelaisPda['publierAutorises']>(async () => true),
    publierResultat: vi.fn<RelaisPda['publierResultat']>(async () => true),
    deposer: vi.fn<RelaisPda['deposer']>(async () => true),
    retirer: vi.fn(async () => {}),
    tirer: vi.fn(async () => {
      const r = reponses;
      reponses = [];
      return r;
    }),
  };
  const mesh = cas.startsWith('mesh');
  const entree: ParamsAction = mesh
    ? {
        action: 'mesh.ecrire',
        params: {
          action: 'canal.poster',
          params: { canal: 'exemple', kind: 'fyi', texte: 'CONTENU_PRIVE' },
        },
      }
    : {
        action: 'push',
        params: { topicId: 'exemple', branche: 'exemple', tete: 'a'.repeat(40), distante: null },
      };
  const definition = {
    preparer: vi.fn(async () =>
      cas === 'changement' ? { ...entree.params, branche: 'autre' } : entree.params,
    ),
    executer: vi.fn(async (_params: unknown, ctx: { envoi?: unknown }) => {
      if (cas === 'script') throw new Error('ERREUR_PRIVEE');
      if (cas === 'delai') throw new Error('delai');
      if (cas === 'conflit') throw new AidHttpError(409, 'ERREUR_PRIVEE');
      if (mesh)
        ctx.envoi = {
          code: cas === 'mesh-echec' ? 'upstream_ambiguous' : 'succes',
          status: 201,
          detail: 'DETAIL_PRIVE',
          current_stage: 'ETAPE_PRIVEE',
          id: 42,
          open_obligations: [8],
        };
    }),
  };
  const porte = creerPorte({
    ...t,
    actions: { push: definition, 'mesh.ecrire': definition } as unknown as ActionsPorte,
    file: () => file,
  });
  const file = new FilePda({
    ...t,
    relais,
    actif: () => config.modeHost.actif && config.modeHost.pda && !!config.modeHost.relais,
    contexte: () => ({ origine: 'https://aid-e2e.ts.net', rpId: 'aid-e2e.ts.net' }),
    maintenant: () => heure,
    signaler: () => {},
    preparerConsommation: async (ligne) => {
      if (cas === 'perimee') ligne.perimee = true;
      return () => {};
    },
    executer: (ligne) => porte.executerConfirmee(ligne),
  });
  nettoyages.push(() => file.arreter());
  const { id } = await file.creerDemande(entree);
  if (cas === 'json' || cas === 'schema' || cas === 'mesh-hachage')
    t.db
      .prepare('UPDATE pda_demandes SET params = ? WHERE id = ?')
      .run(cas === 'json' ? '{' : '{}', id);
  const ligne = t.db
    .prepare('SELECT numero, numero_mac FROM pda_demandes WHERE id = ?')
    .get(id) as { numero: string; numero_mac: string | null };
  if (cas === 'numero')
    t.db
      .prepare("UPDATE pda_demandes SET classe = 'toujours', numero_mac = ? WHERE id = ?")
      .run(ligne.numero === '0000' ? '0001' : '0000', id);
  if (reecrire) {
    // La base réécrit après chaque écriture : un corps construit en mémoire serait différent.
    t.db.exec(`CREATE TRIGGER resultat_relu AFTER UPDATE OF resultat ON pda_demandes
      WHEN NEW.resultat IS NOT NULL BEGIN
        UPDATE pda_demandes SET raison = CASE WHEN NEW.raison = 'numero' THEN 'script' ELSE 'numero' END,
        envoi = CASE WHEN NEW.action = 'mesh.ecrire' THEN '{"code":"format","detail":"DETAIL_PRIVE"}' ELSE NULL END
        WHERE id = NEW.id;
      END`);
  }
  async function oui(valeur: 'oui' | 'non' = 'oui') {
    reponses = [
      {
        id,
        appareil: appareil.id,
        curseur: 1,
        corps: Buffer.from(
          JSON.stringify(
            await assertionPda(t.db, id, appareil, valeur, ligne.numero_mac ?? ligne.numero),
          ),
        ).toString('base64url'),
      },
    ];
  }
  async function verifier() {
    const appels = relais.publierResultat.mock.calls;
    const [identifiant, enveloppe] = appels.at(-1)!;
    expect(identifiant).toBe(id);
    const stockee = t.db
      .prepare('SELECT action, resultat, raison, envoi FROM pda_demandes WHERE id = ?')
      .get(id) as { action: string; resultat: string; raison: string | null; envoi: string | null };
    expect(await verifierResultat(enveloppe, t.fournisseur.clePubliqueRaw())).toEqual({
      v: 1,
      id,
      action: stockee.action,
      resultat: stockee.resultat,
      raison: stockee.raison,
      code: stockee.envoi === null ? null : JSON.parse(stockee.envoi).code,
      emis: 1_800_000_000_000,
    });
    const texte = Buffer.from(enveloppe.corps, 'base64url').toString();
    for (const secret of [
      'CONTENU_PRIVE',
      'DETAIL_PRIVE',
      'ETAPE_PRIVEE',
      'open_obligations',
      'status',
      'ERREUR_PRIVEE',
    ])
      expect(texte).not.toContain(secret);
  }
  return {
    ...t,
    id,
    file,
    relais,
    oui,
    verifier,
    definition,
    heure: (v: number) => {
      heure = v;
    },
    couper: () => {
      config.modeHost.relais = null;
    },
  };
}

const attendus = {
  succes: ['executee', null],
  script: ['echouee', 'script'],
  delai: ['echouee', 'delai'],
  conflit: ['perimee', 'perime'],
  perimee: ['perimee', 'perime'],
  json: ['perimee', 'perime'],
  schema: ['perimee', 'perime'],
  changement: ['perimee', 'perime'],
  mesh: ['executee', null],
  'mesh-echec': ['echouee', null],
  'mesh-hachage': ['perimee', 'perime'],
  numero: ['annulee', 'numero'],
  annuler: ['annulee', null],
} as const;
for (const cas of Object.keys(attendus) as Cas[])
  for (const reecrire of [false, true]) {
    test(`${cas} : publication au tour suivant${reecrire ? ', ligne réécrite relue' : ''}`, async () => {
      const t = await preparer(cas, reecrire);
      await t.oui();
      if (cas === 'annuler') await t.file.annuler(t.id);
      await t.file.tour();
      // L'annulation a été mise en file avant le tour ; les autres le sont pendant le tour.
      if (cas !== 'annuler') {
        expect(t.relais.publierResultat).not.toHaveBeenCalled();
        await t.file.tour();
      }
      expect(t.relais.publierResultat).toHaveBeenCalledTimes(1);
      await t.verifier();
      if (!reecrire)
        expect(
          t.db.prepare('SELECT resultat, raison FROM pda_demandes WHERE id = ?').get(t.id),
        ).toEqual({ resultat: attendus[cas][0], raison: attendus[cas][1] });
      await t.file.tour();
      expect(t.relais.publierResultat).toHaveBeenCalledTimes(1);
    });
  }

test('retente une enveloppe identique, réussit puis retire la publication', async () => {
  const t = await preparer();
  t.relais.publierResultat
    .mockRejectedValueOnce(new Error('CONTENU_PRIVE'))
    .mockResolvedValueOnce(false);
  await t.oui();
  await t.file.tour();
  for (let i = 0; i < 3; i++) await t.file.tour();
  expect(t.relais.publierResultat).toHaveBeenCalledTimes(3);
  expect(t.relais.publierResultat.mock.calls[0]).toEqual(t.relais.publierResultat.mock.calls[2]);
  await t.file.tour();
  expect(t.relais.publierResultat).toHaveBeenCalledTimes(3);
  expect(t.journal).toHaveBeenCalledWith('pda.resultat.echec', { id: t.id });
  expect(JSON.stringify(t.journal.mock.calls)).not.toContain('CONTENU_PRIVE');
});

test('retente pendant une heure puis abandonne à la borne sans nouvel envoi', async () => {
  const t = await preparer();
  t.relais.publierResultat.mockResolvedValue(false);
  await t.oui();
  await t.file.tour();
  for (let i = 1; i < 240; i++) {
    t.heure(1_800_000_000_000 + i * 15_000);
    await t.file.tour();
  }
  expect(t.relais.publierResultat).toHaveBeenCalledTimes(239);
  t.heure(1_800_003_600_000);
  await t.file.tour();
  await t.file.tour();
  expect(t.relais.publierResultat).toHaveBeenCalledTimes(239);
  expect(t.journal).toHaveBeenCalledWith('pda.resultat.abandon', { id: t.id });
});

test('la minuterie poursuit les résultats même sans demande ouverte', async () => {
  vi.useFakeTimers();
  const t = await preparer();
  await t.oui();
  await t.file.tour();
  expect(t.relais.publierResultat).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(t.relais.publierResultat).toHaveBeenCalledTimes(1);
});

test('sans relais configuré : le prédicat actif du daemon interdit toute publication', async () => {
  const t = await preparer();
  await t.oui();
  await t.file.tour();
  t.couper();
  await t.file.tour();
  await t.file.annuler(t.id);
  expect(t.relais.publierResultat).not.toHaveBeenCalled();
});

test('une valeur illégale relue ne quitte pas le daemon et ne paraît pas au journal', async () => {
  const t = await preparer();
  t.db.exec(
    "CREATE TRIGGER resultat_invalide AFTER UPDATE OF resultat ON pda_demandes WHEN NEW.resultat IS NOT NULL BEGIN UPDATE pda_demandes SET raison = 'CONTENU_PRIVE' WHERE id = NEW.id; END",
  );
  await t.oui();
  await t.file.tour();
  await t.file.tour();
  expect(t.relais.publierResultat).not.toHaveBeenCalled();
  expect(t.journal).toHaveBeenCalledWith('pda.resultat.invalide', { id: t.id });
  expect(JSON.stringify(t.journal.mock.calls)).not.toContain('CONTENU_PRIVE');
});

test('client : PUT du résultat signé par la clé daemon', async () => {
  const t = preparerPda();
  nettoyages.push(t.nettoyer);
  const transport = vi.fn(async () => new Response(null, { status: 204 }));
  const client = new ClientRelais({
    relais: 'https://example.com',
    fournisseur: t.fournisseur,
    journal: t.journal,
    transport,
  });
  const enveloppe: Enveloppe = { corps: 'opaque', sig: 'opaque' };
  expect(await client.publierResultat('A'.repeat(22), enveloppe)).toBe(true);
  expect(transport).toHaveBeenCalledWith(
    new URL(`https://example.com/resultats/${'A'.repeat(22)}`),
    expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify(enveloppe),
      headers: expect.objectContaining({ 'X-Aid-Sig': expect.any(String) }),
    }),
  );
});

for (const cas of ['refus', 'expiration'] as const) {
  test(`${cas} : aucun résultat publié`, async () => {
    const t = await preparer();
    if (cas === 'refus') await t.oui('non');
    else t.heure(1_800_000_900_001);
    await t.file.tour();
    await t.file.tour();
    expect(t.relais.publierResultat).not.toHaveBeenCalled();
    expect(t.definition.executer).not.toHaveBeenCalled();
  });
}

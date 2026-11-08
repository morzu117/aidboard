import { afterEach, expect, test, vi } from 'vitest';
import { FilePda } from '../src/daemon/pda/file.js';
import { ClientRelais, type RelaisPda, type ReponseRelais } from '../src/daemon/pda/relais.js';
import { assertionPda, preparerPda } from './helpers/pda.js';

const nettoyages: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const f of nettoyages.splice(0).reverse()) await f();
  vi.useRealTimers();
});
async function preparer() {
  const t = preparerPda();
  nettoyages.push(t.nettoyer);
  const a = await t.appareil();
  const b = await t.appareil();
  let heure = 1_800_000_000_000;
  let actif = true;
  let contexte: { origine: string; rpId: string } | null = {
    origine: 'https://aid-e2e.ts.net',
    rpId: 'aid-e2e.ts.net',
  };
  let reponses: ReponseRelais[] = [];
  const relais = {
    publierAutorises: vi.fn<RelaisPda['publierAutorises']>(async () => true),
    deposer: vi.fn<RelaisPda['deposer']>(async () => true),
    retirer: vi.fn(async () => {}),
    tirer: vi.fn(async () => reponses),
  };
  const signaler = vi.fn();
  const options = {
    ...t,
    relais: relais as RelaisPda,
    actif: () => actif,
    contexte: () => contexte,
    maintenant: () => heure,
    signaler,
  };
  const file = new FilePda(options);
  nettoyages.push(() => file.arreter());
  const { id } = await file.creerDemande({ action: 'essai', sujet: 'Exemple' });
  function repondre(corps: unknown, appareil = a.id, demande = id, curseur = 1) {
    return {
      curseur,
      id: demande,
      appareil,
      corps: Buffer.from(JSON.stringify(corps)).toString('base64url'),
    };
  }
  return {
    ...t,
    file,
    id,
    a,
    b,
    relais,
    signaler,
    options,
    repondre,
    reponses: (r: ReponseRelais[]) => {
      reponses = r;
    },
    heure: (h: number) => {
      heure = h;
    },
    couper: () => {
      actif = false;
    },
    contexte: (c: typeof contexte) => {
      contexte = c;
    },
  };
}
for (const valeur of ['oui', 'non'] as const) {
  test(`${valeur} valide : consommation avant une seule exécution et retrait`, async () => {
    const t = await preparer();
    const reponse = t.repondre(await assertionPda(t.db, t.id, t.a, valeur));
    t.reponses([reponse, { ...reponse, curseur: 2 }]);
    await t.file.tour();
    expect(t.file.etat(t.id)).toEqual({ etat: valeur === 'oui' ? 'confirmee' : 'refusee' });
    expect(t.journal.mock.calls.filter(([type]) => type === 'pda.essai')).toEqual([
      ['pda.essai', { id: t.id, valeur }],
    ]);
    expect(t.journal).toHaveBeenCalledWith('pda.tardive', { id: t.id });
    expect(t.relais.retirer).toHaveBeenCalledExactlyOnceWith(t.id);
    expect(t.db.prepare('SELECT consomme_a FROM pda_demandes').get()).toEqual({
      consomme_a: new Date(1_800_000_000_000).toISOString(),
    });
    expect(t.signaler).toHaveBeenCalledTimes(2);
  });
}
test('permutation : ni l’identité externe ni l’identité interne ne sont crues', async () => {
  const t = await preparer();
  const assertion = await assertionPda(t.db, t.id, t.a);
  t.reponses([
    t.repondre(assertion, t.b.id),
    t.repondre({ ...assertion, appareil: t.b.id }, t.b.id, t.id, 2),
  ]);
  await t.file.tour();
  expect(t.file.etat(t.id)).toEqual({ etat: 'ouverte' });
  expect(t.journal.mock.calls.filter(([type]) => type === 'pda.refus')).toHaveLength(2);
});
test('modification non → oui : refus du défi', async () => {
  const t = await preparer();
  const non = await assertionPda(t.db, t.id, t.a, 'non');
  const oui = await assertionPda(t.db, t.id, t.a);
  t.reponses([t.repondre({ ...non, valeur: 'oui', numero: oui.numero })]);
  await t.file.tour();
  expect(t.journal).toHaveBeenCalledWith('pda.refus', { appareil: t.a.id, raison: 'defi' });
  expect(t.file.etat(t.id)).toEqual({ etat: 'ouverte' });
});
test('retard : horloge locale, refus echeance puis expiration', async () => {
  const t = await preparer();
  t.reponses([t.repondre(await assertionPda(t.db, t.id, t.a))]);
  t.heure(1_800_000_300_001);
  await t.file.tour();
  expect(t.journal).toHaveBeenCalledWith('pda.refus', { appareil: t.a.id, raison: 'echeance' });
  expect(t.file.etat(t.id)).toEqual({ etat: 'expiree' });
  expect(t.relais.retirer).toHaveBeenCalledWith(t.id);
});
test('demande inconnue et appareil révoqué restent sans effet', async () => {
  const t = await preparer();
  const assertion = await assertionPda(t.db, t.id, t.a);
  t.registre.revoquer(t.a.id);
  t.reponses([t.repondre(assertion, t.a.id, 'inconnue'), t.repondre(assertion, t.a.id, t.id, 2)]);
  await t.file.tour();
  expect(t.journal).toHaveBeenCalledWith('pda.refus', { appareil: t.a.id, raison: 'demande' });
  expect(t.journal).toHaveBeenCalledWith('pda.refus', { appareil: t.a.id, raison: 'appareil' });
  expect(t.file.etat(t.id)).toEqual({ etat: 'ouverte' });
});
test('deux appareils : la première réponse gagne, la seconde est tardive', async () => {
  const t = await preparer();
  t.reponses([
    t.repondre(await assertionPda(t.db, t.id, t.a)),
    t.repondre(await assertionPda(t.db, t.id, t.b, 'non'), t.b.id, t.id, 2),
  ]);
  await t.file.tour();
  expect(t.file.etat(t.id)).toEqual({ etat: 'confirmee' });
  expect(t.journal).toHaveBeenCalledWith('pda.tardive', { id: t.id });
  expect(t.journal.mock.calls.filter(([type]) => type === 'pda.essai')).toHaveLength(1);
});
test('bornes et JSON invalide sans conservation du curseur', async () => {
  const t = await preparer();
  t.reponses([
    t.repondre('x'.repeat(8193)),
    { ...t.repondre({}), corps: '!' },
    t.repondre({}, t.a.id, t.id, 3),
  ]);
  await t.file.tour();
  t.reponses([]);
  await t.file.tour();
  expect(t.relais.tirer).toHaveBeenLastCalledWith(0);
  expect(t.journal).toHaveBeenCalledWith('pda.refus', { raison: 'taille' });
  expect(t.file.etat(t.id)).toEqual({ etat: 'ouverte' });
});
test('origine et rpId sont relus, aucun essai sans nom', async () => {
  const t = await preparer();
  t.reponses([t.repondre(await assertionPda(t.db, t.id, t.a))]);
  t.contexte({ origine: 'https://autre.aid-e2e.ts.net', rpId: 'autre.aid-e2e.ts.net' });
  await t.file.tour();
  expect(t.journal).toHaveBeenCalledWith('pda.refus', { appareil: t.a.id, raison: 'client' });
  t.contexte(null);
  await expect(t.file.creerDemande({ action: 'essai', sujet: 'Exemple' })).rejects.toThrow();
});
test('publication des actifs à l’allumage et après changement', async () => {
  const t = await preparer();
  const appels = t.relais.publierAutorises.mock.calls as unknown as Array<
    [Array<{ id: string; cle: unknown }>]
  >;
  expect(appels[0]![0].map((a) => a.id).sort()).toEqual([t.a.id, t.b.id].sort());
  t.registre.revoquer(t.a.id);
  await t.file.publierAutorises();
  expect(appels.at(-1)![0]).toHaveLength(1);
  expect(appels.at(-1)![0][0]).toMatchObject({ id: t.b.id, cle: { kty: 'EC', crv: 'P-256' } });
});
test('minuterie à 15 s, arrêt et allumage qui expire les ouvertes', async () => {
  vi.useFakeTimers();
  const t = await preparer();
  expect(t.relais.tirer).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(t.relais.tirer).toHaveBeenCalledOnce();
  t.couper();
  await t.file.arreter();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(t.relais.tirer).toHaveBeenCalledOnce();
  const suivante = new FilePda({ ...t.options, actif: () => true });
  nettoyages.push(() => suivante.arreter());
  await suivante.publierAutorises();
  expect(suivante.etat(t.id)).toEqual({ etat: 'expiree' });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(t.relais.tirer).toHaveBeenCalledOnce();
});
for (const cas of [302, 500, 'taille', 'exception'] as const) {
  test(`client hostile ${cas} : pas d’exception et demande ouverte`, async () => {
    const t = await preparer();
    const transport = vi.fn<
      NonNullable<ConstructorParameters<typeof ClientRelais>[0]['transport']>
    >(async (_url, options) => {
      if (options.method !== 'GET') return new Response(null, { status: 204 });
      if (cas === 'exception') throw new Error('contenu à ne pas journaliser');
      return new Response(cas === 'taille' ? 'x'.repeat(65 * 1024) : null, {
        status: typeof cas === 'number' ? cas : 200,
      });
    });
    const client = new ClientRelais({
      relais: 'https://example.com',
      fournisseur: t.fournisseur,
      journal: t.journal,
      transport,
    });
    const autre = new FilePda({ ...t.options, relais: client });
    nettoyages.push(() => autre.arreter());
    const { id } = await autre.creerDemande({ action: 'essai', sujet: 'Exemple' });
    await expect(autre.tour()).resolves.toBeUndefined();
    expect(autre.etat(id)).toEqual({ etat: 'ouverte' });
    expect(t.journal).toHaveBeenCalledWith('pda.relais.echec');
    expect(JSON.stringify(t.journal.mock.calls)).not.toContain('contenu à ne pas journaliser');
    expect(transport.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'manual',
      signal: expect.any(AbortSignal),
    });
  });
}

test('une file vide ne sonde pas et une échéance sans réponse expire la demande', async () => {
  vi.useFakeTimers();
  const t = await preparer();
  t.heure(1_800_000_300_001);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(t.file.etat(t.id)).toEqual({ etat: 'expiree' });
  expect(t.relais.tirer).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(t.relais.tirer).toHaveBeenCalledOnce();
});

test('la minuterie survit à une erreur de sondage sans contenu dans le journal', async () => {
  vi.useFakeTimers();
  const t = await preparer();
  t.relais.tirer.mockRejectedValueOnce(new Error('contenu distant'));
  await vi.advanceTimersByTimeAsync(15_000);
  expect(t.journal).toHaveBeenCalledWith('pda.file.echec', {});
  await vi.advanceTimersByTimeAsync(15_000);
  expect(t.relais.tirer).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(t.journal.mock.calls)).not.toContain('contenu distant');
});

test('un curseur hostile puis un redémarrage du relais ne masquent aucune réponse', async () => {
  const t = await preparer();
  t.reponses([t.repondre({}, t.a.id, t.id, 1e15)]);
  await t.file.tour();
  t.reponses([t.repondre(await assertionPda(t.db, t.id, t.a))]);
  await t.file.tour();
  expect(t.relais.tirer.mock.calls).toEqual([[0], [0]]);
  expect(t.file.etat(t.id)).toEqual({ etat: 'confirmee' });
});

test('une liste oubliée est republiée avant le dépôt d’une nouvelle demande', async () => {
  const t = await preparer();
  let autorises: unknown[] = [];
  t.relais.publierAutorises.mockImplementation(async (liste) => {
    autorises = liste;
    return true;
  });
  t.relais.deposer.mockImplementation(async () => {
    expect(autorises).toHaveLength(2);
    return true;
  });
  await t.file.creerDemande({ action: 'essai', sujet: 'Exemple' });
  expect(t.relais.publierAutorises).toHaveBeenCalledTimes(3);
});

test('le tour renouvelle une publication de plus de cinq minutes et retente un échec', async () => {
  const t = await preparer();
  t.db.prepare('UPDATE pda_demandes SET echeance = ?').run(1_800_001_200_000);
  t.heure(1_800_000_300_000);
  await t.file.tour();
  expect(t.relais.publierAutorises).toHaveBeenCalledTimes(2);
  t.relais.publierAutorises.mockResolvedValueOnce(false);
  t.heure(1_800_000_300_001);
  await t.file.tour();
  expect(t.relais.publierAutorises).toHaveBeenCalledTimes(3);
  await t.file.tour();
  expect(t.relais.publierAutorises).toHaveBeenCalledTimes(4);
  await t.file.tour();
  expect(t.relais.publierAutorises).toHaveBeenCalledTimes(4);
});

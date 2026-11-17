import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceCommandant } from '../src/daemon/commandant/service.js';
import { IdentifiantsCockpit } from '../src/daemon/commandant/identifiant.js';
import {
  creerPasserelleCommandant,
  IDENTIFIANT_COCKPIT_TEST,
  ligneCommandantTest,
} from './fixtures/passerelle-commandant.js';

const nettoyages: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const f of nettoyages.splice(0).reverse()) await f();
  vi.useRealTimers();
});
function preparer(options: Partial<ConstructorParameters<typeof ServiceCommandant>[0]> = {}) {
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'aid-commandant-service-'));
  if (!options.home) nettoyages.push(() => rmSync(home, { recursive: true, force: true }));
  const notifier = vi.fn<(id: number) => Promise<void>>(async () => {});
  const service = new ServiceCommandant({
    home,
    meshes: () => ({ principal: { gateway: 'http://example.com', cell: 'cell-lab' } }),
    notifier,
    ...options,
  });
  nettoyages.push(() => service.arreter());
  return { home, service, notifier };
}
function transportMemoire() {
  const lignes = new Map([[1, ligneCommandantTest(1)]]);
  let erreur: { http: number; corps: unknown } | null = null;
  const transport = vi.fn<typeof fetch>(async (url) => {
    if (erreur) return new Response(JSON.stringify(erreur.corps), { status: erreur.http });
    const u = new URL(String(url));
    const id = u.pathname.split('/').at(-1)!;
    return new Response(
      JSON.stringify(
        id === 'requests'
          ? [...lignes.values()].filter((v) => v.status === 'pending')
          : lignes.get(Number(id)),
      ),
    );
  });
  return {
    lignes,
    transport,
    erreur: (e: typeof erreur) => {
      erreur = e;
    },
  };
}
describe('lecture périodique du commandant', () => {
  it('ne lit rien sans identifiant, puis lit immédiatement et toutes les cinq minutes', async () => {
    vi.useFakeTimers();
    const faux = transportMemoire();
    const t = preparer({ client: { transport: faux.transport } });
    await t.service.demarrer();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(faux.transport).not.toHaveBeenCalled();
    await t.service.saisir('principal', IDENTIFIANT_COCKPIT_TEST);
    expect(faux.transport).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(faux.transport).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(faux.transport).toHaveBeenCalledTimes(4);
    expect(t.service.etat('principal')).toMatchObject({
      lignes: [{ ligne: { id: 1 } }],
      identifiant: { etat: 'valide' },
      derniereLecture: new Date().toISOString(),
    });
    t.service.supprimer('principal');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(faux.transport).toHaveBeenCalledTimes(4);
    expect(t.service.etat('principal').identifiant).toEqual({ etat: 'absent', saisie: null });
  });
  it('lit à chaque ouverture et toutes les trente secondes ; un battement ne reporte pas la lecture', async () => {
    vi.useFakeTimers();
    const faux = transportMemoire();
    const t = preparer({ client: { transport: faux.transport } });
    await t.service.saisir('principal', IDENTIFIANT_COCKPIT_TEST);
    await t.service.battement('principal');
    expect(faux.transport).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(20_000);
    await t.service.battement('principal');
    expect(faux.transport).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(faux.transport).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(faux.transport).toHaveBeenCalledTimes(10);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(faux.transport).toHaveBeenCalledTimes(10);
    await vi.advanceTimersByTimeAsync(1);
    expect(faux.transport).toHaveBeenCalledTimes(12);
    await t.service.battement('principal');
    expect(faux.transport).toHaveBeenCalledTimes(14);
  });
  it.each([
    ['expired', 'expire'],
    ['revoked', 'revoque'],
    ['unknown', 'inconnu'],
  ] as const)(
    'arrête les lectures après 401 %s jusqu’à une nouvelle saisie',
    async (code, etat) => {
      vi.useFakeTimers();
      const faux = transportMemoire();
      faux.erreur({ http: 401, corps: { error: `cockpit_credential_${code}` } });
      const t = preparer({ client: { transport: faux.transport } });
      await t.service.saisir('principal', IDENTIFIANT_COCKPIT_TEST);
      expect(t.service.etat('principal').identifiant.etat).toBe(etat);
      await vi.advanceTimersByTimeAsync(900_000);
      await t.service.battement('principal');
      await t.service.actualiser('principal');
      await t.service.detail('principal', 1);
      expect(faux.transport).toHaveBeenCalledTimes(1);
      faux.erreur(null);
      await t.service.saisir('principal', IDENTIFIANT_COCKPIT_TEST);
      expect(t.service.etat('principal').identifiant.etat).toBe('valide');
      expect(faux.transport).toHaveBeenCalledTimes(3);
    },
  );
  it.each([401, 403])('classe les autres %i comme refuse sans arrêt définitif', async (http) => {
    vi.useFakeTimers();
    const faux = transportMemoire();
    faux.erreur({ http, corps: { error: 'autre' } });
    const t = preparer({ client: { transport: faux.transport } });
    await t.service.saisir('principal', IDENTIFIANT_COCKPIT_TEST);
    expect(t.service.etat('principal').identifiant.etat).toBe('refuse');
    faux.erreur(null);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(t.service.etat('principal').identifiant.etat).toBe('valide');
  });
  it('garde les refus sans contenu, notifie les nouvelles pending une fois et persiste seulement les ids', async () => {
    const faux = transportMemoire();
    const t = preparer({ client: { transport: faux.transport } });
    faux.lignes.set(2, { ...ligneCommandantTest(2), digest: '0'.repeat(64) });
    await t.service.saisir('principal', IDENTIFIANT_COCKPIT_TEST);
    await t.service.actualiser('principal');
    expect(t.notifier.mock.calls).toEqual([[1]]);
    expect(t.service.etat('principal').refusees).toEqual([
      { valide: false, id: 2, raison: 'digest' },
    ]);
    const historique = readFileSync(join(t.home, 'cockpit', 'principal.notifies.json'), 'utf8');
    expect(historique).toBe('[1]');
    await t.service.arreter();
    const suite = preparer({ home: t.home, client: { transport: faux.transport } });
    await suite.service.demarrer();
    await suite.service.actualiser('principal');
    expect(suite.notifier).not.toHaveBeenCalled();
    faux.lignes.set(3, ligneCommandantTest(3));
    await suite.service.actualiser('principal');
    expect(suite.notifier.mock.calls).toEqual([[3]]);
  });
  it('isole les états par mesh et recharge les identifiants au démarrage', async () => {
    const faux = transportMemoire();
    const t = preparer({
      meshes: () => ({
        principal: { gateway: 'http://example.com', cell: 'cell-lab' },
        secondaire: { gateway: 'http://example.com', cell: 'cell-test' },
      }),
      client: { transport: faux.transport },
    });
    new IdentifiantsCockpit(t.home).ecrire('principal', IDENTIFIANT_COCKPIT_TEST);
    await t.service.demarrer();
    await t.service.actualiser('principal');
    expect(t.service.etat('principal').lignes).toHaveLength(1);
    expect(t.service.etat('secondaire').identifiant.etat).toBe('absent');
    expect(() => t.service.etat('../autre')).toThrow();
  });
  it('relit le détail, voit une mutation, et ne notifie pas une demande déjà close', async () => {
    const faux = await creerPasserelleCommandant();
    nettoyages.push(() => faux.fermer());
    faux.scenario.avantDetail = (id) => {
      if (id === 1235) {
        const v = ligneCommandantTest(id, 'decision', {
          question: 'Question modifiée ?',
          options: [],
          needs_sso: false,
        });
        v.status = 'answered';
        faux.lignes.set(id, v);
      }
    };
    const t = preparer({ meshes: () => ({ principal: { gateway: faux.url, cell: 'cell-lab' } }) });
    await t.service.saisir('principal', IDENTIFIANT_COCKPIT_TEST);
    expect(t.service.etat('principal').lignes.find((l) => l.ligne.id === 1235)).toMatchObject({
      repondable: false,
      ligne: { question: 'Question modifiée ?', status: 'answered' },
    });
    expect(t.notifier.mock.calls.flat()).not.toContain(1235);
    expect(faux.appels.filter((a) => a.chemin === '/commander/requests/1235')).toHaveLength(1);
    faux.scenario.digestFaux = true;
    await t.service.actualiser('principal');
    expect(t.service.etat('principal').refusees).toHaveLength(2);
  });
  it('une suppression pendant une lecture empêche publication et notification tardives', async () => {
    let debloquer!: () => void;
    const attente = new Promise<void>((r) => {
      debloquer = r;
    });
    const transport: typeof fetch = async () => {
      await attente;
      return new Response(JSON.stringify([ligneCommandantTest(1)]));
    };
    const t = preparer({ client: { transport } });
    const saisie = t.service.saisir('principal', IDENTIFIANT_COCKPIT_TEST);
    t.service.supprimer('principal');
    debloquer();
    await saisie;
    expect(t.service.etat('principal')).toMatchObject({
      lignes: [],
      identifiant: { etat: 'absent' },
    });
    expect(t.notifier).not.toHaveBeenCalled();
  });
  it('le détail refuse un id divergent et un digest faux', async () => {
    let ligne = ligneCommandantTest(2);
    const transport: typeof fetch = async (url) =>
      new Response(JSON.stringify(new URL(String(url)).pathname.endsWith('requests') ? [] : ligne));
    const t = preparer({ client: { transport } });
    await t.service.saisir('principal', IDENTIFIANT_COCKPIT_TEST);
    expect(await t.service.detail('principal', 1)).toMatchObject({
      valide: false,
      id: 1,
      raison: 'forme',
    });
    ligne = { ...ligneCommandantTest(1), digest: '0'.repeat(64) };
    expect(await t.service.detail('principal', 1)).toMatchObject({ raison: 'digest' });
  });
});
it('un 401 terminal invalide aussi une lecture concurrente qui répond tardivement', async () => {
  vi.useFakeTimers();
  let bloquer = false;
  let debloquer!: () => void;
  const attente = new Promise<void>((r) => {
    debloquer = r;
  });
  const transport = vi.fn<typeof fetch>(async (url) => {
    if (new URL(String(url)).pathname.endsWith('requests')) {
      if (bloquer) await attente;
      return new Response('[]');
    }
    return new Response(JSON.stringify({ error: 'cockpit_credential_expired' }), { status: 401 });
  });
  const t = preparer({ client: { transport } });
  await t.service.saisir('principal', IDENTIFIANT_COCKPIT_TEST);
  bloquer = true;
  const lecture = t.service.actualiser('principal');
  await t.service.detail('principal', 1);
  debloquer();
  await lecture;
  expect(t.service.etat('principal').identifiant.etat).toBe('expire');
  await vi.advanceTimersByTimeAsync(600_000);
  expect(transport).toHaveBeenCalledTimes(3);
});
it.each([401, 403])('un %i au corps trop grand reste un identifiant refuse', async (http) => {
  const transport: typeof fetch = async () => new Response('x'.repeat(50), { status: http });
  const t = preparer({ client: { transport, maximumOctets: 10 } });
  await t.service.saisir('principal', IDENTIFIANT_COCKPIT_TEST);
  expect(t.service.etat('principal')).toMatchObject({
    identifiant: { etat: 'refuse' },
    erreur: { code: 'taille', http },
  });
});
it('élague les ids sortis de pending seulement après une lecture complète, sans réécriture ni doublon au redémarrage', async () => {
  const faux = transportMemoire();
  faux.lignes.set(2, ligneCommandantTest(2));
  let erreurDetail = false;
  const transport: typeof fetch = async (url, options) =>
    erreurDetail && new URL(String(url)).pathname.endsWith('/2')
      ? new Response('{}', { status: 500 })
      : faux.transport(url, options);
  const t = preparer({ client: { transport } });
  await t.service.saisir('principal', IDENTIFIANT_COCKPIT_TEST);
  const fichier = join(t.home, 'cockpit', 'principal.notifies.json');
  const ids = () => JSON.parse(readFileSync(fichier, 'utf8'));
  expect(ids()).toEqual([1, 2]);
  expect(t.notifier.mock.calls).toEqual([[1], [2]]);
  utimesSync(fichier, 1, 1);
  const modification = statSync(fichier).mtimeMs;
  await t.service.actualiser('principal');
  expect(statSync(fichier).mtimeMs).toBe(modification);
  faux.lignes.delete(1);
  faux.erreur({ http: 500, corps: {} });
  await t.service.actualiser('principal');
  expect(ids()).toEqual([1, 2]);
  faux.erreur(null);
  erreurDetail = true;
  await t.service.actualiser('principal');
  expect(ids()).toEqual([1, 2]);
  erreurDetail = false;
  faux.lignes.set(2, { ...ligneCommandantTest(2), digest: '0'.repeat(64) });
  await t.service.actualiser('principal');
  expect(ids()).toEqual([1, 2]);
  faux.lignes.set(2, ligneCommandantTest(2));
  await t.service.actualiser('principal');
  expect(ids()).toEqual([2]);
  expect(t.notifier.mock.calls).toEqual([[1], [2]]);
  await t.service.arreter();
  utimesSync(fichier, 1, 1);
  const suite = preparer({ home: t.home, client: { transport } });
  await suite.service.demarrer();
  await suite.service.actualiser('principal');
  expect(ids()).toEqual([2]);
  expect(statSync(fichier).mtimeMs).toBe(modification);
  expect(suite.notifier).not.toHaveBeenCalled();
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { Appareil, EtatModeHostDaemon, VueDemande } from '../../src/shared/host.js';
import { RELECTURE_DEMANDE_MS } from '../../web/src/data/host.js';
import { Cockpit, pilule } from '../../web/src/ui/Cockpit.js';
import { cheminQr } from '../../web/src/ui/Qr.js';
import { json, setup, snapshot } from './helpers.js';

// Chantier 31 (D172, D176, D177, D181) : Machines › Ton cockpit, le mode host sur le Mac.
// Données synthétiques seulement : `mac.exemple.ts.net`, `julien@exemple`.

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement | null;
const NOM = 'mac.exemple.ts.net';
const COMMANDE = 'tailscale serve --bg --https=443 http://127.0.0.1:4890';

const etat = (over: Partial<EtatModeHostDaemon> = {}): EtatModeHostDaemon => ({
  actif: true,
  push: false,
  code: false,
  abonnements: 0,
  port: 4890,
  tailnet: { etat: 'running', nom: NOM, compte: 'julien@exemple' },
  serve: { etat: 'ok', funnel: false, interdits: [] },
  commande: COMMANDE,
  disponible: true,
  raison: null,
  ...over,
});

const FUTUR = new Date(Date.now() + 5 * 60_000).toISOString();
const appareil = (over: Partial<Appareil> = {}): Appareil => ({
  id: 'ap_1',
  nom: 'iPhone',
  identite: 'julien@exemple',
  creeA: new Date().toISOString(),
  dernierContact: null,
  expireA: new Date(Date.now() + 8 * 3600_000).toISOString(),
  revoqueA: null,
  etat: 'actif',
  ...over,
});

const demande = (over: Partial<VueDemande> = {}): VueDemande => ({
  id: 'dm_1',
  etat: 'attente',
  expireA: FUTUR,
  codeCourt: null,
  nom: null,
  identite: null,
  raison: null,
  ...over,
});

const CODE = {
  demandeId: 'dm_1',
  code: 'code-synthetique',
  expireA: FUTUR,
  url: `https://${NOM}/appairer#code-synthetique`,
};

const ouvrir = (routes: Record<string, (body: unknown) => Response> = {}) =>
  setup(<Cockpit />, snapshot({}), '/machines', {
    'GET /api/host': json(200, etat()),
    'GET /api/host/appareils': json(200, []),
    'GET /api/host/appairage': json(200, { demande: null, identiteVerifiable: false }),
    ...routes,
  });

test('D172 : la pilule suit l’état lu, Funnel et port interdit d’abord', () => {
  expect(pilule(null).texte).toBe('Mode host inactif');
  expect(pilule(etat({ actif: false })).texte).toBe('Mode host inactif');
  expect(pilule(etat())).toEqual({ texte: 'Mode host actif', ton: 'ok' });
  expect(pilule(etat({ serve: { etat: 'absent', funnel: false, interdits: [] } })).texte).toBe(
    'Serve absent',
  );
  expect(pilule(etat({ serve: { etat: 'ok', funnel: true, interdits: [] } })).ton).toBe('erreur');
  expect(pilule(etat({ serve: { etat: 'ok', funnel: false, interdits: [4870] } })).texte).toBe(
    'Serve expose un port interdit',
  );
  expect(pilule(etat({ disponible: false, raison: 'le port 4890 est occupé' })).ton).toBe(
    'attente',
  );
});

test('D172 : inactif, l’interrupteur active par PUT /api/host, sans rien lire d’autre avant', async () => {
  const h = ouvrir({
    'GET /api/host': json(200, etat({ actif: false })),
    'PUT /api/host': json(200, etat()),
  });
  await waitFor(() => expect(node('host.interrupteur')?.textContent).toBe('Activer le mode host'));
  expect(h.calls.some((c) => c.url.startsWith('/api/host/'))).toBe(false);
  expect(node('host.ajouter')).toBeNull();
  fireEvent.click(node('host.interrupteur')!);
  await waitFor(() => expect(node('machines.cockpit.mode')?.textContent).toBe('Mode host actif'));
  expect(h.calls.find((c) => c.method === 'PUT')).toMatchObject({
    url: '/api/host',
    body: { actif: true },
  });
  expect(node('machines.cockpit.phrase')?.textContent).toContain(NOM);
  expect(node('host.interrupteur')?.textContent).toBe('Éteindre le mode host');
  expect(node('host.ajouter')).not.toBeNull();
});

test('D172 : un refus du daemon (409) s’affiche, l’état ne change pas', async () => {
  ouvrir({
    'GET /api/host': json(200, etat({ actif: false })),
    'PUT /api/host': json(409, { error: 'modeHost doit être un objet' }),
  });
  await waitFor(() => expect(node('host.interrupteur')).not.toBeNull());
  fireEvent.click(node('host.interrupteur')!);
  await waitFor(() => expect(node('host.erreur')?.textContent).toBe('modeHost doit être un objet'));
  expect(node('machines.cockpit.mode')?.textContent).toBe('Mode host inactif');
});

test('D37 : Serve absent, la commande à copier, que l’écran ne lance pas', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  ouvrir({
    'GET /api/host': json(200, etat({ serve: { etat: 'absent', funnel: false, interdits: [] } })),
  });
  await waitFor(() => expect(node('host.commande.texte')?.textContent).toBe(COMMANDE));
  expect(node('machines.cockpit.mode')?.textContent).toBe('Serve absent');
  fireEvent.click(node('host.commande.copier')!);
  await waitFor(() => expect(node('host.commande.copier')?.textContent).toBe('Copiée'));
  expect(writeText).toHaveBeenCalledWith(COMMANDE);
});

test('D171 : le port des appareils indisponible, sa raison, et pas d’ajout possible', async () => {
  ouvrir({
    'GET /api/host': json(200, etat({ disponible: false, raison: 'le port 4890 est occupé' })),
  });
  await waitFor(() => expect(node('host.raison')?.textContent).toBe('le port 4890 est occupé'));
  expect((node('host.ajouter') as HTMLButtonElement).disabled).toBe(true);
});

test('D181 : Ajouter un appareil, le QR en SVG local, le temps restant, Nouveau code', async () => {
  const h = ouvrir({
    'POST /api/host/appairages': json(200, CODE),
    'GET /api/host/appairage': json(200, { demande: demande(), identiteVerifiable: false }),
  });
  await waitFor(() => expect(node('host.ajouter')).not.toBeNull());
  fireEvent.click(node('host.ajouter')!);
  await waitFor(() => expect(node('host.qr')).not.toBeNull());
  const svg = node('host.qr')!;
  expect(svg.tagName.toLowerCase()).toBe('svg');
  expect(svg.querySelector('path')?.getAttribute('d')).toBe(cheminQr(CODE.url).d);
  // aucune image ni ressource externe : le QR est dessiné ici
  expect(svg.querySelector('image, use, foreignObject')).toBeNull();
  expect(node('host.qr.restant')?.textContent).toMatch(/^Expire dans [45]:\d\d$/);
  expect(node('host.ajouter')).toBeNull();
  fireEvent.click(node('host.nouveau-code')!);
  await waitFor(() =>
    expect(
      h.calls.filter((c) => c.method === 'POST' && c.url === '/api/host/appairages'),
    ).toHaveLength(2),
  );
});

test('D181 : le chemin du QR dépend de l’URL entière, avec sa marge', () => {
  const a = cheminQr(CODE.url);
  const b = cheminQr(`${CODE.url}x`);
  expect(a.d).not.toBe(b.d);
  expect(a.d).toMatch(/^(M\d+ \d+h1v1h-1z)+$/);
  // marge de 4 modules autour d'un QR d'au moins 21 modules
  expect(a.taille).toBeGreaterThanOrEqual(29);
});

test('D176 : la réclamation arrive par relecture, avec code court, nom, identité non vérifiable', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  let vue = demande();
  const h = ouvrir({
    'POST /api/host/appairages': json(200, CODE),
    'GET /api/host/appairage': () => json(200, { demande: vue, identiteVerifiable: false })(),
    'POST /api/host/appairages/dm_1/approuver': json(200, { ok: true }),
  });
  await waitFor(() => expect(node('host.ajouter')).not.toBeNull());
  fireEvent.click(node('host.ajouter')!);
  await waitFor(() => expect(node('host.qr')).not.toBeNull());
  vue = demande({ etat: 'reclamee', codeCourt: '4821', nom: 'iPhone', identite: 'julien@exemple' });
  await act(async () => {
    vi.advanceTimersByTime(RELECTURE_DEMANDE_MS);
  });
  await waitFor(() => expect(node('host.demande.code-court')?.textContent).toBe('4821'));
  expect(node('host.demande.avertissement')?.textContent).toBe(
    'Si tu n’as pas lancé cette connexion, refuse.',
  );
  expect(node('host.demande.nom')?.textContent).toBe('iPhone');
  expect(node('host.demande.identite')?.textContent).toBe('julien@exemple (non vérifiable)');
  expect(node('host.demande.sans-identite')).toBeNull();
  fireEvent.click(node('host.demande.approuver')!);
  await waitFor(() =>
    expect(h.calls.find((c) => c.url === '/api/host/appairages/dm_1/approuver')?.body).toEqual({}),
  );
});

test('D179 : sans identité, Approuver attend la case « Appareil taggé », envoyée telle quelle', async () => {
  const h = ouvrir({
    'POST /api/host/appairages': json(200, CODE),
    'GET /api/host/appairage': json(200, {
      demande: demande({ etat: 'reclamee', codeCourt: '4821', nom: 'serveur', identite: null }),
      identiteVerifiable: false,
    }),
    'POST /api/host/appairages/dm_1/approuver': json(200, { ok: true }),
  });
  await waitFor(() => expect(node('host.ajouter')).not.toBeNull());
  fireEvent.click(node('host.ajouter')!);
  await waitFor(() => expect(node('host.demande.identite')?.textContent).toBe('Aucune'));
  const approuver = node('host.demande.approuver') as HTMLButtonElement;
  expect(approuver.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/Appareil taggé/));
  expect(approuver.disabled).toBe(false);
  fireEvent.click(approuver);
  await waitFor(() =>
    expect(h.calls.find((c) => c.url === '/api/host/appairages/dm_1/approuver')?.body).toEqual({
      sansIdentite: true,
    }),
  );
});

test('D176 : Refuser, puis la fin de la demande, et deux réclamations annulent', async () => {
  let vue = demande({ etat: 'reclamee', codeCourt: '4821', nom: 'x', identite: 'julien@exemple' });
  const h = ouvrir({
    'POST /api/host/appairages': json(200, CODE),
    'GET /api/host/appairage': () => json(200, { demande: vue, identiteVerifiable: false })(),
    'POST /api/host/appairages/dm_1/refuser': () => {
      vue = demande({ etat: 'annulee', raison: 'refusee' });
      return json(200, { ok: true })();
    },
  });
  await waitFor(() => expect(node('host.ajouter')).not.toBeNull());
  fireEvent.click(node('host.ajouter')!);
  await waitFor(() => expect(node('host.demande.refuser')).not.toBeNull());
  fireEvent.click(node('host.demande.refuser')!);
  await waitFor(() => expect(node('host.demande.fin')?.textContent).toBe('Demande refusée.'));
  expect(h.calls.some((c) => c.url === '/api/host/appairages/dm_1/refuser')).toBe(true);
  expect(node('host.nouveau-code')).not.toBeNull();
});

test('D176 : deux réclamations, le message dit pourquoi', async () => {
  ouvrir({
    'POST /api/host/appairages': json(200, CODE),
    'GET /api/host/appairage': json(200, {
      demande: demande({ etat: 'annulee', raison: 'deux-reclamations' }),
      identiteVerifiable: false,
    }),
  });
  await waitFor(() => expect(node('host.ajouter')).not.toBeNull());
  fireEvent.click(node('host.ajouter')!);
  await waitFor(() =>
    expect(node('host.demande.fin')?.textContent).toBe(
      'Deux appareils ont essayé ce code : demande annulée.',
    ),
  );
});

test('D176 : consommée, l’appareil apparaît dans la liste, et Fermer retire le QR', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  let vue = demande({ etat: 'approuvee' });
  let liste: Appareil[] = [];
  ouvrir({
    'POST /api/host/appairages': json(200, CODE),
    'GET /api/host/appairage': () => json(200, { demande: vue, identiteVerifiable: false })(),
    'GET /api/host/appareils': () => json(200, liste)(),
  });
  await waitFor(() => expect(node('host.ajouter')).not.toBeNull());
  fireEvent.click(node('host.ajouter')!);
  await waitFor(() => expect(node('host.demande.fin')?.textContent).toContain('Approuvé'));
  vue = demande({ etat: 'consommee' });
  liste = [appareil()];
  await act(async () => {
    vi.advanceTimersByTime(RELECTURE_DEMANDE_MS);
  });
  await waitFor(() => expect(node('host.appareil.ap_1')).not.toBeNull());
  expect(node('host.demande.fin')?.textContent).toBe('Appareil ajouté. L’accès dure 8 heures.');
  fireEvent.click(node('host.fermer')!);
  expect(node('host.qr-zone')).toBeNull();
  expect(node('host.demande')).toBeNull();
  expect(node('host.ajouter')).not.toBeNull();
});

test('D176 : aucune relecture tant qu’aucun QR n’est affiché', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const h = ouvrir();
  await waitFor(() => expect(node('host.ajouter')).not.toBeNull());
  const avant = h.calls.filter((c) => c.url === '/api/host/appairage').length;
  await act(async () => {
    vi.advanceTimersByTime(RELECTURE_DEMANDE_MS * 5);
  });
  expect(h.calls.filter((c) => c.url === '/api/host/appairage').length).toBe(avant);
});

test('D177 : la liste, Révoquer un appareil, Couper tous les accès', async () => {
  let liste: Appareil[] = [
    appareil(),
    appareil({ id: 'ap_2', nom: 'iPad', identite: null, dernierContact: new Date().toISOString() }),
    appareil({ id: 'ap_3', nom: 'ancien', etat: 'revoque', revoqueA: new Date().toISOString() }),
  ];
  const h = ouvrir({
    'GET /api/host/appareils': () => json(200, liste)(),
    'DELETE /api/host/appareils/ap_1': () => {
      liste = liste.map((a) => (a.id === 'ap_1' ? { ...a, etat: 'revoque' as const } : a));
      return json(200, { ok: true })();
    },
    'POST /api/host/couper': () => {
      liste = liste.map((a) => ({ ...a, etat: 'revoque' as const }));
      return json(200, { coupes: 1 })();
    },
  });
  await waitFor(() => expect(node('host.appareil.ap_1')).not.toBeNull());
  expect(node('host.appareil.ap_1')?.textContent).toContain('julien@exemple');
  expect(node('host.appareil.ap_1')?.textContent).toContain('jamais vu');
  expect(node('host.appareil.ap_2')?.textContent).toContain('sans identité Tailscale');
  expect(node('host.appareil.ap_2')?.textContent).toContain("vu à l'instant");
  expect(node('host.appareil.ap_3')?.textContent).toContain('Coupé');
  expect(node('host.appareil.ap_3.revoquer')).toBeNull();
  fireEvent.click(node('host.appareil.ap_1.revoquer')!);
  await waitFor(() => expect(node('host.appareil.ap_1.revoquer')).toBeNull());
  expect(h.calls.some((c) => c.method === 'DELETE' && c.url === '/api/host/appareils/ap_1')).toBe(
    true,
  );
  fireEvent.click(node('host.couper')!);
  await waitFor(() => expect(node('host.couper')).toBeNull());
  expect(h.calls.some((c) => c.method === 'POST' && c.url === '/api/host/couper')).toBe(true);
  expect(node('host.appareil.ap_2')?.textContent).toContain('Coupé');
});

test('D172 : Éteindre retire le QR et les actions, et garde la liste lue', async () => {
  const h = ouvrir({
    'POST /api/host/appairages': json(200, CODE),
    'GET /api/host/appairage': json(200, { demande: demande(), identiteVerifiable: false }),
    'PUT /api/host': json(200, etat({ actif: false })),
  });
  await waitFor(() => expect(node('host.ajouter')).not.toBeNull());
  fireEvent.click(node('host.ajouter')!);
  await waitFor(() => expect(node('host.qr')).not.toBeNull());
  fireEvent.click(node('host.interrupteur')!);
  await waitFor(() => expect(node('machines.cockpit.mode')?.textContent).toBe('Mode host inactif'));
  expect(h.calls.find((c) => c.method === 'PUT')?.body).toEqual({ actif: false });
  expect(node('host.qr')).toBeNull();
  expect(node('host.ajouter')).toBeNull();
});

test('32b.6 : le réglage push appelle PUT et confirme la suppression', async () => {
  const h = ouvrir({
    'PUT /api/host/push': (body) => json(200, etat({ push: (body as { actif: boolean }).actif }))(),
    'GET /api/host/appareils': json(200, [{ ...appareil(), push: true }]),
  });
  const interrupteur = await screen.findByRole('switch', {
    name: 'Notifications push sur les téléphones',
  });
  await screen.findByText('Notifications');
  expect((interrupteur as HTMLInputElement).checked).toBe(false);
  fireEvent.click(interrupteur);
  await waitFor(() => expect((interrupteur as HTMLInputElement).checked).toBe(true));
  expect(h.calls.find((c) => c.url === '/api/host/push')?.body).toEqual({ actif: true });
  const confirmation = vi.spyOn(window, 'confirm').mockReturnValue(false);
  fireEvent.click(interrupteur);
  expect(confirmation).toHaveBeenCalledWith(
    expect.stringContaining('Tous les abonnements seront effacés'),
  );
  expect(h.calls.filter((c) => c.url === '/api/host/push')).toHaveLength(1);
  confirmation.mockReturnValue(true);
  fireEvent.click(interrupteur);
  await waitFor(() => expect((interrupteur as HTMLInputElement).checked).toBe(false));
  expect(h.calls.filter((c) => c.url === '/api/host/push')[1]?.body).toEqual({ actif: false });
  confirmation.mockRestore();
});

test('D205 : le code est coupé par défaut, le Mac peut le montrer puis le couper', async () => {
  let code = false;
  const h = ouvrir({
    'PUT /api/host/code': (body) => {
      code = (body as { actif: boolean }).actif;
      return json(200, etat({ code }))();
    },
  });
  const interrupteur = await screen.findByRole('switch', { name: 'Montrer le code aux appareils' });
  expect((interrupteur as HTMLInputElement).checked).toBe(false);
  expect(screen.getByText(/Les téléphones appairés pourront lire le diff/).textContent).toContain(
    "Les téléphones appairés pourront lire le diff des fichiers d'une livraison, filtré. Les fichiers sensibles restent sur le Mac.",
  );
  fireEvent.click(interrupteur);
  await waitFor(() => expect((interrupteur as HTMLInputElement).checked).toBe(true));
  expect(h.calls.find((c) => c.url === '/api/host/code')?.body).toEqual({ actif: true });
  fireEvent.click(interrupteur);
  await waitFor(() => expect((interrupteur as HTMLInputElement).checked).toBe(false));
});

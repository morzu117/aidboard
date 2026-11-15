// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { SectionMeshes } from '../../web/src/ui/SectionMeshes.js';
import { FakeSocket, json, setup, snapshot } from './helpers.js';

const chemin = '/api/meshes/rejoindre';
const contexte = {
  gateway: "https://aid-e2e.ts.net/l'idee",
  cell: "peer-a'b",
  mesh: 'essai',
  cheminJeton: "/var/aid/peer-a'b.peer_token",
};
// Attendus littéraux indépendants du code de la vue.
const questions = [
  'How will you handle routine AI-to-AI peer DMs, and stop at privilege boundaries?',
  'How will you keep your canonical name and flag a DM addressed to the wrong identity?',
  'How will you disclose mistakes and assumptions to the peers affected?',
  'What counts as a mesh secret, and how will you keep it out of mesh messages?',
];
const approbation = `swarph mesh approve 'ABCD-EFGH' --gateway 'https://aid-e2e.ts.net/l'"'"'idee'`;
const copie = vi.fn().mockResolvedValue(undefined);
function ouvrir(etat: object = { etat: 'aucune' }, routes = {}) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: copie },
  });
  return setup(<SectionMeshes />, snapshot(), '/machines', {
    'GET /api/meshes': json(200, [
      { nom: 'principal', cell: 'peer-a', gateway: 'https://aid-e2e.ts.net', jeton: true },
      { nom: 'autre', cell: 'peer-b', gateway: 'https://example.com', jeton: false },
    ]),
    [`GET ${chemin}`]: json(200, { ...contexte, ...etat }),
    ...routes,
  });
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  copie.mockClear();
});
async function joindre() {
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  act(() => FakeSocket.all[0]!.open());
}
async function copier(nom: string, texte: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Copier ${nom}` }));
  await waitFor(() => expect(copie).toHaveBeenLastCalledWith(texte));
}
function remplir() {
  fireEvent.click(screen.getByRole('button', { name: 'Rejoindre un mesh' }));
  fireEvent.change(screen.getByLabelText('Adresse du gateway'), {
    target: { value: contexte.gateway },
  });
  fireEvent.change(screen.getByLabelText('Nom de la nouvelle cell'), {
    target: { value: contexte.cell },
  });
  fireEvent.change(screen.getByLabelText('Nom local du mesh'), {
    target: { value: contexte.mesh },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Rejoindre' }));
}

test('liste, jeton présent/absent, principal sans Oublier et message de la route', async () => {
  const message = 'Le jeton existe toujours. Pour le révoquer, demande à l’opérateur du gateway.';
  const h = ouvrir(undefined, { 'DELETE /api/meshes/config/autre': json(200, { message }) });
  await joindre();
  const principal = (await screen.findByText(/principal · peer-a/)).closest('li')!;
  expect(principal.textContent).toContain('https://aid-e2e.ts.net · jeton présent');
  expect(within(principal).queryByRole('button', { name: 'Oublier' })).toBeNull();
  expect(screen.getByText(/autre · peer-b/).textContent).toContain(
    'https://example.com · jeton absent',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Oublier' }));
  expect(await screen.findByText(message)).toBeTruthy();
  expect(h.calls.some((c) => c.method === 'DELETE' && c.url === '/api/meshes/config/autre')).toBe(
    true,
  );
  expect(document.querySelector('[data-node="machines.meshes"]')).toBeTruthy();
});

test.each([400, 409])('formulaire : erreur %s telle quelle, en texte brut', async (statut) => {
  const erreur = '<img src=x onerror=alert(1)> demande refusée';
  const h = ouvrir(undefined, { [`POST ${chemin}`]: json(statut, { error: erreur }) });
  await joindre();
  await screen.findByText(/principal · peer-a/);
  remplir();
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', erreur);
  expect(document.querySelector('img')).toBeNull();
  expect(h.calls.find((c) => c.method === 'POST')?.body).toEqual({
    gateway: contexte.gateway,
    cell: contexte.cell,
    mesh: contexte.mesh,
  });
});

test('formulaire : lancement puis attente, annulation et commande de refus', async () => {
  const h = ouvrir(undefined, {
    [`POST ${chemin}`]: json(200, {
      ...contexte,
      etat: 'en-attente',
      code: 'ABCD-EFGH',
      expiration: Date.now() + 900000,
    }),
    [`DELETE ${chemin}`]: json(200, { ...contexte, etat: 'annule', code: 'ABCD-EFGH' }),
  });
  await joindre();
  await screen.findByText(/principal · peer-a/);
  remplir();
  expect(await screen.findByText('ABCD-EFGH')).toBeTruthy();
  expect(screen.getByText(/Expiration dans/).textContent).toMatch(/1[45]:\d\d/);
  await copier(
    'la commande d’approbation',
    `${approbation} --witness <TÉMOIN> --token-file <JETON-OPÉRATEUR>`,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
  expect(
    await screen.findByText("Demande annulée : demande à l'opérateur de refuser le code ABCD-EFGH"),
  ).toBeTruthy();
  await copier('la commande de refus', `${approbation} --refuse --token-file <JETON-OPÉRATEUR>`);
  expect(h.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
});

test.each([undefined, 'peer-b'])(
  'approuve : questions, modèle exact et commande status, témoin %s',
  async (temoin) => {
    ouvrir({ etat: 'approuve', temoin });
    expect(
      await screen.findByText(
        "Cell inscrite, pas encore ratifiée : la boîte marche, le board reste vide jusqu'à la ratification",
      ),
    ).toBeTruthy();
    // Les questions apparaissent comme texte, dans leur ordre d'origine.
    expect(Array.from(document.querySelectorAll('ol li')).map((li) => li.textContent)).toEqual(
      questions,
    );
    await copier(
      'le modèle de réponses',
      `Handshake for peer-a'b\n${questions.map((q) => `${q}\n<ta réponse, avec tes propres mots>`).join('\n')}`,
    );
    await copier(
      'la commande d’envoi',
      `swarph mesh send ${temoin ? "'peer-b'" : '<TÉMOIN>'} --kind status --content-file <réponses> --as 'peer-a'"'"'b' --gateway 'https://aid-e2e.ts.net/l'"'"'idee' --token-file '/var/aid/peer-a'"'"'b.peer_token'`,
    );
    expect(screen.getByText('Redémarre le daemon pour activer ce mesh.')).toBeTruthy();
    expect(copie).toHaveBeenCalledTimes(2);
  },
);

test('approuve : libellé de config non écrite remplace le redémarrage, texte brut', async () => {
  ouvrir({ etat: 'approuve', libelle: '<b>Configuration non écrite</b>' });
  expect(await screen.findByText('<b>Configuration non écrite</b>')).toBeTruthy();
  expect(screen.queryByText('Redémarre le daemon pour activer ce mesh.')).toBeNull();
  expect(document.querySelector('b')).toBeNull();
});

test.each([
  ['demande', 'Demande en cours…'],
  ['a-voir', "Le jeton a peut-être été retiré : vois avec l'opérateur du gateway."],
  ['refuse', 'Demande refusée par l’opérateur du gateway.'],
  ['expire', 'La demande a expiré.'],
  ['echec', 'Échec : <script>échec</script>'],
])('état %s et libellé en texte brut', async (etat, message) => {
  ouvrir({ etat, libelle: '<script>échec</script>' });
  expect(await screen.findByText(message)).toBeTruthy();
  expect(document.querySelector('script')).toBeNull();
  if (etat === 'a-voir') expect(screen.queryByRole('button', { name: /Rejoindre/ })).toBeNull();
});

test('relecture toutes les 2 s pendant demande/en-attente, arrêt sur état final et au démontage', async () => {
  vi.useFakeTimers();
  const h = ouvrir({ etat: 'demande' });
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(screen.getByText('Demande en cours…')).toBeTruthy();
  const lectures = () => h.calls.filter((c) => c.method === 'GET' && c.url === chemin).length;
  expect(lectures()).toBe(1);
  h.respond.set(
    `GET ${chemin}`,
    json(200, {
      ...contexte,
      etat: 'en-attente',
      code: 'ABCD-EFGH',
      expiration: Date.now() + 900000,
    }),
  );
  await act(() => vi.advanceTimersByTimeAsync(1999));
  expect(lectures()).toBe(1);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(lectures()).toBe(2);
  h.respond.set(`GET ${chemin}`, json(200, { ...contexte, etat: 'expire' }));
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(lectures()).toBe(3);
  await act(() => vi.advanceTimersByTimeAsync(10000));
  expect(lectures()).toBe(3);
  cleanup();
  await act(() => vi.advanceTimersByTimeAsync(10000));
  expect(lectures()).toBe(3);
});

test('démonter pendant l’attente arrête la relecture et le compte à rebours', async () => {
  vi.useFakeTimers();
  const h = ouvrir({ etat: 'en-attente', code: 'ABCD-EFGH', expiration: Date.now() + 900000 });
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(screen.getByText('ABCD-EFGH')).toBeTruthy();
  cleanup();
  const nombre = h.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(10000));
  expect(h.calls).toHaveLength(nombre);
});

test.each(['aucune', 'approuve', 'refuse', 'expire', 'annule', 'a-voir', 'echec'])(
  'état %s retrouvé au montage : une lecture, puis aucun sondage',
  async (etat) => {
    vi.useFakeTimers();
    const h = ouvrir({ etat, code: 'ABCD-EFGH', libelle: 'échec' });
    await act(() => vi.advanceTimersByTimeAsync(0));
    const lectures = () => h.calls.filter((c) => c.method === 'GET' && c.url === chemin).length;
    expect(lectures()).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(lectures()).toBe(1);
  },
);

test.each(['interrompue', 'a-voir'])(
  '33.3bis : identité de la demande après redémarrage (%s)',
  async (etat) => {
    ouvrir({ etat, cell: 'peer-c', mesh: 'essai-reprise' });
    expect(await screen.findByText('Cell : peer-c · Mesh : essai-reprise')).toBeTruthy();
    if (etat === 'interrompue') {
      expect(
        screen.getByText("Le daemon a redémarré pendant la demande ; rien n'a été inscrit."),
      ).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Rejoindre un mesh' })).toBeTruthy();
    }
  },
);

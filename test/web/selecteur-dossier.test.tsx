// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';
import { Accueil } from '../../web/src/ecrans/Accueil.js';
import { json, listing, setup, snapshot, ws } from './helpers.js';

afterEach(cleanup);

type H = ReturnType<typeof setup>;
const fsCalls = (h: H) =>
  h.calls.filter((c) => c.url.startsWith('/api/fs/dirs')).map((c) => decodeURIComponent(c.url));
const reponse =
  (l = listing()) =>
  () =>
    new Response(JSON.stringify(l), { status: 200 });

async function ouvrir(h: H) {
  await userEvent.click(await screen.findByRole('button', { name: 'Nouveau sujet' }));
  await screen.findByRole('group', { name: 'Choisir le dossier du dépôt' });
  return h;
}

test('le chemin se choisit dans la liste ; seuls les dépôts ont un bouton « Choisir »', async () => {
  await ouvrir(setup(<Accueil />, snapshot()));
  expect(screen.queryByLabelText(/Chemin du dépôt/)).toBeNull();
  // un <form> dans un <form> est supprimé par le navigateur : Entrée enregistrerait le dépôt (jsdom ne le détecte pas)
  expect(document.querySelector('form form')).toBeNull();
  expect(await screen.findByText('mon-depot')).toBeTruthy();
  expect(screen.getByText('dépôt git')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Choisir docs' })).toBeNull();
});

test('Enregistrer reste inactif tant qu’aucun dossier n’est choisi', async () => {
  await ouvrir(setup(<Accueil />, snapshot()));
  const enregistrer = screen.getByRole('button', { name: 'Enregistrer' }) as HTMLButtonElement;
  expect(enregistrer.disabled).toBe(true);
  await userEvent.click(await screen.findByRole('button', { name: 'Choisir mon-depot' }));
  expect(enregistrer.disabled).toBe(false);
  expect(screen.getByText('Dépôt choisi : /home/moi/mon-depot')).toBeTruthy();
});

test('entrer dans un dossier, remonter, revenir au dossier personnel', async () => {
  const h = await ouvrir(setup(<Accueil />, snapshot()));
  h.respond.set(
    'GET /api/fs/dirs',
    reponse(listing({ path: '/home/moi/docs', parent: '/home/moi', entries: [] })),
  );
  await userEvent.click(await screen.findByRole('button', { name: /docs/ }));
  expect(await screen.findByText('Aucun sous-dossier.')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: /Dossier parent/ }));
  await userEvent.click(screen.getByRole('button', { name: /Dossier personnel/ }));
  expect(fsCalls(h).slice(-2)).toEqual([
    '/api/fs/dirs?path=/home/moi',
    '/api/fs/dirs?path=/home/moi',
  ]);
  expect(fsCalls(h)).toContain('/api/fs/dirs?path=/home/moi/docs');
});

test('choisir le dossier courant, même sans dépôt, laisse le daemon trancher', async () => {
  const h = setup(<Accueil />, snapshot());
  h.respond.set('POST /api/workspaces', json(422, { error: "/home/moi n'est pas un dépôt git" }));
  await ouvrir(h);
  await userEvent.click(screen.getByRole('button', { name: 'Choisir ce dossier' }));
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
  expect((await screen.findByRole('alert')).textContent).toBe("/home/moi n'est pas un dépôt git");
  expect(h.calls.find((c) => c.url === '/api/workspaces')?.body).toEqual({ path: '/home/moi' });
});

test('« Aller au dossier » navigue sans soumettre le formulaire d’enregistrement', async () => {
  const h = await ouvrir(setup(<Accueil />, snapshot()));
  const champ = await screen.findByLabelText('Aller au dossier');
  await userEvent.clear(champ);
  await userEvent.type(champ, '/srv/code{Enter}');
  await waitFor(() => expect(fsCalls(h).at(-1)).toBe('/api/fs/dirs?path=/srv/code'));
  expect(h.calls.some((c) => c.url === '/api/workspaces')).toBe(false);
});

test('les dossiers cachés se demandent par la case à cocher', async () => {
  const h = await ouvrir(setup(<Accueil />, snapshot()));
  await userEvent.click(await screen.findByLabelText('Afficher les dossiers cachés'));
  await waitFor(() => expect(fsCalls(h).at(-1)).toBe('/api/fs/dirs?path=/home/moi&hidden=true'));
});

test('une erreur du daemon sur la navigation est affichée', async () => {
  const h = await ouvrir(setup(<Accueil />, snapshot()));
  h.respond.set('GET /api/fs/dirs', json(404, { error: '/nulle/part est introuvable' }));
  await userEvent.type(await screen.findByLabelText('Aller au dossier'), '/x{Enter}');
  expect((await screen.findByRole('alert')).textContent).toBe('/nulle/part est introuvable');
});

test('le premier affichage part du dossier qui contient le dernier dépôt enregistré', async () => {
  const h = setup(<Accueil />, snapshot({ workspaces: [ws({ root: '/home/moi/Projects/a' })] }));
  await userEvent.click(await screen.findByRole('button', { name: 'Nouveau sujet' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Ajouter un workspace…' }));
  await screen.findByRole('group', { name: 'Choisir le dossier du dépôt' });
  expect(fsCalls(h)[0]).toBe('/api/fs/dirs?path=/home/moi/Projects');
});

test('une réponse arrivée en retard n’écrase pas le dossier demandé depuis', async () => {
  const h = setup(<Accueil />, snapshot());
  let release!: () => void;
  const first = new Promise<void>((r) => (release = r));
  let n = 0;
  h.respond.set('GET /api/fs/dirs', () => {
    const lent = n++ === 0;
    const body = lent ? listing() : listing({ path: '/srv/code', entries: [] });
    return (lent ? first.then(() => body) : Promise.resolve(body)).then(
      (b) => new Response(JSON.stringify(b), { status: 200 }),
    ) as unknown as Response;
  });
  await userEvent.click(await screen.findByRole('button', { name: 'Nouveau sujet' }));
  const champ = await screen.findByLabelText('Aller au dossier');
  await userEvent.type(champ, '/srv/code{Enter}');
  await waitFor(() => expect((champ as HTMLInputElement).value).toBe('/srv/code'));
  release();
  await new Promise((r) => setTimeout(r, 30));
  expect((champ as HTMLInputElement).value).toBe('/srv/code');
  expect(screen.queryByText('mon-depot')).toBeNull();
});

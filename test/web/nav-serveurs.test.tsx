// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, expect, test } from 'vitest';
import type { Server, ServerStatus } from '../../src/shared/model.js';
import { LayoutCtx } from '../../web/src/ui/Layout.js';
import { Nav, resetNavCacheForTests } from '../../web/src/ui/Nav.js';
import { resetNavServeursForTests } from '../../web/src/ui/NavServeurs.js';
import { FakeSocket, json, setup, snapshot } from './helpers.js';

afterEach(() => {
  cleanup();
  resetNavCacheForTests();
  resetNavServeursForTests();
});

const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement | null;
const n = (rest: string) => `1-1.barre-gauche.${rest}`;

const serveur = (over: Partial<Server> = {}): Server => ({
  id: 'srv_1',
  name: 'vps-ovh',
  mode: 'ssh_alias',
  target: 'vps',
  sshOptions: null,
  loadProfile: true,
  workdir: '~',
  shell: 'bash',
  keepSession: true,
  permissionMode: 'default',
  confirmDestructive: true,
  allowedDirs: ['~'],
  groupName: 'Serveurs',
  color: '#a78bfa',
  detectedAgents: ['claude'],
  lastTestAt: null,
  rules: [],
  createdAt: 't',
  updatedAt: 't',
  ...over,
});

const statut = (over: Partial<ServerStatus> = {}): ServerStatus => ({
  serverId: 'srv_1',
  state: 'connected',
  latencyMs: 12,
  checkedAt: 't',
  reason: null,
  ...over,
});

const open = (servers: Server[] | object, statuses: ServerStatus[] = [], route = '/') =>
  setup(
    <LayoutCtx.Provider
      value={{
        openNewTopic: () => {},
        openNewWorkspace: () => {},
        overlay: 'aucun',
        setOverlay: () => {},
      }}
    >
      <Routes>
        <Route path="*" element={<Nav screen="1-1" />} />
      </Routes>
    </LayoutCtx.Provider>,
    snapshot(),
    route,
    {
      'GET /api/nav': json(200, { groups: [], placements: [], prefs: { reduit: false } }),
      'GET /api/servers': json(200, servers),
      'GET /api/servers/status': json(200, statuses),
    },
  );

test('section Serveurs toujours présente : « Aucun serveur », lien vers la liste, + vers l’ajout', async () => {
  open([]);
  await waitFor(() => expect(node(n('serveurs.vide'))?.textContent).toBe('Aucun serveur'));
  expect(screen.getByRole('link', { name: 'Serveurs' }).getAttribute('href')).toBe('/serveurs');
  expect(screen.getByRole('link', { name: 'Ajouter un serveur' }).getAttribute('href')).toBe(
    '/serveurs/nouveau',
  );
});

test('une réponse inattendue du daemon n’empêche pas la barre de s’afficher', async () => {
  open({});
  await waitFor(() => expect(node(n('serveurs.vide'))).not.toBeNull());
  // sous les groupes de sujets, pas dedans
  expect(node(n('groupes'))?.contains(node(n('serveurs')))).toBe(false);
  expect(
    node(n('groupes'))!.compareDocumentPosition(node(n('serveurs'))!) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test('groupe sans nom rangé sous « Serveurs » ; liste illisible signalée', async () => {
  open([serveur({ groupName: '  ' })]);
  await waitFor(() => expect(node(n('serveurs.groupe-Serveurs'))).not.toBeNull());
  expect(node(n('serveurs.groupe-Serveurs'))?.textContent).toContain('Serveurs');
  cleanup();
  setup(
    <LayoutCtx.Provider
      value={{
        openNewTopic: () => {},
        openNewWorkspace: () => {},
        overlay: 'aucun',
        setOverlay: () => {},
      }}
    >
      <Nav screen="1-1" />
    </LayoutCtx.Provider>,
    snapshot(),
    '/',
    {
      'GET /api/nav': json(200, { groups: [], placements: [], prefs: { reduit: false } }),
      'GET /api/servers': json(500, { error: 'base verrouillée' }),
      'GET /api/servers/status': json(200, []),
    },
  );
  await waitFor(() =>
    expect(node(n('serveurs.erreur'))?.textContent).toBe('Serveurs indisponibles'),
  );
});

test('une ligne par serveur, groupée par groupName dans l’ordre de création : icône, nom, latence', async () => {
  open(
    [
      serveur(),
      serveur({ id: 'srv_2', name: 'build', groupName: 'Clients', color: '#f59e6b' }),
      serveur({ id: 'srv_3', name: 'preprod' }),
    ],
    [
      statut(),
      statut({ serverId: 'srv_2', state: 'unreachable', latencyMs: null, reason: 'délai dépassé' }),
    ],
  );
  await waitFor(() => expect(node(n('serveur-srv_1'))).not.toBeNull());
  const groupes = [...document.querySelectorAll(`[data-node^="${n('serveurs.groupe-')}"]`)]
    .map((el) => el.getAttribute('data-node'))
    .filter((id) => !id!.endsWith('.bascule'));
  expect(groupes).toEqual([n('serveurs.groupe-Serveurs'), n('serveurs.groupe-Clients')]);
  expect(node(n('serveurs.groupe-Serveurs'))?.textContent).toContain('2');
  expect(
    node(n('serveurs.groupe-Serveurs'))?.querySelector('.barre-gauche-groupe-couleur'),
  ).toHaveProperty('style.background', 'rgb(167, 139, 250)');

  const ligne = node(n('serveur-srv_1'))!;
  expect(ligne.getAttribute('href')).toBe('/serveurs/srv_1/configuration');
  expect(ligne.textContent).toContain('vps-ovh');
  expect(node(n('serveur-srv_1.etat'))?.textContent).toBe('12 ms');
  expect(ligne.querySelector('.icone-serveur')?.getAttribute('width')).toBe('15');
  expect(ligne.textContent).toContain('Connecté');

  expect(node(n('serveur-srv_2'))?.getAttribute('data-etat')).toBe('unreachable');
  expect(node(n('serveur-srv_2.etat'))?.textContent).toBe('Injoignable');
  expect(node(n('serveur-srv_2'))?.getAttribute('title')).toBe('délai dépassé');
  expect(node(n('serveur-srv_2'))?.textContent).toContain('délai dépassé');
  // pas encore contrôlé : aucun état reçu
  expect(node(n('serveur-srv_3.etat'))?.textContent).toBe('Non contrôlé');
});

test('le groupe se replie et se déplie ; le repli survit au remontage de la barre', async () => {
  open([serveur()], [statut()]);
  await waitFor(() => expect(node(n('serveur-srv_1'))).not.toBeNull());
  const bascule = node(n('serveurs.groupe-Serveurs.bascule'))!;
  expect(bascule.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(bascule);
  expect(node(n('serveur-srv_1'))).toBeNull();
  expect(bascule.getAttribute('aria-expanded')).toBe('false');

  cleanup();
  open([serveur()], [statut()]);
  await waitFor(() => expect(node(n('serveurs.groupe-Serveurs.bascule'))).not.toBeNull());
  expect(node(n('serveur-srv_1'))).toBeNull();
  fireEvent.click(node(n('serveurs.groupe-Serveurs.bascule'))!);
  expect(node(n('serveur-srv_1'))).not.toBeNull();
});

test('ligne sélectionnée sur la configuration du serveur ; reconnexion en direct par l’éphémère', async () => {
  open([serveur()], [statut()], '/serveurs/srv_1/configuration');
  await waitFor(() => expect(node(n('serveur-srv_1'))).not.toBeNull());
  expect(node(n('serveur-srv_1'))?.getAttribute('aria-current')).toBe('page');
  expect(node(n('serveur-srv_1'))?.className).toContain('est-actif');

  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  act(() =>
    FakeSocket.all.at(-1)!.push({
      kind: 'ephemeral',
      type: 'server.status',
      status: statut({ state: 'connecting', latencyMs: null }),
    }),
  );
  expect(node(n('serveur-srv_1'))?.getAttribute('data-etat')).toBe('connecting');
  expect(node(n('serveur-srv_1.etat'))?.textContent).toBe('Connexion…');
});

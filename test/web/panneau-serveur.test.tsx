// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { act } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import type { ServerGitLog, ServerGitRepo, ServerGitStatus } from '../../src/shared/git.js';
import type { Server, ServerFsListing } from '../../src/shared/model.js';
import type { ConversationEvent } from '../../src/shared/conversation.js';
import type { ServerDiscussionView } from '../../web/src/data/discussionsServeur.js';
import { age, sousChemin } from '../../web/src/data/panneauServeur.js';
import { Discussion } from '../../web/src/ecrans/Discussion.js';
import { suivreOutils } from '../../web/src/data/panneauServeur.js';
import { FakeSocket, json, setup, snapshot } from './helpers.js';

/** Chantier 17 (F.3, §11.3.1) : panneau Fichiers / Git de l'écran Discussion d'un serveur. */
vi.stubGlobal('WebSocket', FakeSocket);
afterEach(cleanup);
const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement | null;
const nodes = (id: string) =>
  [...document.querySelectorAll(`[data-node="${id}"]`)] as HTMLElement[];
const p = (path: string) => `path=${encodeURIComponent(path)}`;

const HEAD = 'c'.repeat(40);
const BASE = 'a'.repeat(40);
const READ_AT = new Date().toISOString();

const serveur: Server = {
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
  color: '#5de0a1',
  detectedAgents: ['claude'],
  lastTestAt: null,
  rules: [],
  createdAt: 't',
  updatedAt: 't',
};

const discussion: ServerDiscussionView = {
  id: 'sd_1',
  serverId: 'srv_1',
  name: 'Déploiement',
  cwd: '~/app',
  archived: false,
  createdAt: '2026-10-30T09:00:00.000Z',
  updatedAt: '2026-10-30T09:00:00.000Z',
  agents: [],
};

const dossier = (path: string, entries: ServerFsListing['entries']): ServerFsListing => ({
  serverId: 'srv_1',
  path,
  resolved: path.replace('~', '/home/deploy'),
  entries,
  truncated: false,
  git: true,
  readAt: READ_AT,
});
const entree = (over: Partial<ServerFsListing['entries'][number]>) => ({
  name: 'x',
  kind: 'file' as const,
  symlink: false,
  hidden: false,
  heavy: false,
  git: null,
  ...over,
});

const depot = (over: Partial<ServerGitRepo> = {}): ServerGitRepo => ({
  root: '/home/deploy/app',
  branch: 'feat/x',
  head: HEAD,
  changes: 3,
  origin: true,
  upstream: 'origin/feat/x',
  aheadBehind: { ahead: 2, behind: 0 },
  operation: null,
  ...over,
});

const journal = (over: Partial<ServerGitLog> = {}): ServerGitLog => ({
  serverId: 'srv_1',
  path: '~/app',
  scope: 'all',
  repo: depot(),
  truncated: false,
  readAt: READ_AT,
  commits: [
    {
      hash: HEAD,
      parents: [BASE],
      author: 'Alice',
      date: '2026-10-30T10:00:00.000Z',
      message: 'Ajoute la route de santé',
      refs: ['HEAD -> feat/x'],
      inHead: true,
    },
    {
      hash: BASE,
      parents: [],
      author: 'Bob',
      date: '2026-10-29T10:00:00.000Z',
      message: 'Premier commit',
      refs: ['origin/main', 'main'],
      inHead: true,
    },
  ],
  dirty: false,
  live: { aheadBehind: null, rebaseInProgress: false, onTopicBranch: false, headBranch: null },
  ...over,
});

const etatGit = (over: Partial<ServerGitStatus> = {}): ServerGitStatus => ({
  serverId: 'srv_1',
  path: '~/app',
  resolved: '/home/deploy/app',
  repo: depot(),
  repos: [],
  readAt: READ_AT,
  ...over,
});

function ouvrir(
  panneau: { open: boolean; tab: 'files' | 'git' },
  routes: Record<string, () => Response> = {},
) {
  return setup(
    <Routes>
      <Route path="/serveurs/:id/discussions/:discussionId" element={<Discussion />} />
    </Routes>,
    snapshot(),
    '/serveurs/srv_1/discussions/sd_1',
    {
      'GET /api/servers': json(200, [serveur]),
      'GET /api/servers/status': json(200, [
        { serverId: 'srv_1', state: 'connected', latencyMs: 12, checkedAt: READ_AT, reason: null },
      ]),
      'GET /api/nav': json(200, { groups: [], placements: [], prefs: { reduit: false } }),
      'GET /api/servers/srv_1/discussions/sd_1': json(200, discussion),
      'GET /api/servers/srv_1/panel': json(200, panneau),
      'PUT /api/servers/srv_1/panel': json(200, panneau),
      ...routes,
    },
  );
}

const ARBRE = {
  [`GET /api/servers/srv_1/fs?${p('~/app')}`]: json(
    200,
    dossier('~/app', [
      entree({ name: 'src', kind: 'dir', git: 'M' }),
      entree({ name: 'node_modules', kind: 'dir', heavy: true }),
      entree({ name: '.env', hidden: true }),
      entree({ name: 'README.md', git: '?' }),
      entree({ name: 'logo.png' }),
    ]),
  ),
  [`GET /api/servers/srv_1/fs?${p('~/app/src')}`]: json(
    200,
    dossier('~/app/src', [entree({ name: 'index.ts', git: 'M' })]),
  ),
  [`GET /api/servers/srv_1/file?${p('~/app/README.md')}`]: json(200, {
    serverId: 'srv_1',
    path: '~/app/README.md',
    resolved: '/home/deploy/app/README.md',
    size: 12,
    binary: false,
    truncated: false,
    content: '# Application',
    readAt: READ_AT,
  }),
  [`GET /api/servers/srv_1/file?${p('~/app/logo.png')}`]: json(200, {
    serverId: 'srv_1',
    path: '~/app/logo.png',
    resolved: '/home/deploy/app/logo.png',
    size: 4096,
    binary: true,
    truncated: false,
    content: null,
    readAt: READ_AT,
  }),
};

const ligne = (nom: string) =>
  document.querySelector(
    `[data-node="discussion.panneau.fichier"][data-nom="${nom}"]`,
  ) as HTMLButtonElement | null;

test('fermé par défaut : le bouton Panneau l’ouvre sur Fichiers et mémorise le réglage', async () => {
  const h = ouvrir({ open: false, tab: 'files' }, ARBRE);
  const bascule = await waitFor(() => {
    const b = node('discussion.panneau.bascule') as HTMLButtonElement;
    expect(b.disabled).toBe(false);
    return b;
  });
  expect(node('discussion.panneau')).toBeNull();
  expect(bascule.getAttribute('aria-pressed')).toBe('false');

  fireEvent.click(bascule);
  await waitFor(() => expect(node('discussion.panneau')).not.toBeNull());
  expect(bascule.getAttribute('aria-pressed')).toBe('true');
  expect(
    h.calls
      .filter((c) => c.method === 'PUT' && c.url === '/api/servers/srv_1/panel')
      .map((c) => c.body),
  ).toEqual([{ open: true, tab: 'files' }]);
  await waitFor(() => expect(ligne('src')).not.toBeNull());
  expect(node('discussion.panneau.chemin')?.textContent).toBe('vps-ovh:~/app');
  expect(node('discussion.panneau.age')?.textContent).toMatch(/^il y a \d+ (s|min|h)$/);
  expect(document.activeElement).not.toBe(bascule);

  fireEvent.click(node('discussion.panneau.fermer')!);
  expect(node('discussion.panneau')).toBeNull();
  // le focus revient au bouton qui a ouvert le panneau
  expect(document.activeElement).toBe(bascule);
  expect(h.calls.filter((c) => c.method === 'PUT').at(-1)?.body).toEqual({
    open: false,
    tab: 'files',
  });
});

test('arbre : badges, masqué non cliquable, dossier lourd grisé, dépliage à la demande', async () => {
  const h = ouvrir({ open: true, tab: 'files' }, ARBRE);
  await waitFor(() => expect(ligne('src')).not.toBeNull());

  expect(ligne('src')!.textContent).toContain('M');
  expect(ligne('src')!.querySelector('.ligne-arbre-badge--modifie')).not.toBeNull();
  expect(ligne('README.md')!.querySelector('.ligne-arbre-badge--non-suivi')?.textContent).toBe('?');
  // masqué : atteignable au clavier, mais jamais ouvert
  expect(ligne('.env')!.getAttribute('aria-disabled')).toBe('true');
  expect(ligne('.env')!.textContent).toContain('masqué');
  fireEvent.click(ligne('.env')!);
  expect(h.calls.some((c) => c.url.includes('.env'))).toBe(false);
  expect(node('discussion.panneau.apercu')).toBeNull();
  expect(ligne('node_modules')!.className).toContain('ligne-arbre--lourd');
  expect(ligne('node_modules')!.disabled).toBe(false);
  expect(ligne('node_modules')!.title).toContain('dossier lourd');
  expect(ligne('src')!.getAttribute('aria-expanded')).toBe('false');

  // pas de lecture du sous-dossier avant le dépliage
  const lu = (path: string) =>
    h.calls.filter((c) => c.url === `/api/servers/srv_1/fs?${p(path)}`).length;
  expect(lu('~/app/src')).toBe(0);
  fireEvent.click(ligne('src')!);
  await waitFor(() => expect(ligne('index.ts')).not.toBeNull());
  expect(ligne('src')!.getAttribute('aria-expanded')).toBe('true');
  expect(ligne('index.ts')!.dataset.niveau).toBe('2');
  expect(lu('~/app/src')).toBe(1);

  // ↻ relit la racine et les dossiers dépliés
  fireEvent.click(node('discussion.panneau.actualiser')!);
  await waitFor(() => expect(lu('~/app/src')).toBe(2));
  expect(lu('~/app')).toBe(2);

  // replié puis redéplié : déjà lu, pas de nouvelle lecture
  fireEvent.click(ligne('src')!);
  expect(ligne('index.ts')).toBeNull();
  fireEvent.click(ligne('src')!);
  expect(ligne('index.ts')).not.toBeNull();
  expect(lu('~/app/src')).toBe(2);
});

test('aperçu d’un fichier à la place de l’arbre, binaire signalé, Retour', async () => {
  ouvrir({ open: true, tab: 'files' }, ARBRE);
  await waitFor(() => expect(ligne('README.md')).not.toBeNull());

  fireEvent.click(ligne('README.md')!);
  await waitFor(() =>
    expect(node('discussion.panneau.apercu.contenu')?.textContent).toBe('# Application'),
  );
  expect(node('discussion.panneau.arbre')).toBeNull();
  expect(node('discussion.panneau.chemin')?.textContent).toBe('vps-ovh:~/app/README.md');

  fireEvent.click(node('discussion.panneau.apercu.retour')!);
  expect(node('discussion.panneau.arbre')).not.toBeNull();

  fireEvent.click(ligne('logo.png')!);
  await waitFor(() => expect(node('discussion.panneau.apercu.binaire')).not.toBeNull());
  expect(node('discussion.panneau.apercu.contenu')).toBeNull();
});

test('erreur de lecture du dossier affichée dans le panneau', async () => {
  ouvrir(
    { open: true, tab: 'files' },
    {
      [`GET /api/servers/srv_1/fs?${p('~/app')}`]: json(403, {
        error: 'hors des dossiers autorisés',
      }),
    },
  );
  await waitFor(() =>
    expect(node('discussion.panneau.fichiers.erreur')?.textContent).toBe(
      'hors des dossiers autorisés',
    ),
  );
});

const LOG = (path: string, scope = 'all') =>
  `GET /api/servers/srv_1/git/log?${p(path)}&scope=${scope}`;

test('onglet Git mémorisé : branche, modifiés, avance, graphe ; changer d’onglet est mémorisé', async () => {
  const h = ouvrir({ open: true, tab: 'git' }, { [LOG('~/app')]: json(200, journal()), ...ARBRE });
  await waitFor(() => expect(node('discussion.panneau.git.branche')?.textContent).toBe('feat/x'));
  expect(node('discussion.panneau.git.modifies')?.textContent).toBe('3 modifiés');
  expect(node('discussion.panneau.git.position')?.textContent).toBe(
    '↑ 2 d’avance sur origin/feat/x',
  );
  expect(node('discussion.panneau.git.pousser')?.textContent).toBe('Pousser 2 commits');
  expect(node(`discussion.panneau.git.commit-${HEAD}`)?.textContent).toContain(
    'Ajoute la route de santé',
  );
  expect(node(`discussion.panneau.git.commit-${BASE}`)?.querySelector('svg')).not.toBeNull();
  expect(node('discussion.panneau.chemin')?.textContent).toBe('vps-ovh:/home/deploy/app');

  fireEvent.click(node('discussion.panneau.onglet-files')!);
  await waitFor(() => expect(ligne('src')).not.toBeNull());
  expect(h.calls.filter((c) => c.method === 'PUT').at(-1)?.body).toEqual({
    open: true,
    tab: 'files',
  });
});

test('portée Branche seule relit le journal', async () => {
  const h = ouvrir(
    { open: true, tab: 'git' },
    {
      [LOG('~/app')]: json(200, journal()),
      // la portée Branche seule ne voit pas le commit de main
      [LOG('~/app', 'branch')]: json(
        200,
        journal({ scope: 'branch', commits: [{ ...journal().commits[0]!, parents: [] }] }),
      ),
    },
  );
  await waitFor(() => expect(node('discussion.panneau.git.branche')).not.toBeNull());
  fireEvent.click(node('discussion.panneau.git.portee-branch')!);
  await waitFor(() =>
    expect(h.calls.some((c) => c.url === LOG('~/app', 'branch').slice(4))).toBe(true),
  );
  expect(node('discussion.panneau.git.portee-branch')?.getAttribute('aria-pressed')).toBe('true');
  await waitFor(() => expect(node(`discussion.panneau.git.commit-${BASE}`)).toBeNull());
  expect(node(`discussion.panneau.git.commit-${HEAD}`)).not.toBeNull();
});

test('Pousser : carte de confirmation, puis POST lié au commit affiché, puis relecture', async () => {
  const h = ouvrir(
    { open: true, tab: 'git' },
    {
      [LOG('~/app')]: json(200, journal()),
      'POST /api/servers/srv_1/git/push': json(
        200,
        etatGit({ repo: depot({ aheadBehind: { ahead: 0, behind: 0 } }) }),
      ),
    },
  );
  await waitFor(() => expect(node('discussion.panneau.git.pousser')).not.toBeNull());
  fireEvent.click(node('discussion.panneau.git.pousser')!);
  const carte = node('discussion.panneau.git.confirmation')!;
  expect(carte.textContent).toContain('git push origin HEAD:refs/heads/feat/x');
  expect(carte.textContent).toContain('2 commits');
  expect(carte.textContent).toContain(HEAD.slice(0, 7));
  // focus sur Annuler : Entrée par mégarde ne pousse pas
  expect(document.activeElement).toBe(node('discussion.panneau.git.confirmation.annuler'));
  // rien n'est envoyé avant la validation
  expect(h.calls.some((c) => c.method === 'POST')).toBe(false);

  // après la poussée, le journal relu est à jour : l'affichage suit
  h.respond.set(
    LOG('~/app'),
    json(200, journal({ repo: depot({ aheadBehind: { ahead: 0, behind: 0 } }) })),
  );
  fireEvent.click(node('discussion.panneau.git.confirmation.valider')!);
  await waitFor(() =>
    expect(node('discussion.panneau.git.position')?.textContent).toBe('à jour avec origin/feat/x'),
  );
  expect(node('discussion.panneau.git.pousser')?.textContent).toBe('Pousser');
  expect(h.calls.filter((c) => c.method === 'POST')).toEqual([
    {
      method: 'POST',
      url: '/api/servers/srv_1/git/push',
      body: { path: '~/app', confirm: true, head: HEAD },
    },
  ]);
  expect(node('discussion.panneau.git.confirmation')).toBeNull();
});

test('Synchroniser annulé : aucune écriture ; échec d’écriture affiché', async () => {
  const h = ouvrir(
    { open: true, tab: 'git' },
    {
      [LOG('~/app')]: json(200, journal()),
      'POST /api/servers/srv_1/git/sync': json(409, {
        error: 'conflit pendant le rebase : rien n’a été poussé',
      }),
    },
  );
  await waitFor(() => expect(node('discussion.panneau.git.synchroniser')).not.toBeNull());
  fireEvent.click(node('discussion.panneau.git.synchroniser')!);
  expect(node('discussion.panneau.git.confirmation')?.textContent).toContain(
    'git rebase origin/feat/x',
  );
  expect(node('discussion.panneau.git.confirmation.effet')?.textContent).toContain(
    'nouveaux hashs',
  );
  fireEvent.click(node('discussion.panneau.git.confirmation.annuler')!);
  expect(node('discussion.panneau.git.confirmation')).toBeNull();
  // Échap annule aussi
  fireEvent.click(node('discussion.panneau.git.synchroniser')!);
  fireEvent.keyDown(node('discussion.panneau.git.confirmation.annuler')!, { key: 'Escape' });
  expect(node('discussion.panneau.git.confirmation')).toBeNull();
  expect(h.calls.some((c) => c.method === 'POST')).toBe(false);

  fireEvent.click(node('discussion.panneau.git.synchroniser')!);
  fireEvent.click(node('discussion.panneau.git.confirmation.valider')!);
  await waitFor(() =>
    expect(node('discussion.panneau.git.action-erreur')?.textContent).toBe(
      'conflit pendant le rebase : rien n’a été poussé',
    ),
  );
  expect(h.calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
    { path: '~/app', confirm: true, head: HEAD },
  ]);
});

test('Fetch sans confirmation ; rien à pousser : Pousser et Synchroniser désactivés', async () => {
  const h = ouvrir(
    { open: true, tab: 'git' },
    {
      [LOG('~/app')]: json(200, journal({ repo: depot({ aheadBehind: { ahead: 0, behind: 1 } }) })),
      'POST /api/servers/srv_1/git/fetch': json(200, etatGit()),
    },
  );
  await waitFor(() => expect(node('discussion.panneau.git.fetch')).not.toBeNull());
  expect((node('discussion.panneau.git.pousser') as HTMLButtonElement).disabled).toBe(true);
  expect((node('discussion.panneau.git.synchroniser') as HTMLButtonElement).disabled).toBe(true);
  expect(node('discussion.panneau.git.pousser')?.textContent).toBe('Pousser');
  expect(node('discussion.panneau.git.position')?.textContent).toBe(
    '↓ 1 de retard sur origin/feat/x',
  );

  fireEvent.click(node('discussion.panneau.git.fetch')!);
  await waitFor(() => expect(h.calls.some((c) => c.method === 'POST')).toBe(true));
  expect(h.calls.find((c) => c.method === 'POST')).toEqual({
    method: 'POST',
    url: '/api/servers/srv_1/git/fetch',
    body: { path: '~/app' },
  });
});

test('positions : jamais poussée, à jour, sans origin, HEAD détachée', async () => {
  const cas: Array<[Partial<ServerGitRepo>, string]> = [
    [{ upstream: null, aheadBehind: { ahead: 4, behind: 0 } }, 'jamais poussée · 4 à pousser'],
    [{ aheadBehind: { ahead: 0, behind: 0 } }, 'à jour avec origin/feat/x'],
    [{ origin: false, upstream: null, aheadBehind: null }, 'pas de remote origin'],
  ];
  for (const [repo, texte] of cas) {
    ouvrir(
      { open: true, tab: 'git' },
      { [LOG('~/app')]: json(200, journal({ repo: depot(repo) })) },
    );
    await waitFor(() => expect(node('discussion.panneau.git.position')?.textContent).toBe(texte));
    cleanup();
  }
  ouvrir(
    { open: true, tab: 'git' },
    { [LOG('~/app')]: json(200, journal({ repo: depot({ branch: null, operation: 'rebase' }) })) },
  );
  await waitFor(() =>
    expect(node('discussion.panneau.git.branche')?.textContent).toBe('HEAD détachée'),
  );
  expect(node('discussion.panneau.git.operation')?.textContent).toBe('rebase en cours');
  expect((node('discussion.panneau.git.pousser') as HTMLButtonElement).disabled).toBe(true);
});

test('écritures désactivées : opération en cours sur une branche, Synchroniser sans origin/<branche>', async () => {
  ouvrir(
    { open: true, tab: 'git' },
    { [LOG('~/app')]: json(200, journal({ repo: depot({ operation: 'merge' }) })) },
  );
  await waitFor(() => expect(node('discussion.panneau.git.operation')).not.toBeNull());
  expect((node('discussion.panneau.git.pousser') as HTMLButtonElement).disabled).toBe(true);
  expect((node('discussion.panneau.git.synchroniser') as HTMLButtonElement).disabled).toBe(true);
  cleanup();

  ouvrir(
    { open: true, tab: 'git' },
    {
      [LOG('~/app')]: json(
        200,
        journal({ repo: depot({ upstream: null, aheadBehind: { ahead: 2, behind: 0 } }) }),
      ),
    },
  );
  await waitFor(() => expect(node('discussion.panneau.git.pousser')).not.toBeNull());
  // première poussée possible, rien à rebaser
  expect((node('discussion.panneau.git.pousser') as HTMLButtonElement).disabled).toBe(false);
  expect((node('discussion.panneau.git.synchroniser') as HTMLButtonElement).disabled).toBe(true);
});

test('carte fermée si HEAD a bougé à la relecture', async () => {
  const h = ouvrir({ open: true, tab: 'git' }, { [LOG('~/app')]: json(200, journal()) });
  await waitFor(() => expect(node('discussion.panneau.git.pousser')).not.toBeNull());
  fireEvent.click(node('discussion.panneau.git.pousser')!);
  expect(node('discussion.panneau.git.confirmation')).not.toBeNull();

  // ↻ sans changement : la carte reste
  const lectures = () => h.calls.filter((c) => c.url === LOG('~/app').slice(4)).length;
  const avant = lectures();
  fireEvent.click(node('discussion.panneau.actualiser')!);
  await waitFor(() => expect(lectures()).toBe(avant + 1));
  await waitFor(() => expect(node('discussion.panneau.git.confirmation')).not.toBeNull());

  h.respond.set(LOG('~/app'), json(200, journal({ repo: depot({ head: 'd'.repeat(40) }) })));
  fireEvent.click(node('discussion.panneau.actualiser')!);
  await waitFor(() => expect(node('discussion.panneau.git.confirmation')).toBeNull());
  expect(h.calls.some((c) => c.method === 'POST')).toBe(false);
});

test('dossier non Git : dépôts détectés proposés, le choix relit le journal de ce dépôt', async () => {
  ouvrir(
    { open: true, tab: 'git' },
    {
      [LOG('~/app')]: json(409, { error: 'pas un dépôt Git' }),
      [`GET /api/servers/srv_1/git/status?${p('~/app')}`]: json(
        200,
        etatGit({ repo: null, repos: ['/home/deploy/app/api', '/home/deploy/app/web'] }),
      ),
      [LOG('/home/deploy/app/web')]: json(
        200,
        journal({ repo: depot({ root: '/home/deploy/app/web' }) }),
      ),
    },
  );
  await waitFor(() => expect(nodes('discussion.panneau.git.depot')).toHaveLength(2));
  expect(node('discussion.panneau.git.hors-depot')?.textContent).toContain('pas un dépôt Git');
  fireEvent.click(screen.getByText('/home/deploy/app/web'));
  await waitFor(() =>
    expect(node('discussion.panneau.chemin')?.textContent).toBe('vps-ovh:/home/deploy/app/web'),
  );
  expect(node('discussion.panneau.git.branche')).not.toBeNull();
});

test('erreur du journal autre que « pas un dépôt » : affichée telle quelle', async () => {
  ouvrir(
    { open: true, tab: 'git' },
    { [LOG('~/app')]: json(502, { error: 'serveur injoignable' }) },
  );
  await waitFor(() =>
    expect(node('discussion.panneau.git.erreur')?.textContent).toBe('serveur injoignable'),
  );
});

test('détail d’un commit à la place de la liste, Retour', async () => {
  ouvrir(
    { open: true, tab: 'git' },
    {
      [LOG('~/app')]: json(200, journal()),
      [`GET /api/servers/srv_1/git/commits/${HEAD}?${p('~/app')}`]: json(200, {
        hash: HEAD,
        parents: [BASE],
        author: 'Alice',
        date: '2026-10-30T10:00:00.000Z',
        message: 'Ajoute la route de santé',
        body: 'Renvoie 200 sur /health.',
        refs: ['feat/x'],
        inHead: true,
        files: [{ path: 'src/health.ts', status: 'A', additions: 12, deletions: 0 }],
      }),
    },
  );
  await waitFor(() => expect(node(`discussion.panneau.git.commit-${HEAD}`)).not.toBeNull());
  fireEvent.click(node(`discussion.panneau.git.commit-${HEAD}`)!);
  await waitFor(() =>
    expect(node('discussion.panneau.git.detail.message')?.textContent).toBe(
      'Ajoute la route de santé',
    ),
  );
  expect(node('discussion.panneau.git.detail.fichier')?.textContent).toContain('src/health.ts');
  expect(node(`discussion.panneau.git.commit-${HEAD}`)).toBeNull();
  fireEvent.click(node('discussion.panneau.git.detail.retour')!);
  expect(node(`discussion.panneau.git.commit-${HEAD}`)).not.toBeNull();
});

test('modifications non commitées : ligne WIP en tête, non cliquable', async () => {
  ouvrir({ open: true, tab: 'git' }, { [LOG('~/app')]: json(200, journal({ dirty: true })) });
  await waitFor(() => expect(node('discussion.panneau.git.commit-wip')).not.toBeNull());
  expect((node('discussion.panneau.git.commit-wip') as HTMLButtonElement).disabled).toBe(true);
});

test('age et sousChemin', () => {
  const now = Date.parse('2026-10-31T10:00:00.000Z');
  expect(age('2026-10-31T09:59:58.000Z', now)).toBe('il y a 2 s');
  expect(age('2026-10-31T10:00:05.000Z', now)).toBe('il y a 0 s');
  expect(age('2026-10-31T09:55:00.000Z', now)).toBe('il y a 5 min');
  expect(age('2026-10-31T07:00:00.000Z', now)).toBe('il y a 3 h');
  expect(sousChemin('~/app', 'src')).toBe('~/app/src');
  expect(sousChemin('/', 'etc')).toBe('/etc');
});

test('dépôt choisi en échec : retour au dossier de la discussion, rien de l’essai ne reste', async () => {
  const h = ouvrir(
    { open: true, tab: 'git' },
    {
      [LOG('~/app')]: json(409, { error: 'pas un dépôt Git' }),
      [`GET /api/servers/srv_1/git/status?${p('~/app')}`]: json(
        200,
        etatGit({ repo: null, repos: ['/home/deploy/app/api'] }),
      ),
      [LOG('/home/deploy/app/api')]: json(502, { error: 'délai dépassé' }),
    },
  );
  await waitFor(() => expect(nodes('discussion.panneau.git.depot')).toHaveLength(1));
  fireEvent.click(nodes('discussion.panneau.git.depot')[0]!);
  await waitFor(() =>
    expect(node('discussion.panneau.git.erreur')?.textContent).toBe('délai dépassé'),
  );

  fireEvent.click(node('discussion.panneau.git.racine')!);
  await waitFor(() => expect(nodes('discussion.panneau.git.depot')).toHaveLength(1));
  expect(node('discussion.panneau.git.erreur')).toBeNull();
  expect(h.calls.filter((c) => c.url === LOG('~/app').slice(4))).toHaveLength(2);
});

test('réglage du panneau non enregistré : retour à l’état précédent, erreur affichée', async () => {
  ouvrir(
    { open: false, tab: 'files' },
    { ...ARBRE, 'PUT /api/servers/srv_1/panel': json(500, { error: 'base verrouillée' }) },
  );
  const bascule = await waitFor(() => {
    const b = node('discussion.panneau.bascule') as HTMLButtonElement;
    expect(b.disabled).toBe(false);
    return b;
  });
  fireEvent.click(bascule);
  await waitFor(() => expect(node('discussion.erreur')?.textContent).toBe('base verrouillée'));
  expect(node('discussion.panneau')).toBeNull();
  expect(bascule.getAttribute('aria-pressed')).toBe('false');
});

// F.4 : actualisation à la fin d'un groupe d'outils, au retour du serveur ; injoignable : données gardées.

const AGENT = {
  id: 'sa_1',
  discussionId: 'sd_1',
  kind: 'claude' as const,
  sessionId: 's',
  status: 'idle' as const,
  tmuxSession: 'aid-sa_1',
  outOffset: 0,
  permissionMode: 'default' as const,
  model: null,
  effort: null,
  createdAt: '2026-10-30T09:00:00.000Z',
  updatedAt: '2026-10-30T09:00:00.000Z',
  pending: null,
};

function ouvrirAvecAgent(
  panneau: { open: boolean; tab: 'files' | 'git' },
  routes: Record<string, () => Response>,
  state: 'connected' | 'unreachable' = 'connected',
) {
  return ouvrir(panneau, {
    'GET /api/servers/srv_1/discussions/sd_1': json(200, { ...discussion, agents: [AGENT] }),
    'GET /api/server-agents/sa_1': json(200, AGENT),
    'GET /api/servers/status': json(200, [
      {
        serverId: 'srv_1',
        state,
        latencyMs: state === 'connected' ? 12 : null,
        checkedAt: READ_AT,
        reason: state === 'connected' ? null : 'Connection refused',
      },
    ]),
    ...routes,
  });
}

const fil = async () => {
  await waitFor(() =>
    expect(FakeSocket.all.some((s) => s.url.includes('/ws/server-agent/'))).toBe(true),
  );
  const s = FakeSocket.all.filter((x) => x.url.includes('/ws/server-agent/')).at(-1)!;
  act(() => s.open());
  act(() => s.push({ t: 'history', truncated: false, items: [] }));
  return s;
};
const evenement = (s: FakeSocket, seq: number, event: object) =>
  act(() => s.push({ t: 'event', seq, at: READ_AT, event }));

/** Laisse passer la coalescence des relectures (300 ms) avant d'affirmer qu'aucune n'est partie. */
const calme = () => act(() => new Promise((r) => setTimeout(r, 450)));

/** Statut du serveur poussé comme en direct par `/ws/events`. */
const statut = (state: 'connected' | 'unreachable') => {
  const s = FakeSocket.all.filter((x) => x.url.includes('/ws/events')).at(-1)!;
  act(() =>
    s.push({
      kind: 'ephemeral',
      type: 'server.status',
      status: {
        serverId: 'srv_1',
        state,
        latencyMs: state === 'connected' ? 9 : null,
        checkedAt: new Date().toISOString(),
        reason: state === 'connected' ? null : 'Connection refused',
      },
    }),
  );
};

test('suivreOutils : une fin de groupe après au moins un outil terminé, au lien rétabli ; seq déjà vu ignoré', () => {
  let s = { fins: 0, outilTermine: false, seq: -1 };
  let seq = 0;
  const pas = (event: ConversationEvent) => (s = suivreOutils(s, { seq: ++seq, event }));
  pas({ type: 'message', role: 'assistant', text: 'je regarde' });
  pas({ type: 'turn_end', ok: true });
  expect(s.fins).toBe(0);
  pas({ type: 'tool_start', toolId: 't1', name: 'Bash', input: 'ls' });
  pas({ type: 'tool_end', toolId: 't1', output: '', isError: false });
  pas({ type: 'tool_start', toolId: 't2', name: 'Bash', input: 'git commit' });
  pas({ type: 'tool_end', toolId: 't2', output: '', isError: false });
  expect(s.fins).toBe(0);
  pas({ type: 'message', role: 'assistant', text: 'fait' });
  expect(s.fins).toBe(1);
  pas({ type: 'turn_end', ok: true });
  expect(s.fins).toBe(1);
  pas({ type: 'tool_end', toolId: 't3', output: '', isError: true });
  pas({ type: 'exit', code: 1, signal: null });
  expect(s.fins).toBe(2);
  pas({ type: 'connection_resumed', at: 't', afterMs: 10, sessionFound: true });
  expect(s.fins).toBe(3);
  // sans changement : même objet, pas de rendu
  expect(suivreOutils(s, { seq: ++seq, event: { type: 'thinking' } })).toBe(s);

  // redélivré (même seq ou plus ancien) : ne compte pas
  const avant = s;
  expect(
    suivreOutils(s, {
      seq: s.seq,
      event: { type: 'connection_resumed', at: 't', afterMs: 1, sessionFound: true },
    }),
  ).toBe(avant);
  s = suivreOutils(s, {
    seq: 100,
    event: { type: 'tool_end', toolId: 't4', output: '', isError: false },
  });
  s = suivreOutils(s, { seq: 101, event: { type: 'message', role: 'assistant', text: 'ok' } });
  expect(s.fins).toBe(4);
  expect(
    suivreOutils(s, { seq: 101, event: { type: 'message', role: 'assistant', text: 'ok' } }),
  ).toBe(s);
});

test('onglet Git relu à la fin d’un groupe d’outils de l’agent, pas à chaque événement', async () => {
  const h = ouvrirAvecAgent({ open: true, tab: 'git' }, { [LOG('~/app')]: json(200, journal()) });
  await waitFor(() => expect(node('discussion.panneau.git.branche')).not.toBeNull());
  const s = await fil();
  const lectures = () => h.calls.filter((c) => c.url === LOG('~/app').slice(4)).length;
  const avant = lectures();

  evenement(s, 1, { type: 'tool_start', toolId: 't1', name: 'Bash', input: 'git commit -m x' });
  evenement(s, 2, { type: 'tool_end', toolId: 't1', output: '', isError: false });
  evenement(s, 3, { type: 'thinking' });
  await calme();
  expect(lectures()).toBe(avant);

  h.respond.set(
    LOG('~/app'),
    json(200, journal({ repo: depot({ aheadBehind: { ahead: 3, behind: 0 } }) })),
  );
  evenement(s, 4, { type: 'message', role: 'assistant', text: 'Commit fait.' });
  await waitFor(() =>
    expect(node('discussion.panneau.git.pousser')?.textContent).toBe('Pousser 3 commits'),
  );
  expect(lectures()).toBe(avant + 1);

  // sans outil terminé entre deux, ni la fin de tour ni un message ne relisent
  evenement(s, 5, { type: 'turn_end', ok: true });
  evenement(s, 6, { type: 'message', role: 'user', text: 'merci' });
  await calme();
  expect(lectures()).toBe(avant + 1);

  // rafale : deux groupes coup sur coup, une seule relecture
  evenement(s, 7, { type: 'tool_end', toolId: 't2', output: '', isError: false });
  evenement(s, 8, { type: 'message', role: 'assistant', text: 'a' });
  evenement(s, 9, { type: 'tool_end', toolId: 't3', output: '', isError: false });
  evenement(s, 10, { type: 'message', role: 'assistant', text: 'b' });
  await waitFor(() => expect(lectures()).toBe(avant + 2));
  await calme();
  expect(lectures()).toBe(avant + 2);
});

test('onglet Fichiers relu à la fin d’un groupe d’outils : racine et dossiers dépliés, aperçu compris', async () => {
  const h = ouvrirAvecAgent({ open: true, tab: 'files' }, ARBRE);
  await waitFor(() => expect(ligne('src')).not.toBeNull());
  fireEvent.click(ligne('src')!);
  await waitFor(() => expect(ligne('index.ts')).not.toBeNull());
  const s = await fil();
  const lu = (path: string) =>
    h.calls.filter((c) => c.url === `/api/servers/srv_1/fs?${p(path)}`).length;
  const luFichier = () =>
    h.calls.filter((c) => c.url === `/api/servers/srv_1/file?${p('~/app/README.md')}`).length;
  expect([lu('~/app'), lu('~/app/src')]).toEqual([1, 1]);

  evenement(s, 1, { type: 'tool_end', toolId: 't1', output: '', isError: false });
  evenement(s, 2, { type: 'turn_end', ok: true });
  await waitFor(() => expect([lu('~/app'), lu('~/app/src')]).toEqual([2, 2]));

  // aperçu ouvert : le fichier et l'arbre sont relus, l'aperçu reste affiché
  fireEvent.click(ligne('README.md')!);
  await waitFor(() => expect(node('discussion.panneau.apercu.contenu')).not.toBeNull());
  expect(luFichier()).toBe(1);
  evenement(s, 3, { type: 'tool_end', toolId: 't2', output: '', isError: false });
  evenement(s, 4, { type: 'turn_end', ok: true });
  await waitFor(() => expect(luFichier()).toBe(2));
  expect(lu('~/app')).toBe(3);
  expect(node('discussion.panneau.apercu.contenu')?.textContent).toBe('# Application');
});

test('coupure : dernières données gardées, âge en ambre, écritures désactivées ; au retour une seule relecture', async () => {
  const h = ouvrirAvecAgent({ open: true, tab: 'git' }, { [LOG('~/app')]: json(200, journal()) });
  await waitFor(() =>
    expect(node('discussion.panneau.git.pousser')?.textContent).toBe('Pousser 2 commits'),
  );
  const s = await fil();
  expect(node('discussion.panneau.age')?.dataset.ancien).toBeUndefined();
  fireEvent.click(node('discussion.panneau.git.pousser')!);
  const lectures = () => h.calls.filter((c) => c.url === LOG('~/app').slice(4)).length;
  const avant = lectures();

  statut('unreachable');
  await waitFor(() => expect(node('discussion.panneau.age')?.dataset.ancien).toBe('true'));
  expect(node('discussion.panneau.age')?.title).toContain('injoignable');
  expect(node('discussion.panneau.git.branche')?.textContent).toBe('feat/x');
  expect(node(`discussion.panneau.git.commit-${HEAD}`)).not.toBeNull();
  for (const n of [
    'actualiser',
    'git.pousser',
    'git.synchroniser',
    'git.fetch',
    'git.confirmation.valider',
  ])
    expect((node(`discussion.panneau.${n}`) as HTMLButtonElement).disabled).toBe(true);

  // une fin de groupe pendant la coupure ne relit rien
  evenement(s, 1, { type: 'tool_end', toolId: 't1', output: '', isError: false });
  evenement(s, 2, { type: 'turn_end', ok: true });
  await calme();
  expect(lectures()).toBe(avant);

  // retour du serveur puis lien de l'agent rétabli : une seule relecture
  statut('connected');
  evenement(s, 3, { type: 'connection_resumed', at: 't', afterMs: 5000, sessionFound: true });
  await waitFor(() => expect(lectures()).toBe(avant + 1));
  await calme();
  expect(lectures()).toBe(avant + 1);
  expect(node('discussion.panneau.age')?.dataset.ancien).toBeUndefined();
  for (const n of ['actualiser', 'git.pousser', 'git.synchroniser', 'git.fetch'])
    expect((node(`discussion.panneau.${n}`) as HTMLButtonElement).disabled).toBe(false);
});

test('ouvert pendant une coupure : bandeau de la discussion, données de la lecture d’ouverture en ambre', async () => {
  ouvrirAvecAgent(
    { open: true, tab: 'git' },
    { [LOG('~/app')]: json(200, journal()) },
    'unreachable',
  );
  await waitFor(() => expect(node('discussion.panneau.git.branche')).not.toBeNull());
  expect(node('discussion.panneau.age')?.dataset.ancien).toBe('true');
  expect((node('discussion.panneau.actualiser') as HTMLButtonElement).disabled).toBe(true);
});

test('relectures croisées d’un dossier : la réponse de la plus ancienne, arrivée en dernier, est ignorée', async () => {
  let lente: ((r: Response) => void) | null = null;
  const h = ouvrir({ open: true, tab: 'files' }, ARBRE);
  await waitFor(() => expect(ligne('src')).not.toBeNull());
  const cle = `GET /api/servers/srv_1/fs?${p('~/app')}`;
  // première relecture : réponse retenue ; seconde : immédiate, sans README.md
  h.respond.set(cle, (() => new Promise<Response>((r) => (lente = r))) as never);
  fireEvent.click(node('discussion.panneau.actualiser')!);
  await waitFor(() => expect(lente).not.toBeNull());
  h.respond.set(cle, json(200, dossier('~/app', [entree({ name: 'src', kind: 'dir' })])));
  fireEvent.click(node('discussion.panneau.actualiser')!);
  await waitFor(() => expect(ligne('README.md')).toBeNull());

  act(() =>
    lente!(
      new Response(JSON.stringify(dossier('~/app', [entree({ name: 'ancien.txt' })])), {
        status: 200,
      }),
    ),
  );
  await calme();
  expect(ligne('ancien.txt')).toBeNull();
  expect(ligne('src')).not.toBeNull();
});

test('arbre et aperçu : lien symbolique signalé, aperçu tronqué, aperçu en échec', async () => {
  const fichier = (path: string, over: object) =>
    json(200, {
      serverId: 'srv_1',
      path,
      resolved: path.replace('~', '/home/deploy'),
      size: 900_000,
      binary: false,
      truncated: true,
      content: 'début',
      readAt: READ_AT,
      ...over,
    });
  ouvrir(
    { open: true, tab: 'files' },
    {
      [`GET /api/servers/srv_1/fs?${p('~/app')}`]: json(
        200,
        dossier('~/app', [
          entree({ name: 'courant', symlink: true }),
          entree({ name: 'gros.log' }),
          entree({ name: 'interdit' }),
        ]),
      ),
      [`GET /api/servers/srv_1/file?${p('~/app/gros.log')}`]: fichier('~/app/gros.log', {}),
      [`GET /api/servers/srv_1/file?${p('~/app/interdit')}`]: json(403, {
        error: 'lecture refusée par le serveur (permissions)',
      }),
    },
  );
  await waitFor(() => expect(ligne('courant')).not.toBeNull());
  expect(ligne('courant')!.title).toBe('courant (lien symbolique)');
  expect(ligne('courant')!.textContent).toContain('↗');
  expect(ligne('gros.log')!.textContent).not.toContain('↗');

  fireEvent.click(ligne('gros.log')!);
  await waitFor(() =>
    expect(node('discussion.panneau.apercu.tronque')?.textContent).toBe(
      'Aperçu tronqué (900000 octets au total).',
    ),
  );
  expect(node('discussion.panneau.apercu.contenu')?.textContent).toBe('début');
  fireEvent.click(node('discussion.panneau.apercu.retour')!);

  fireEvent.click(ligne('interdit')!);
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toBe(
      'lecture refusée par le serveur (permissions)',
    ),
  );
  expect(node('discussion.panneau.apercu.contenu')).toBeNull();
});

test('Git : position inconnue, un seul modifié, journal vide, aucun dépôt détecté', async () => {
  ouvrir(
    { open: true, tab: 'git' },
    {
      [LOG('~/app')]: json(
        200,
        journal({ repo: depot({ aheadBehind: null, changes: 1 }), commits: [] }),
      ),
    },
  );
  await waitFor(() =>
    expect(node('discussion.panneau.git.position')?.textContent).toBe('position inconnue'),
  );
  expect(node('discussion.panneau.git.modifies')?.textContent).toBe('1 modifié');
  expect(node('discussion.panneau.git.vide')?.textContent).toBe('Aucun commit dans ce dépôt.');
  cleanup();

  ouvrir(
    { open: true, tab: 'git' },
    {
      [LOG('~/app')]: json(409, { error: 'pas un dépôt Git' }),
      [`GET /api/servers/srv_1/git/status?${p('~/app')}`]: json(
        200,
        etatGit({ repo: null, repos: [] }),
      ),
    },
  );
  await waitFor(() =>
    expect(screen.getByText('Aucun dépôt trouvé dans les dossiers autorisés.')).not.toBeNull(),
  );
  expect(nodes('discussion.panneau.git.depot')).toHaveLength(0);
});

test('Git : Échap ferme la carte de confirmation et le détail ; détail en échec ou hors de la branche', async () => {
  const COMMIT = (hash: string) => `GET /api/servers/srv_1/git/commits/${hash}?${p('~/app')}`;
  ouvrir(
    { open: true, tab: 'git' },
    {
      [LOG('~/app')]: json(200, journal()),
      [COMMIT(HEAD)]: json(404, { error: 'commit introuvable dans ce dépôt' }),
      [COMMIT(BASE)]: json(200, {
        hash: BASE,
        parents: [],
        author: 'Bob',
        date: '2026-10-29T10:00:00.000Z',
        message: 'Premier commit',
        body: '',
        refs: [],
        inHead: false,
        files: [{ path: 'logo.png', status: 'A', additions: null, deletions: null }],
      }),
    },
  );
  await waitFor(() => expect(node('discussion.panneau.git.pousser')).not.toBeNull());
  fireEvent.click(node('discussion.panneau.git.pousser')!);
  fireEvent.keyDown(node('discussion.panneau.git.confirmation')!, { key: 'Enter' });
  expect(node('discussion.panneau.git.confirmation')).not.toBeNull();
  fireEvent.keyDown(node('discussion.panneau.git.confirmation')!, { key: 'Escape' });
  expect(node('discussion.panneau.git.confirmation')).toBeNull();

  fireEvent.click(node(`discussion.panneau.git.commit-${HEAD}`)!);
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toBe('commit introuvable dans ce dépôt'),
  );
  fireEvent.keyDown(node('discussion.panneau.git.detail')!, { key: 'Escape' });
  expect(node('discussion.panneau.git.detail')).toBeNull();

  fireEvent.click(node(`discussion.panneau.git.commit-${BASE}`)!);
  await waitFor(() => expect(node('discussion.panneau.git.detail.fichier')).not.toBeNull());
  const detail = node('discussion.panneau.git.detail')!;
  expect(detail.textContent).toContain('Dans la branchenon');
  expect(detail.textContent).toContain('1 fichier');
  expect(detail.textContent).not.toContain('1 fichiers');
  // binaire : ni ajouts ni suppressions chiffrés
  const f = node('discussion.panneau.git.detail.fichier')!;
  expect(f.querySelector('.ajouts')?.textContent).toBe('');
  expect(f.querySelector('.suppressions')?.textContent).toBe('');
});

test('chantier 19, S.1 : modifiés inconnus (git status en échec) — dit tel quel, jamais « 0 modifié »', async () => {
  ouvrir(
    { open: true, tab: 'git' },
    { [LOG('~/app')]: json(200, journal({ repo: depot({ changes: null }), dirty: true })) },
  );
  await waitFor(() =>
    expect(node('discussion.panneau.git.modifies')?.textContent).toBe('modifiés : inconnu'),
  );
});

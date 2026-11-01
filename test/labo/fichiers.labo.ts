import { expect, test } from 'vitest';
import type { ServerGitLog, ServerGitStatus } from '../../src/shared/git.js';
import type { ServerFilePreview, ServerFsListing } from '../../src/shared/model.js';
import { monterBanc } from './daemon-labo.js';

/**
 * Chantier 18, L.5 : le panneau Fichiers et Git (chantier 17, F) sur un vrai dépôt du serveur, lu par le
 * vrai ssh avec le vrai git du conteneur — lecture seule, secrets masqués, fetch.
 */
const b = monterBanc();
const { daemon, creerServeur } = b;
const q = encodeURIComponent;

/** Le dépôt du serveur : `~/proj` cloné d'un dépôt nu `~/origin.git`, un second clone pour avancer origin. */
function depot(): void {
  b.labo().exec(
    [
      'set -e',
      'cd ~',
      'rm -rf proj origin.git autre',
      'git config --global user.email labo@aid.test',
      'git config --global user.name labo',
      'git init -q --bare -b main origin.git',
      'mkdir proj && cd proj && git init -q -b main',
      "printf '# Projet\\n' > README.md && mkdir src && echo a > src/a.txt",
      'git add -A && git commit -qm initial',
      'git remote add origin ~/origin.git && git push -q -u origin main',
      "printf 'changé\\n' > README.md && echo n > nouveau.txt",
      "printf 'SECRET=ne-doit-jamais-sortir\\n' > .env && cp .env id_ed25519",
    ].join('\n'),
    'aid',
  );
}

test('fichiers et git sur un vrai dépôt : liste, aperçu, secrets masqués, état, journal, fetch, coupure', async () => {
  depot();
  const m = await daemon();
  const s = await creerServeur(m);
  expect((await m.req('PATCH', `/api/servers/${s.id}`, { workdir: '~/proj' })).statusCode).toBe(
    200,
  );
  const get = (url: string) => m.req('GET', url);

  const l = (await get(`/api/servers/${s.id}/fs`)).json<ServerFsListing>();
  expect(l).toMatchObject({
    path: '~/proj',
    resolved: '/home/aid/proj',
    git: true,
    // chantier 19, S.3 : le vrai git status a abouti
    gitPartial: false,
    truncated: false,
  });
  const by = new Map(l.entries.map((e) => [e.name, e]));
  expect(by.get('src')).toMatchObject({ kind: 'dir', git: null });
  expect(by.get('README.md')).toMatchObject({ kind: 'file', git: 'M' });
  expect(by.get('nouveau.txt')).toMatchObject({ kind: 'file', git: '?' });
  expect(by.get('.env')).toMatchObject({ hidden: true });
  expect(by.get('id_ed25519')).toMatchObject({ hidden: true });

  const readme = (
    await get(`/api/servers/${s.id}/file?path=${q('~/proj/README.md')}`)
  ).json<ServerFilePreview>();
  expect(readme).toMatchObject({
    resolved: '/home/aid/proj/README.md',
    binary: false,
    content: 'changé\n',
  });
  for (const path of ['~/proj/.env', '~/proj/id_ed25519']) {
    const r = await get(`/api/servers/${s.id}/file?path=${q(path)}`);
    expect(r.statusCode, path).toBe(403);
    expect(r.body).not.toContain('ne-doit-jamais-sortir');
  }
  expect((await get(`/api/servers/${s.id}/fs?path=${q('/etc')}`)).statusCode).toBe(403);

  const head = b.labo().exec('git -C ~/proj rev-parse HEAD', 'aid').trim();
  const st = (await get(`/api/servers/${s.id}/git/status`)).json<ServerGitStatus>();
  expect(st.repo).toEqual({
    root: '/home/aid/proj',
    branch: 'main',
    head,
    // chantier 20 : les deux secrets non suivis (`.env`, `id_ed25519`) ne comptent plus
    changes: 2,
    origin: true,
    upstream: 'origin/main',
    aheadBehind: { ahead: 0, behind: 0 },
    operation: null,
  });
  const log = (await get(`/api/servers/${s.id}/git/log`)).json<ServerGitLog>();
  expect(log.commits.map((c) => c.message)).toEqual(['initial']);
  expect(log.dirty).toBe(true);

  // origin avance depuis un autre clone : le retard n'apparaît qu'après un fetch, sans toucher à l'arbre
  b.labo().exec(
    'cd ~ && git clone -q origin.git autre && cd autre && echo d > distant.txt && git add -A && git commit -qm distant && git push -q',
    'aid',
  );
  expect((await get(`/api/servers/${s.id}/git/status`)).json<ServerGitStatus>().repo).toMatchObject(
    {
      aheadBehind: { ahead: 0, behind: 0 },
    },
  );
  const f = await m.req('POST', `/api/servers/${s.id}/git/fetch`, {});
  expect(f.statusCode, f.body).toBe(200);
  expect(f.json<ServerGitStatus>().repo).toMatchObject({ aheadBehind: { ahead: 0, behind: 1 } });
  expect(
    b.labo().exec('cat ~/proj/README.md; test ! -e ~/proj/distant.txt && echo absent', 'aid'),
  ).toBe('changé\nabsent\n');
  // lecture seule : le panneau n'a rien écrit dans l'index du dépôt
  expect(b.labo().exec('git -C ~/proj status --porcelain', 'aid')).toBe(
    ' M README.md\n?? .env\n?? id_ed25519\n?? nouveau.txt\n',
  );

  b.labo().couper();
  const coupe = await get(`/api/servers/${s.id}/fs`);
  expect(coupe.statusCode).toBe(502);
  expect(coupe.json<{ error: string }>().error).toMatch(/labo ne répond pas/);
});

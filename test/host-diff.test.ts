import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, expect, test } from 'vitest';
import { parseConfig } from '../src/daemon/config.js';
import { RegistreAppareils } from '../src/daemon/host/appareils.js';
import { Appairages } from '../src/daemon/host/appairage.js';
import { ouvrirServeurAppareils, COOKIE_APPAREIL } from '../src/daemon/host/serveur.js';
import { gitLivraison } from '../src/daemon/git/inspect.js';
import { startTestDaemon, type TestDaemon } from './helpers/daemon.js';
import { commitFile, makeOriginAndClone, sh } from './helpers/git.js';

let t: TestDaemon;
let racine: string;
const fermetures: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fermer of fermetures.splice(0)) await fermer();
  await t?.d.stop();
  if (racine) rmSync(racine, { recursive: true, force: true });
  if (t) rmSync(t.home, { recursive: true, force: true });
});

async function preparer() {
  const nom = 'aid-e2e.ts.net';
  t = await startTestDaemon();
  racine = mkdtempSync(join(tmpdir(), 'aid-diff-'));
  const { clone } = makeOriginAndClone(racine);
  t.db
    .prepare(
      `INSERT INTO workspaces (id,name,root,base_branch,worktrees_dir,created_at)
    VALUES ('w','exemple',?,'main',?,'2026-01-01')`,
    )
    .run(clone, racine);
  t.db
    .prepare(
      `INSERT INTO topics
    (id,workspace_id,slug,title,type,branch,base,worktree,state,index_state,created_at,updated_at)
    VALUES ('s','w','sujet','Sujet','feat','main','main',?,'active','disabled','2026-01-01','2026-01-01')`,
    )
    .run(clone);
  const registre = new RegistreAppareils(t.db);
  const { jeton, appareil } = registre.emettre({ nom: 'Téléphone', identite: null });
  let actif = false;
  let journal = '';
  const serveur = await ouvrirServeurAppareils({
    port: 0,
    interdits: [],
    nom: () => nom,
    registre,
    appairages: new Appairages(),
    webRoot: null,
    code: { db: t.db, actif: () => actif },
    logStream: new Writable({
      write(bloc, _enc, suite) {
        journal += String(bloc);
        suite();
      },
    }),
  });
  if (!serveur.disponible) throw new Error('serveur indisponible');
  fermetures.push(() => serveur.app.close());
  const headers = { host: nom, 'x-aid-cockpit': '1', cookie: `${COOKIE_APPAREIL}=${jeton}` };
  const lire = (index: string | number, tete = sh(clone, 'rev-parse', 'HEAD'), entetes = headers) =>
    serveur.app.inject({
      url: `/api/appareils/sujets/s/fichiers/${index}/diff?tete=${tete}`,
      headers: entetes,
    });
  const index = async (chemin: string) =>
    (await gitLivraison(clone, 'main')).files.findIndex((f) => f.path === chemin);
  return {
    clone,
    lire,
    index,
    headers,
    appareil,
    journal: () => journal,
    activer: () => {
      actif = true;
    },
  };
}

test('32b.7 : interrupteur fermé, validation stricte, péremption, bornes et gardes', async () => {
  const p = await preparer();
  commitFile(p.clone, 'normal.txt', 'bonjour\n');
  const ferme = await p.lire(0);
  expect(ferme.statusCode).toBe(403);
  expect(ferme.json()).toEqual({ raison: 'code_coupe' });
  expect(ferme.headers['cache-control']).toBe('no-store');
  p.activer();
  for (const index of ['-1', '1.5', 'abc', '01', '9007199254740992']) {
    const r = await p.lire(index);
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ raison: 'requete' });
    expect(r.headers['cache-control']).toBe('no-store');
  }
  const mal = await p.lire(0, 'abc');
  expect(mal.statusCode).toBe(400);
  expect(mal.json()).toEqual({ raison: 'requete' });
  expect((await p.lire(999)).json()).toEqual({ raison: 'fichier' });
  expect((await p.lire(999)).statusCode).toBe(404);
  expect((await p.lire(0, '0'.repeat(40))).statusCode).toBe(409);
  expect((await p.lire(0, '0'.repeat(40))).json()).toEqual({ raison: 'perimee' });
  expect((await p.lire(0, undefined, { ...p.headers, cookie: '' })).statusCode).toBe(401);
  expect((await p.lire(0, undefined, { ...p.headers, host: 'example.com' })).statusCode).toBe(421);
});

test('32b.7 : diff filtré, journal sans chemin ni contenu, no-store', async () => {
  const p = await preparer();
  const chemin = 'nom-confidentiel.txt';
  commitFile(p.clone, chemin, 'bonjour-confidentiel\npassword: hunter2\n');
  p.activer();
  const r = await p.lire(await p.index(chemin));
  expect(r.statusCode).toBe(200);
  expect(r.headers['cache-control']).toBe('no-store');
  expect(r.json().etat).toBe('ok');
  expect(r.json().lignes).toContain('+password: [masqué]');
  expect(r.body).not.toContain('hunter2');
  const entrees = p
    .journal()
    .trim()
    .split('\n')
    .map((ligne) => JSON.parse(ligne));
  expect(entrees).toContainEqual(
    expect.objectContaining({
      msg: 'appareil.lecture_code',
      appareilId: p.appareil.id,
      topicId: 's',
      index: 0,
      etat: 'ok',
    }),
  );
  for (const secret of [chemin, 'bonjour-confidentiel', 'hunter2'])
    expect(p.journal()).not.toContain(secret);
});

test('32b.7 : .env modifié et renommage sensible, suppression filtrée de l’ancien chemin', async () => {
  const p = await preparer();
  commitFile(p.clone, '.env', 'password: ancien\n');
  commitFile(p.clone, 'config.ts', 'password: hunter2\n');
  sh(p.clone, 'push', 'origin', 'main');
  commitFile(p.clone, '.env', 'password: nouveau\n');
  sh(p.clone, 'mv', 'config.ts', '.env.local');
  sh(p.clone, 'commit', '-qm', 'renommage');
  p.activer();
  for (const chemin of ['.env', '.env.local']) {
    const r = await p.lire(await p.index(chemin));
    expect(r.json()).toEqual({ etat: 'sensible' });
  }
  const suppression = (await p.lire(await p.index('config.ts'))).json();
  expect(suppression.etat).toBe('ok');
  expect(suppression.lignes).toContain('-password: [masqué]');
  expect(JSON.stringify(suppression)).not.toContain('hunter2');
});

test('32b.7 : fichier binaire sans contenu', async () => {
  const p = await preparer();
  writeFileSync(join(p.clone, 'image.bin'), Buffer.from([0, 1, 2, 3]));
  sh(p.clone, 'add', '.');
  sh(p.clone, 'commit', '-qm', 'binaire');
  p.activer();
  expect((await p.lire(await p.index('image.bin'))).json()).toEqual({ etat: 'binaire' });
});

test('32b.7 : plafond de lignes et d’octets, contenu coupé toujours filtré', async () => {
  const p = await preparer();
  commitFile(p.clone, 'long.txt', 'password: hunter2\n'.repeat(2500));
  commitFile(p.clone, 'large.txt', 'password: hunter2\n' + 'x'.repeat(220000));
  p.activer();
  for (const chemin of ['long.txt', 'large.txt']) {
    const r = (await p.lire(await p.index(chemin))).json();
    expect(r.etat).toBe('coupe');
    expect(r.lignes.length).toBeLessThanOrEqual(2000);
    expect(r.lignes).toContain('+password: [masqué]');
    expect(JSON.stringify(r)).not.toContain('hunter2');
  }
});

test.each(['textconv', 'command'])(
  '32b.7 : attributs piégés, pilote %s jamais exécuté',
  async (pilote) => {
    const p = await preparer();
    const marqueur = join(p.clone, 'marqueur');
    writeFileSync(join(p.clone, '.gitattributes'), '* diff=piege\n');
    sh(p.clone, 'config', `diff.piege.${pilote}`, 'touch marqueur');
    sh(p.clone, 'config', 'diff.external', 'touch marqueur');
    commitFile(p.clone, 'normal.txt', 'bonjour\n');
    p.activer();
    const r = await p.lire(await p.index('normal.txt'));
    expect(r.statusCode).toBe(200);
    expect(r.json().etat).toBe('ok');
    expect(r.json().lignes).toContain('+bonjour');
    expect(existsSync(marqueur)).toBe(false);
  },
);

test('32b.7 : réglage du Mac persistant et validation du booléen', async () => {
  await preparer();
  expect(parseConfig('').modeHost.code).toBe(false);
  const basculer = (actif: unknown) =>
    t.d.app.inject({
      method: 'PUT',
      url: '/api/host/code',
      headers: t.headers,
      payload: { actif },
    });
  expect((await basculer('oui')).statusCode).toBe(400);
  expect((await t.d.app.inject({ url: '/api/host', headers: t.headers })).json().code).toBe(false);
  expect((await basculer(true)).json().code).toBe(true);
  expect(parseConfig(readFileSync(join(t.home, 'config.yaml'), 'utf8')).modeHost.code).toBe(true);
  expect((await basculer(false)).json().code).toBe(false);
});

test('32b.7 : chemins git exacts, noms sensibles cités et pathspec littéral', async () => {
  const p = await preparer();
  commitFile(p.clone, '.envé', 'contenu-confidentiel');
  commitFile(p.clone, '.env\nlocal', 'contenu-confidentiel');
  commitFile(p.clone, 'avec\ttab.txt', 'bonjour');
  commitFile(p.clone, '*.txt', 'fichier littéral');
  commitFile(p.clone, 'autre.txt', 'autre fichier');
  p.activer();
  for (const chemin of ['.envé', '.env\nlocal'])
    expect((await p.lire(await p.index(chemin))).json()).toEqual({ etat: 'sensible' });
  expect((await p.lire(await p.index('avec\ttab.txt'))).json().lignes).toContain('+bonjour');
  const r = await p.lire(await p.index('*.txt'));
  expect(r.json().lignes).toContain('+fichier littéral');
  expect(r.body).not.toContain('autre fichier');
});

test.each(['textconv', 'command'])(
  '32b.11 : gitLivraison refuse le pilote %s directement',
  async (pilote) => {
    racine = mkdtempSync(join(tmpdir(), 'aid-livraison-'));
    const { clone } = makeOriginAndClone(racine);
    writeFileSync(join(clone, '.gitattributes'), '* diff=piege\n');
    sh(clone, 'config', `diff.piege.${pilote}`, 'touch marqueur');
    sh(clone, 'config', 'diff.external', 'touch marqueur');
    commitFile(clone, 'normal.txt', 'bonjour\n');
    const livraison = await gitLivraison(clone, 'main');
    expect(livraison.files).toContainEqual({
      path: 'normal.txt',
      status: 'A',
      additions: 1,
      deletions: 0,
    });
    expect(livraison.empreinte).toMatch(/^[a-f0-9]{8}$/);
    expect(existsSync(join(clone, 'marqueur'))).toBe(false);
  },
);

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { RegistreAppareils } from '../src/daemon/host/appareils.js';
import { COOKIE_APPAREIL } from '../src/daemon/host/serveur.js';
import { blocageMerge, lirePr } from '../src/shared/livraison.js';
import { startTestDaemon, type TestDaemon } from './helpers/daemon.js';
import { commitFile, makeOriginAndClone, sh } from './helpers/git.js';

let t: TestDaemon;
let racine: string;
afterEach(async () => {
  await t?.d.stop();
  if (racine) rmSync(racine, { recursive: true, force: true });
});

async function preparer() {
  const nom = 'aid-e2e.ts.net';
  t = await startTestDaemon(undefined, {
    tailscaleExec: async (_bin, args) => ({
      stdout:
        args[0] === 'status'
          ? JSON.stringify({
              BackendState: 'Running',
              Self: { DNSName: `${nom}.`, UserID: 1 },
              User: {},
            })
          : '',
      code: null,
    }),
  });
  racine = mkdtempSync(join(tmpdir(), 'aid-livraison-appareil-'));
  const { clone } = makeOriginAndClone(racine);
  t.db
    .prepare(
      `INSERT INTO workspaces (id,name,root,base_branch,worktrees_dir,created_at) VALUES ('w','exemple',?,'main',?,'2026-01-01')`,
    )
    .run(clone, racine);
  t.db
    .prepare(
      `INSERT INTO topics (id,workspace_id,slug,title,type,branch,base,worktree,state,index_state,created_at,updated_at,pr_number) VALUES ('s','w','sujet','Sujet','feat','main','main',?,'active','disabled','2026-01-01','2026-01-01',42)`,
    )
    .run(clone);
  await t.d.app.inject({
    method: 'PUT',
    url: '/api/host',
    headers: t.headers,
    payload: { actif: true },
  });
  const { jeton } = new RegistreAppareils(t.db).emettre({ nom: 'Téléphone', identite: null });
  const headers = { host: nom, 'x-aid-cockpit': '1', cookie: `${COOKIE_APPAREIL}=${jeton}` };
  const lire = (id = 's', cookie = true) =>
    t.d.modeHost.instance()!.inject({
      url: `/api/appareils/sujets/${id}/livraison`,
      headers: cookie ? headers : { ...headers, cookie: '' },
    });
  return { clone, lire };
}

function action(
  result: Record<string, unknown> | null,
  state = 'succeeded',
  nom = 'pr.rafraichir',
  id = 'pr',
) {
  t.db
    .prepare(
      "INSERT OR REPLACE INTO actions (id,topic_id,workspace_id,action,state,result,started_at) VALUES (?,'s','w',?,?,?,?)",
    )
    .run(id, nom, state, JSON.stringify(result), id);
}

test('32.7 : contrat fermé, filtrage, authentification et aucune action lancée', async () => {
  const { clone, lire } = await preparer();
  mkdirSync(join(clone, 'src'));
  commitFile(clone, 'src/exemple.txt', 'bonjour');
  const head = sh(clone, 'rev-parse', 'HEAD');
  action({
    number: 42,
    state: 'OPEN',
    headRefOid: head,
    statusCheckRollup: [
      { name: `${clone} /tmp/secret https://example.com`, conclusion: 'FAILURE' },
    ],
  });
  action({ head }, 'failed', 'topic.test', 'test');
  const avant = t.store.since(null).filter((e) => e.type === 'action.started').length;
  const r = await lire();
  expect(r.statusCode).toBe(200);
  const corps = r.json();
  expect(Object.keys(corps).sort()).toEqual(
    ['head', 'fichiers', 'controles', 'revue', 'blocage', 'citations', 'prNumber'].sort(),
  );
  expect(corps.fichiers).toEqual([{ nom: 'src/exemple.txt', ajouts: 1, retraits: 0 }]);
  expect(Object.keys(corps.controles[0]).sort()).toEqual(['etat', 'nom']);
  expect(corps.revue).toEqual({ etat: 'aucune', surLaTete: false });
  for (const secret of [clone, racine, '/tmp/secret', 'https://example.com'])
    expect(JSON.stringify(corps)).not.toContain(secret);
  expect(corps.citations).toEqual(['Aucune revue', '2 contrôles en panne']);
  expect((await lire('absent')).statusCode).toBe(404);
  expect((await lire('s', false)).statusCode).toBe(401);
  expect(t.store.since(null).filter((e) => e.type === 'action.started')).toHaveLength(avant);
  t.db.prepare("UPDATE topics SET branch = '' WHERE id = 's'").run();
  expect((await lire()).json()).toMatchObject({
    fichiers: [],
    blocage: 'le sujet n’a pas de branche.',
  });
  t.db.prepare("UPDATE topics SET worktree = ? WHERE id = 's'").run(join(racine, 'absent'));
  expect((await lire()).json()).toMatchObject({
    fichiers: [],
    blocage: 'le worktree du sujet manque.',
  });
});

test('32.7 : les raisons de blocage sont celles du Mac et seule la dernière PR réussie compte', async () => {
  const { clone, lire } = await preparer();
  const head = sh(clone, 'rev-parse', 'HEAD');
  const base = { number: 42, state: 'OPEN', headRefOid: head, mergeable: 'MERGEABLE' };
  for (const cas of [
    { fusionne: false, aPr: true, pr: base },
    { fusionne: true, aPr: true, pr: base },
    { fusionne: false, aPr: true, pr: { ...base, state: 'MERGED' } },
    { fusionne: false, aPr: true, pr: { ...base, state: 'CLOSED' } },
    { fusionne: false, aPr: false, pr: null },
    { fusionne: false, aPr: true, pr: null },
    { fusionne: false, aPr: true, pr: { ...base, headRefOid: '0dd8bb4' } },
    { fusionne: false, aPr: true, pr: { ...base, mergeable: 'CONFLICTING' } },
  ]) {
    t.db.prepare('DELETE FROM actions').run();
    action(cas.pr);
    action({ ...base, state: 'CLOSED' }, 'failed', 'pr.rafraichir', 'zzz');
    t.db
      .prepare("UPDATE topics SET state = ?, pr_number = ? WHERE id = 's'")
      .run(cas.fusionne ? 'merged' : 'active', cas.aPr ? 42 : null);
    expect((await lire()).json().blocage).toBe(
      blocageMerge({ ...cas, pr: lirePr(cas.pr), teteLocale: head, fraicheur: { etat: 'aucune' } }),
    );
  }
});

test('32.7 : revue mémoire sur HEAD, obsolète ou sans tête, comme sur le Mac', async () => {
  const { clone, lire } = await preparer();
  const ancien = sh(clone, 'rev-parse', 'HEAD');
  commitFile(clone, 'nouveau.txt', 'nouveau');
  const head = sh(clone, 'rev-parse', 'HEAD');
  action({ number: 42, state: 'OPEN', headRefOid: head, mergeable: 'CONFLICTING' });
  for (const [commit, etat, blocage] of [
    [ancien, 'obsolete', 'la revue ne porte pas sur cette tête.'],
    ['deadbeef', 'obsolete', 'la revue ne porte pas sur cette tête.'],
    [head, 'a-jour', 'GitHub signale un conflit avec la base.'],
    ['', 'sans-tete', 'GitHub signale un conflit avec la base.'],
  ]) {
    const ecriture = await t.d.app.inject({
      method: 'PUT',
      url: '/api/memory/pages/exemple/review/sujet',
      headers: t.headers,
      payload: { text: commit ? `---\ncommit: ${commit}\n---\n\nRevue.` : 'Revue.', mode: 'force' },
    });
    expect([200, 201]).toContain(ecriture.statusCode);
    const corps = (await lire()).json();
    expect(corps.revue).toEqual({ etat, surLaTete: etat === 'a-jour' });
    expect(corps.blocage).toBe(blocage);
  }
  // Un dépôt sans commit donne bien la même raison que le Mac.
  sh(clone, 'update-ref', '-d', 'refs/heads/main');
  expect((await lire()).json().blocage).toBe('la tête locale est inconnue.');
});

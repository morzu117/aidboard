import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { creer as creerBoucle } from '../src/daemon/boucle/depot.js';
import type { Tentative } from '../src/daemon/boucle/etat.js';
import { livraisonPourAppareil } from '../src/daemon/host/livraison.js';
import { issueRunToken } from '../src/daemon/security.js';
import { seedTopic, startTestDaemon, type TestDaemon } from './helpers/daemon.js';
import { commitFile, makeOriginAndClone, sh } from './helpers/git.js';

const sujet = 'tp_1';
const page = 'exemple/review/s';
let racine: string;
let daemon: TestDaemon | undefined;
let depot: string;
let tete: string;
let tetePrecedente: string;

beforeEach(async () => {
  racine = mkdtempSync(join(tmpdir(), 'aid-livraison-boucle-'));
  const home = join(racine, 'home');
  mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('AID_HOME', join(home, 'aid'));
  ({ clone: depot } = makeOriginAndClone(racine));
  tetePrecedente = sh(depot, 'rev-parse', 'HEAD');
  commitFile(depot, 'note.md', 'Note fictive.');
  tete = sh(depot, 'rev-parse', 'HEAD');
  daemon = await startTestDaemon(join(home, 'aid'));
  const { db } = daemon;
  seedTopic(db);
  db.prepare(
    "UPDATE workspaces SET namespace = 'exemple', root = ?, worktrees_dir = ? WHERE id = 'ws_1'",
  ).run(depot, racine);
  db.prepare('UPDATE topics SET worktree = ?, pr_number = 42 WHERE id = ?').run(depot, sujet);
  db.prepare(
    `INSERT INTO actions (id,topic_id,workspace_id,action,state,result,started_at)
     VALUES ('pr',?,'ws_1','pr.rafraichir','succeeded',?,'2026-01-01')`,
  ).run(
    sujet,
    JSON.stringify({ number: 42, state: 'OPEN', headRefOid: tete, mergeable: 'MERGEABLE' }),
  );
});

afterEach(async () => {
  try {
    await daemon?.d.stop();
  } finally {
    daemon = undefined;
    vi.unstubAllEnvs();
    rmSync(racine, { recursive: true, force: true });
  }
});

function consigner(...verdicts: { tete: string; issue: 'pass' | 'fail' }[]) {
  const dernier = verdicts.at(-1) ?? null;
  const etapes: Tentative[] = verdicts.map((verdict, index) => ({
    type: 'revue',
    tentative: index + 1,
    debut: index * 2,
    fin: index * 2 + 1,
    echeance: null,
    agentId: null,
    teteDepart: verdict.tete,
    teteArrivee: verdict.tete,
    issue: verdict.issue,
  }));
  creerBoucle(daemon!.db, {
    id: 'boucle-fictive',
    sujetId: sujet,
    etat: {
      phase: dernier?.issue === 'pass' ? 'livraison_prete' : 'escalade',
      tete,
      redevCap: 2,
      redevs: 0,
      acceptation: false,
      empreintePlan: null,
      gate: { tete, issue: 'pass' },
      revue: dernier,
      etapes,
    },
  });
}

async function ecrirePageDepuisAutreJeton() {
  const { d, headers } = daemon!;
  const jeton = issueRunToken(d.auth, 'run_1');
  const verdict = { tete, verdicts: { fichiers: { 'note.md': 'pass' }, points: {} }, findings: [] };
  const texte = [
    '---',
    `commit: ${tete}`,
    '---',
    '',
    '```json',
    JSON.stringify(verdict),
    '```',
  ].join('\n');
  const reponse = await d.app.inject({
    method: 'PUT',
    url: `/api/memory/pages/${page}`,
    headers: { ...headers, authorization: `Bearer ${jeton}` },
    payload: { text: texte, mode: 'create' },
  });
  expect([200, 201]).toContain(reponse.statusCode);
  expect(d.memory.get(page)?.frontmatter.commit).toBe(tete);
}

const lire = () => livraisonPourAppareil(daemon!.db, daemon!.d.memory, sujet);

async function verifierBlocage() {
  const livraison = await lire();
  expect.soft(livraison?.revue.surLaTete).toBe(false);
  expect(livraison?.blocage).toEqual(expect.any(String));
}

test('une page tout-pass à HEAD écrite par un autre jeton ne qualifie pas la revue de boucle', async () => {
  consigner();
  await ecrirePageDepuisAutreJeton();
  await verifierBlocage();
});

test('un pass de boucle à HEAD qualifie la revue et permet le merge sans page', async () => {
  consigner({ tete, issue: 'pass' });
  expect(await lire()).toMatchObject({
    revue: { etat: 'a-jour', surLaTete: true },
    blocage: null,
  });
});

test('un dernier fail de boucle à HEAD garde le blocage malgré un pass précédent et une page tout-pass', async () => {
  consigner({ tete, issue: 'pass' }, { tete, issue: 'fail' });
  await ecrirePageDepuisAutreJeton();
  await verifierBlocage();
});

test('un pass de boucle sur une tête précédente ne qualifie pas la revue à HEAD', async () => {
  consigner({ tete: tetePrecedente, issue: 'pass' });
  await verifierBlocage();
});

test('un sujet sans boucle garde la revue mémoire à HEAD', async () => {
  await ecrirePageDepuisAutreJeton();
  expect(await lire()).toMatchObject({
    revue: { etat: 'a-jour', surLaTete: true },
    blocage: null,
  });
});

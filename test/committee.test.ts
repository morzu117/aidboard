import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { CommitteeReader, VERBES_COMMITTEE } from '../src/daemon/mesh/committee.js';
import { meshExec } from '../src/daemon/mesh/exec.js';
import {
  lireMotion,
  lireResultats,
  versBulletinsAvis,
  ErreurFormatCommittee,
} from '../src/shared/committee.js';
import { VERBES_LECTURE } from '../src/daemon/mesh/proxy.js';

const motion = {
  id: 42,
  text: 'Question ?',
  options: ['repondu', 'sans_avis'],
  phase: 'positions',
  positions_deadline: '2026-11-12T12:00:00Z',
  rebuttal_deadline: '2026-11-13T13:00:00Z',
  vote_deadline: '2026-11-13T14:00:00Z',
};
const bulletin = {
  peer: 'cell-a',
  round: 'positions',
  created_at: '2026-11-11T12:00:00Z',
  voided: false,
  placeholder: 'exemple',
  message_id: 10,
};
const scelles = {
  baseline_absent: null,
  ...motion,
  channel: 'avis-test',
  card_id: 1,
  seats: [{ peer: 'cell-a', role: 'seat', family: 'test', voided: false, recast_from: null }],
  ballots: [bulletin],
};
const ouverts = {
  ...scelles,
  seats: [
    ...scelles.seats,
    { peer: 'cell-b', role: 'seat', family: 'test', voided: false, recast_from: null },
  ],
  ballots: [
    { ...bulletin, body: 'secret suspecté', outcome: 'cannot_evaluate' },
    { ...bulletin, round: 'vote', voided: true, body: 'illisible', outcome: 'pass' },
  ],
};
const dossiers: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dossiers.splice(0)) rmSync(d, { recursive: true, force: true });
});
function faux() {
  const dossier = mkdtempSync(join(tmpdir(), 'committee-'));
  dossiers.push(dossier);
  writeFileSync(
    join(dossier, 'swarph'),
    `#!/bin/sh
case "$3" in
illisible) printf 'pas du JSON'; exit 0;;
ancien) printf "invalid choice: 'results'" >&2; exit 2;;
refus) printf 'gateway 403: not a seat' >&2; exit 1;;
esac
if [ "$2" = motion ]; then printf '%s' "$FAUX_MOTION"; else printf '%s' "$FAUX_RESULTATS"; fi
`,
    { mode: 0o755 },
  );
  vi.stubEnv('PATH', `${dossier}:${process.env.PATH}`);
  vi.stubEnv('FAUX_MOTION', JSON.stringify({ motions: [motion] }));
  vi.stubEnv('FAUX_RESULTATS', JSON.stringify(scelles));
  const appels: string[][] = [];
  const read = vi.fn((args: string[]) => {
    appels.push(args);
    return meshExec('swarph', args, {
      env: { ...process.env, AID_HOME: dossier },
      timeoutMs: 30_000,
    });
  });
  return { lecteur: new CommitteeReader({ mesh: { read }, cell: 'cell-test' }), read, appels };
}
test('faux swarph : motion, scellé et argv exacts sans consommation', async () => {
  const t = faux();
  expect(await t.lecteur.motionOuverte('avis-test')).toMatchObject({ ok: true, data: motion });
  const r = await t.lecteur.resultats('avis-test', 42);
  expect(r.ok && versBulletinsAvis(r.data)).toEqual([
    { cell: 'cell-a', tour: 'positions', outcome: null, corps: null, annule: false },
  ]);
  expect(t.appels).toEqual([
    ['committee', 'motion', 'avis-test', '--json', '--as', 'cell-test'],
    ['committee', 'results', 'avis-test', '--motion', '42', '--json', '--as', 'cell-test'],
  ]);
  for (const argv of t.appels)
    for (const interdit of ['inbox', '--consume', 'mark_read'])
      expect(argv).not.toContain(interdit);
});
test('faux swarph : résultats ouverts, abstention, annulé et siège sans bulletin', async () => {
  const t = faux();
  vi.stubEnv('FAUX_RESULTATS', JSON.stringify(ouverts));
  const r = await t.lecteur.resultats('avis-test', 42);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.data.seats).toHaveLength(2);
  expect(versBulletinsAvis(r.data)).toEqual([
    {
      cell: 'cell-a',
      tour: 'positions',
      outcome: 'cannot_evaluate',
      corps: 'secret suspecté',
      annule: false,
    },
    { cell: 'cell-a', tour: 'vote', outcome: 'pass', corps: 'illisible', annule: true },
  ]);
});
test.each([
  ['illisible', 'format'],
  ['ancien', 'too-old'],
  ['refus', 'refus'],
])('faux swarph : %s donne %s', async (canal, kind) => {
  expect(await faux().lecteur.resultats(canal, 42)).toMatchObject({ ok: false, kind });
});
test('proxy : verbes déclarés, non relayés, aucun lancement', async () => {
  expect(VERBES_COMMITTEE).toEqual(['committee.motions.list', 'committee.motion.get']);
  const t = faux();
  const lecteur = new CommitteeReader({
    mesh: { read: t.read },
    cell: 'cell-test',
    proxySocket: '/tmp/proxy-inutilise.sock',
  });
  expect(await lecteur.motionOuverte('avis-test')).toMatchObject({ ok: false, kind: 'non-relaye' });
  expect(await lecteur.resultats('avis-test', 42)).toMatchObject({ ok: false, kind: 'non-relaye' });
  expect(t.read).not.toHaveBeenCalled();
  for (const verbe of VERBES_COMMITTEE) expect(VERBES_LECTURE).not.toContain(verbe);
});
test('canal et motion invalides refusés avant lancement', () => {
  const t = faux();
  for (const canal of ['MAJUSCULE', 'a.b', 'a'.repeat(65), '', '../test', 'test;id', 'test\n'])
    expect(() => t.lecteur.motionOuverte(canal)).toThrow(RangeError);
  for (const id of [0, -1, 1.5, '--help', '42;id'])
    expect(() => t.lecteur.resultats('avis-test', id)).toThrow(RangeError);
  expect(t.read).not.toHaveBeenCalled();
});
test('erreurs de transport : absent et timeout', async () => {
  for (const [surcharge, kind] of [
    [{ spawnErrorCode: 'ENOENT' }, 'absent'],
    [{ timedOut: true }, 'timeout'],
  ] as const) {
    const lecteur = new CommitteeReader({
      cell: 'cell-test',
      mesh: {
        read: async () => ({ ok: false, stdout: '', stderr: '', timedOut: false, ...surcharge }),
      },
    });
    expect(await lecteur.resultats('avis-test', 42)).toMatchObject({ ok: false, kind });
  }
});
test('lecture défensive : inconnus ignorés, champs attendus contrôlés sans valeur dans erreur', () => {
  expect(lireMotion({ motions: [] })).toBeNull();
  expect(lireMotion({ motions: [{ ...motion, inconnu: 'test' }] })).toEqual(motion);
  expect(() => lireMotion({ motions: [motion, motion] })).toThrow(ErreurFormatCommittee);
  for (const cle of Object.keys(motion)) {
    const m: Record<string, unknown> = { ...motion };
    delete m[cle];
    expect(() => lireMotion({ motions: [m] })).toThrow(ErreurFormatCommittee);
  }
  for (const cle of Object.keys(bulletin)) {
    expect(() => lireResultats({ ...scelles, ballots: [{ ...bulletin, [cle]: null }] })).toThrow(
      ErreurFormatCommittee,
    );
  }
  for (const surcharge of [
    { body: 42 },
    { outcome: 'valeur-sensible' },
    { round: 'valeur-sensible' },
  ]) {
    expect(() => lireResultats({ ...scelles, ballots: [{ ...bulletin, ...surcharge }] })).toThrow(
      ErreurFormatCommittee,
    );
    expect(() =>
      lireResultats({ ...scelles, ballots: [{ ...bulletin, ...surcharge }] }),
    ).not.toThrow(/valeur-sensible/);
  }
  expect(lireResultats({ ...scelles, inconnu: 'ignoré' }).ballots[0]?.body).toBeNull();
});

test('faux swarph : déclaration du baseline et positions absentes, raison bornée', async () => {
  const t = faux();
  const declaration = { reason: '😀'.repeat(301), by: 'cell-chair', at: '2026-11-12T12:00:00Z' };
  vi.stubEnv(
    'FAUX_RESULTATS',
    JSON.stringify({ ...scelles, baseline_absent: declaration, positions_absent: ['cell-a'] }),
  );
  const r = await t.lecteur.resultats('avis-test', 42);
  expect(r).toMatchObject({
    ok: true,
    data: {
      baseline_absent: { ...declaration, reason: '😀'.repeat(300) },
      positions_absent: ['cell-a'],
    },
  });
  expect(lireResultats(scelles)).toMatchObject({ baseline_absent: null, positions_absent: [] });
});
test.each([
  undefined,
  42,
  'absent',
  [],
  {},
  { reason: 1, by: 'cell-chair', at: '2026-11-12T12:00:00Z' },
  { reason: 'Exemple', by: null, at: '2026-11-12T12:00:00Z' },
  { reason: 'Exemple', by: 'cell-chair', at: false },
])('déclaration mal formée refusée avec erreur nommée : %#', async (baseline_absent) => {
  expect(() => lireResultats({ ...scelles, baseline_absent })).toThrow(/baseline_absent/);
  const t = faux();
  vi.stubEnv('FAUX_RESULTATS', JSON.stringify({ ...scelles, baseline_absent }));
  expect(await t.lecteur.resultats('avis-test', 42)).toMatchObject({ ok: false, kind: 'format' });
});
test.each([
  ['reason', { reason: null, by: 'cell-chair', at: '2026-11-12T12:00:00Z' }],
  ['by', { reason: 'Exemple', by: 3, at: '2026-11-12T12:00:00Z' }],
  ['at', { reason: 'Exemple', by: 'cell-chair', at: [] }],
] as const)('erreur du champ baseline_absent.%s nommée', (champ, baseline_absent) => {
  expect(() => lireResultats({ ...scelles, baseline_absent })).toThrow(`baseline_absent.${champ}`);
});
test.each([undefined, [], ['cell-a', 'cell-b']])(
  'faux swarph : positions_absent absent, vide ou rempli : %#',
  async (positions_absent) => {
    const t = faux();
    vi.stubEnv('FAUX_RESULTATS', JSON.stringify({ ...scelles, positions_absent }));
    expect(await t.lecteur.resultats('avis-test', 42)).toMatchObject({
      ok: true,
      data: { positions_absent: positions_absent ?? [] },
    });
  },
);
test.each([null, 'cell-a', {}, [42], ['cell-a', null]])(
  'positions_absent mal formé refusé : %#',
  (positions_absent) => {
    expect(() => lireResultats({ ...scelles, positions_absent })).toThrow('positions_absent');
  },
);

test('results à plat : siège annulé avec recast et vote nu', () => {
  const r = lireResultats({
    ...scelles,
    seats: [
      ...scelles.seats,
      { peer: 'ancien', role: 'seat', family: 'test', voided: true, recast_from: 'cell-a' },
    ],
    ballots: [{ ...bulletin, round: 'vote', body: 'avis', outcome: 'pass' }],
  });
  expect(r.id).toBe(42);
  expect(r.seats.map((s) => s.peer)).toEqual(['cell-a']);
  expect(versBulletinsAvis(r)[0]?.corps).toBe('avis');
  expect(() => lireResultats({ ...scelles, id: undefined, motion })).toThrow(ErreurFormatCommittee);
});

test('refus gateway sur sortie 2', async () => {
  const lecteur = new CommitteeReader({
    cell: 'cell-test',
    mesh: {
      read: async () => ({
        ok: false,
        stdout: '',
        stderr: 'swarph committee: gateway 409: exemple',
        exitCode: 2,
        timedOut: false,
      }),
    },
  });
  expect(await lecteur.resultats('avis-test', 42)).toMatchObject({
    ok: false,
    status: 409,
    message: 'exemple',
  });
});

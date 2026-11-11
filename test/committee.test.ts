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
  rebuttal_deadline: null,
  vote_deadline: null,
};
const bulletin = {
  peer: 'cell-a',
  round: 'positions',
  created_at: '2026-11-11T12:00:00Z',
  cancelled: false,
  message_id: 10,
};
const scelles = {
  motion,
  seats: [{ peer: 'cell-a', role: 'seat', family: 'test' }],
  ballots: [bulletin],
};
const ouverts = {
  ...scelles,
  seats: [...scelles.seats, { peer: 'cell-b', role: 'seat', family: 'test' }],
  ballots: [
    { ...bulletin, body: 'secret suspecté', outcome: 'cannot_evaluate' },
    { ...bulletin, round: 'vote', cancelled: true, body: 'illisible', outcome: 'pass' },
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
  for (const canal of ['--help', '../test', 'test;id', 'test\n'])
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

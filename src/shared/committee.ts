import type { BulletinAvis } from './avis-mesh.js';
/**
 * committee.py transmet le JSON du gateway sans le modifier.
 * Le lab a confirmé baseline_absent {reason, by, at} et positions_absent (DM 96753).
 * positions_absent manque sur les anciens gateways : liste vide dans ce cas.
 * Recette : vérifier encore l'enveloppe motion/seats/ballots et l'id entier positif.
 * Ne jamais reconstituer un corps absent : il reste « scellé par le gateway » (D300).
 */
export type TourCommittee = 'positions' | 'rebuttal' | 'vote';
export interface MotionCommittee {
  id: number;
  text: string;
  options: string[];
  phase: string;
  positions_deadline: string;
  rebuttal_deadline: string | null;
  vote_deadline: string | null;
}
export interface AbsenceBaselineCommittee {
  reason: string;
  by: string;
  at: string;
}
export interface ResultatsCommittee {
  baseline_absent: AbsenceBaselineCommittee | null;
  positions_absent: string[];
  motion: MotionCommittee;
  seats: { peer: string; role: string; family: string }[];
  ballots: {
    peer: string;
    round: TourCommittee;
    created_at: string;
    cancelled: boolean;
    message_id: number;
    body: string | null;
    outcome: BulletinAvis['outcome'];
  }[];
}
export class ErreurFormatCommittee extends Error {
  constructor(champ: string) {
    super(`committee : format invalide : ${champ}`);
    this.name = 'ErreurFormatCommittee';
  }
}
function objet(v: unknown, champ: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ErreurFormatCommittee(champ);
  return v as Record<string, unknown>;
}
function texte(v: unknown, champ: string): string {
  if (typeof v !== 'string') throw new ErreurFormatCommittee(champ);
  return v;
}
function entier(v: unknown, champ: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0)
    throw new ErreurFormatCommittee(champ);
  return v;
}
function liste(v: unknown, champ: string): unknown[] {
  if (!Array.isArray(v)) throw new ErreurFormatCommittee(champ);
  return v;
}
function date(v: unknown, champ: string): string {
  const s = texte(v, champ);
  if (!Number.isFinite(Date.parse(s))) throw new ErreurFormatCommittee(champ);
  return s;
}
function motion(v: unknown): MotionCommittee {
  const m = objet(v, 'motion');
  return {
    id: entier(m.id, 'motion.id'),
    text: texte(m.text, 'motion.text'),
    options: liste(m.options, 'motion.options').map((o) => texte(o, 'motion.options')),
    phase: texte(m.phase, 'motion.phase'),
    positions_deadline: date(m.positions_deadline, 'motion.positions_deadline'),
    rebuttal_deadline:
      m.rebuttal_deadline === null ? null : date(m.rebuttal_deadline, 'motion.rebuttal_deadline'),
    vote_deadline: m.vote_deadline === null ? null : date(m.vote_deadline, 'motion.vote_deadline'),
  };
}
/** La liste des motions ouvertes est l'enveloppe effectivement lue par committee.py. */
export function lireMotion(v: unknown): MotionCommittee | null {
  const motions = liste(objet(v, 'motions').motions, 'motions');
  if (motions.length > 1) throw new ErreurFormatCommittee('motions');
  return motions.length === 0 ? null : motion(motions[0]);
}
function lireAbsenceBaseline(v: unknown): AbsenceBaselineCommittee | null {
  if (v === null) return null;
  const absence = objet(v, 'baseline_absent');
  return {
    reason: Array.from(texte(absence.reason, 'baseline_absent.reason')).slice(0, 300).join(''),
    by: texte(absence.by, 'baseline_absent.by'),
    at: texte(absence.at, 'baseline_absent.at'),
  };
}
export function lireResultats(v: unknown): ResultatsCommittee {
  const r = objet(v, 'resultats');
  return {
    baseline_absent: lireAbsenceBaseline(r.baseline_absent),
    positions_absent:
      r.positions_absent === undefined
        ? []
        : liste(r.positions_absent, 'positions_absent').map((v) => texte(v, 'positions_absent')),
    motion: motion(r.motion),
    seats: liste(r.seats, 'seats').map((v) => {
      const s = objet(v, 'seat');
      return {
        peer: texte(s.peer, 'seat.peer'),
        role: texte(s.role, 'seat.role'),
        family: texte(s.family, 'seat.family'),
      };
    }),
    ballots: liste(r.ballots, 'ballots').map((v) => {
      const b = objet(v, 'ballot');
      if (!['positions', 'rebuttal', 'vote'].includes(texte(b.round, 'ballot.round')))
        throw new ErreurFormatCommittee('ballot.round');
      if (typeof b.cancelled !== 'boolean') throw new ErreurFormatCommittee('ballot.cancelled');
      if (b.outcome != null && b.outcome !== 'pass' && b.outcome !== 'cannot_evaluate')
        throw new ErreurFormatCommittee('ballot.outcome');
      return {
        peer: texte(b.peer, 'ballot.peer'),
        round: b.round as TourCommittee,
        created_at: date(b.created_at, 'ballot.created_at'),
        cancelled: b.cancelled,
        message_id: entier(b.message_id, 'ballot.message_id'),
        body: b.body == null ? null : texte(b.body, 'ballot.body'),
        outcome: (b.outcome ?? null) as BulletinAvis['outcome'],
      };
    }),
  };
}
export function versBulletinsAvis(resultats: ResultatsCommittee): BulletinAvis[] {
  return resultats.ballots.map((b) => ({
    cell: b.peer,
    tour: b.round,
    outcome: b.outcome,
    corps: b.body,
    annule: b.cancelled,
  }));
}

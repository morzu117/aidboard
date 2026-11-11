import { lireMotion, lireResultats } from '../../shared/committee.js';
import type { MeshService } from './service.js';

/**
 * Lectures prévues par la carte #1581, qui dépend de la phase proxy de #20.
 * Les écritures ne viendront que si C1 est oui. En attendant le relais effectif,
 * ces verbes restent déclarés côté A-I-D seulement, hors VERBES_LECTURE.
 */
export const VERBES_COMMITTEE = ['committee.motions.list', 'committee.motion.get'] as const;
export type ErreurCommittee =
  'absent' | 'too-old' | 'format' | 'timeout' | 'refus' | 'non-relaye' | 'unknown';
export type LectureCommittee<T> =
  { ok: true; data: T; readAt: string } | { ok: false; kind: ErreurCommittee; readAt: string };

/** Lectures seules, sans cache ni sondage ; MeshService.read conserve le délai commun. */
export class CommitteeReader {
  constructor(
    private readonly deps: {
      mesh: Pick<MeshService, 'read'>;
      cell: string;
      proxySocket?: string;
    },
  ) {}

  motionOuverte(canal: string) {
    this.validerCanal(canal);
    return this.lire(['committee', 'motion', canal], lireMotion);
  }

  resultats(canal: string, motionId: number | string) {
    this.validerCanal(canal);
    if (!/^[1-9][0-9]{0,15}$/.test(String(motionId)) || !Number.isSafeInteger(Number(motionId)))
      throw new RangeError('committee : identifiant invalide');
    return this.lire(['committee', 'results', canal, '--motion', String(motionId)], lireResultats);
  }

  private validerCanal(canal: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(canal))
      throw new RangeError('committee : canal invalide');
  }

  private async lire<T>(args: string[], parse: (v: unknown) => T): Promise<LectureCommittee<T>> {
    const readAt = new Date().toISOString();
    // D296 : aucun appel proxy, et surtout aucun repli vers le CLI.
    if (this.deps.proxySocket) return { ok: false, kind: 'non-relaye', readAt };
    const r = await this.deps.mesh.read([...args, '--json', '--as', this.deps.cell]);
    if (!r.ok) {
      const kind: ErreurCommittee =
        r.spawnErrorCode === 'ENOENT' || r.spawnErrorCode === 'EACCES'
          ? 'absent'
          : r.timedOut
            ? 'timeout'
            : /invalid choice.*(?:committee|results)|(?:committee|results).*invalid choice/is.test(
                  r.stderr,
                )
              ? 'too-old'
              : /gateway (401|403)|no read grant|not a seat|not seated|permission denied/i.test(
                    r.stderr,
                  )
                ? 'refus'
                : 'unknown';
      return { ok: false, kind, readAt };
    }
    try {
      return { ok: true, data: parse(JSON.parse(r.stdout)), readAt };
    } catch {
      return { ok: false, kind: 'format', readAt };
    }
  }
}

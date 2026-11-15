import type { MeshExecResult } from './exec.js';
import { nettoyer } from '../../shared/nettoyage.js';
import { AidHttpError } from '../errors.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EcheancesAvisMesh, SiegeAvis } from '../../shared/avis-mesh-api.js';
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
  | { ok: true; data: T; readAt: string }
  | { ok: false; kind: ErreurCommittee; readAt: string; status?: number; message?: string };

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
    if (!/^[a-z0-9_-]{1,64}$/.test(canal) || /[^a-z0-9_-]/.test(canal))
      throw new RangeError('committee : canal invalide');
  }

  private async lire<T>(args: string[], parse: (v: unknown) => T): Promise<LectureCommittee<T>> {
    const readAt = new Date().toISOString();
    // D296 : aucun appel proxy, et surtout aucun repli vers le CLI.
    if (this.deps.proxySocket) return { ok: false, kind: 'non-relaye', readAt };
    const r = await this.deps.mesh.read([...args, '--json', '--as', this.deps.cell]);
    if (!r.ok) {
      const refus = refusGateway(r);
      if (refus)
        return { ok: false, kind: 'refus', readAt, status: refus.status, message: refus.message };
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

/** Écritures déclarées seulement, hors du catalogue fermé du proxy. */
export const VERBES_COMMITTEE_ECRITURE = [
  'committee.rooms.open',
  'committee.motion.open',
  'committee.baseline-absent',
] as const;

export class RefusCommittee extends AidHttpError {}

export class CommitteeWriter {
  constructor(
    private readonly deps: {
      mesh: Pick<MeshService, 'read'>;
      cell: string;
      proxySocket?: string;
    },
  ) {}

  async ouvrirSalle(d: {
    nom: string;
    charter: string;
    carte: number;
    sieges: SiegeAvis[];
  }): Promise<string> {
    this.disponible();
    validerCanalEcriture(d.nom);
    const dossier = await mkdtemp(join(tmpdir(), 'aid-committee-'));
    try {
      const charter = join(dossier, 'charter.txt');
      const sieges = join(dossier, 'sieges.json');
      await writeFile(charter, d.charter, { mode: 0o600 });
      await writeFile(sieges, JSON.stringify(d.sieges), { mode: 0o600 });
      const r = await this.executer([
        'committee',
        'rooms',
        'open',
        '--name',
        d.nom,
        '--charter-file',
        charter,
        '--card-id',
        String(d.carte),
        '--seats-file',
        sieges,
        '--json',
      ]);
      const v = JSON.parse(r) as { channel?: unknown };
      if (typeof v.channel !== 'string') throw new Error('committee : format invalide');
      validerCanalEcriture(v.channel);
      return v.channel;
    } finally {
      await rm(dossier, { recursive: true, force: true });
    }
  }

  async ouvrirMotion(d: {
    canal: string;
    texte: string;
    echeances: EcheancesAvisMesh;
  }): Promise<number> {
    this.disponible();
    validerCanalEcriture(d.canal);
    const args = [
      'committee',
      'motion',
      d.canal,
      '--open',
      '--text',
      d.texte,
      '--options',
      'avis,objection',
    ];
    for (const tour of ['positions', 'rebuttal', 'vote'] as const)
      args.push(`--${tour}-deadline`, d.echeances[tour]);
    const v = JSON.parse(await this.executer([...args, '--json'])) as { id?: unknown };
    if (typeof v.id !== 'number' || !Number.isSafeInteger(v.id) || v.id <= 0)
      throw new Error('committee : id de motion invalide');
    return v.id;
  }

  async baselineAbsent(d: { canal: string; raison: string }): Promise<void> {
    this.disponible();
    validerCanalEcriture(d.canal);
    await this.executer(['committee', 'baseline-absent', d.canal, '--reason', d.raison]);
  }

  private disponible() {
    if (this.deps.proxySocket) throw new Error('committee : non relayé par le proxy');
    if (!this.deps.cell) throw new Error('committee : cell absente');
  }
  private async executer(args: string[]): Promise<string> {
    this.disponible();
    const r = await this.deps.mesh.read([...args, '--as', this.deps.cell]);
    if (!r.ok) {
      const refus = refusGateway(r);
      if (refus) throw refus;
      throw new Error('committee : écriture échouée');
    }
    return r.stdout;
  }
}

function validerCanalEcriture(canal: string) {
  if (!/^[a-z0-9_-]{1,64}$/.test(canal) || /[^a-z0-9_-]/.test(canal))
    throw new RangeError('committee : canal invalide');
}

/** Le nettoyeur du 35 refuse un texte suspect : il ne sait pas en masquer les fragments. */
function refusGateway(r: MeshExecResult): RefusCommittee | null {
  // committee.py _fail écrit statut HTTP et détail sur stderr, puis sort avec 1 ou 2.
  const refus =
    !r.timedOut && !r.spawnErrorCode && (r.exitCode === 1 || r.exitCode === 2)
      ? r.stderr.match(/gateway (4[0-9]{2}): ([\s\S]*)/)
      : null;
  if (!refus) return null;
  const propre = nettoyer(refus[2]!);
  const message = propre.ok
    ? Array.from(refus[2]!.trim()).slice(0, 300).join('')
    : `Refus gateway : ${propre.classe}`;
  return new RefusCommittee(Number(refus[1]), message);
}

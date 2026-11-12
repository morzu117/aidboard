import { randomBytes } from 'node:crypto';
import {
  charterAvis,
  citerQuestion,
  jetonCitation,
  validerQuestionMesh,
} from '../../shared/charter-avis.js';
import { decouperSousQuestions, lireAvis, type PhaseAvis } from '../../shared/avis-mesh.js';
import { versBulletinsAvis } from '../../shared/committee.js';
import {
  echeancesAvisParDefaut,
  siegesAvis,
  validerEcheancesAvis,
  RAISON_BASELINE_ABSENT,
  type ParametresAvisMesh,
  type DemandeAvisMesh,
  type EcheancesAvisMesh,
  type SiegeAvis,
  type ResultatAvisMesh,
} from '../../shared/avis-mesh-api.js';
import type { MeshConfig } from '../config.js';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';
import type { CommitteeReader, CommitteeWriter } from './committee.js';

interface LigneAvis {
  id: string;
  question: string;
  sieges: string;
  carte: number;
  canal: string | null;
  motion: number | null;
  jeton: string;
  date: string;
  etat: string;
  echeances: string;
  confirmation: string | null;
  erreur: string | null;
}
export class AvisMeshService {
  constructor(
    private readonly deps: {
      db: Db;
      config: MeshConfig;
      lecteur: CommitteeReader;
      ecrivain: CommitteeWriter;
    },
  ) {}

  config() {
    return {
      cellAid: this.deps.config.cell,
      baseline: this.deps.config.avis?.baseline ?? null,
      familles: this.deps.config.avis?.familles ?? {},
    };
  }
  preparer(corps: unknown): ParametresAvisMesh {
    const d = corps as {
      question?: unknown;
      cells?: unknown;
      carte?: unknown;
      echeances?: EcheancesAvisMesh;
    } | null;
    if (
      !d ||
      typeof d.question !== 'string' ||
      !d.question.trim() ||
      !Array.isArray(d.cells) ||
      !d.cells.every((c) => typeof c === 'string') ||
      typeof d.carte !== 'number' ||
      !Number.isSafeInteger(d.carte) ||
      d.carte < 1
    )
      throw new AidHttpError(400, 'demande invalide');
    const propre = validerQuestionMesh(d.question);
    if (!propre.ok) throw new AidHttpError(422, propre.classe);
    try {
      const { cellAid, baseline, familles } = this.config();
      const sieges = siegesAvis({
        cellAid,
        baseline: baseline ?? undefined,
        cells: d.cells,
        familles,
      });
      const echeances = d.echeances ?? echeancesAvisParDefaut();
      validerEcheancesAvis(echeances);
      const sousQuestions = decouperSousQuestions(d.question);
      const id =
        new Date()
          .toISOString()
          .replace(/[-:]/g, '')
          .replace(/\.\d{3}/, '') +
        '-' +
        randomBytes(2).toString('hex');
      const jeton = jetonCitation();
      return {
        id,
        nom: `avis-${id}`,
        question: d.question,
        carte: d.carte,
        sieges,
        echeances,
        jeton,
        charter: charterAvis({ jeton, carte: d.carte, nbSousQuestions: sousQuestions.length }),
        texte: citerQuestion(d.question, jeton),
      };
    } catch (e) {
      throw new AidHttpError(400, (e as Error).message);
    }
  }
  enregistrer(p: ParametresAvisMesh) {
    this.deps.db
      .prepare(
        'INSERT INTO avis_mesh (id, question, sieges, carte, jeton, date, etat, echeances) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        p.id,
        p.question,
        JSON.stringify(p.sieges),
        p.carte,
        p.jeton,
        new Date().toISOString(),
        'confirmation',
        JSON.stringify(p.echeances),
      );
  }
  oublier(id: string) {
    this.deps.db.prepare("DELETE FROM avis_mesh WHERE id = ? AND etat = 'confirmation'").run(id);
  }
  ligne(id: string): LigneAvis {
    const ligne = this.deps.db.prepare('SELECT * FROM avis_mesh WHERE id = ?').get(id) as
      LigneAvis | undefined;
    if (!ligne) throw new AidHttpError(404, 'demande inconnue');
    return this.etatConfirmation(ligne);
  }
  lierConfirmation(id: string, confirmation: string) {
    this.deps.db
      .prepare('UPDATE avis_mesh SET confirmation = ? WHERE id = ?')
      .run(confirmation, id);
  }
  private etatConfirmation(l: LigneAvis): LigneAvis {
    if (!l.confirmation || !['confirmation', 'salle-sans-motion'].includes(l.etat)) return l;
    const c = this.deps.db
      .prepare('SELECT etat, echeance FROM pda_demandes WHERE id = ?')
      .get(l.confirmation) as { etat: string; echeance: number } | undefined;
    return c &&
      (['refusee', 'expiree'].includes(c.etat) ||
        (c.etat === 'ouverte' && c.echeance <= Date.now()))
      ? { ...l, etat: 'abandonnee' }
      : l;
  }
  demande(l: LigneAvis): DemandeAvisMesh {
    l = this.etatConfirmation(l);
    const sieges = JSON.parse(l.sieges) as SiegeAvis[];
    return {
      id: l.id,
      etat: l.etat,
      date: l.date,
      cells: sieges.filter((s) => s.role === 'seat').map((s) => s.peer),
      carte: l.carte,
      canal: l.canal,
      motion: l.motion,
      ...(l.confirmation && { confirmation: l.confirmation }),
      ...(l.erreur && { erreur: JSON.parse(l.erreur) as DemandeAvisMesh['erreur'] }),
    };
  }
  liste() {
    return {
      demandes: (
        this.deps.db
          .prepare('SELECT * FROM avis_mesh ORDER BY date DESC, id DESC LIMIT 20')
          .all() as LigneAvis[]
      ).map((l) => this.demande(l)),
    };
  }
  verifier(p: Pick<ParametresAvisMesh, 'id'>): ParametresAvisMesh {
    const l = this.ligne(p.id);
    if (l.etat !== 'confirmation' || l.canal !== null)
      throw new AidHttpError(409, 'demande déjà exécutée');
    const config = this.config();
    const sieges = siegesAvis({
      cellAid: config.cellAid,
      baseline: config.baseline ?? undefined,
      cells: (JSON.parse(l.sieges) as SiegeAvis[])
        .filter((s) => s.role === 'seat')
        .map((s) => s.peer),
      familles: config.familles,
    });
    if (Date.parse((JSON.parse(l.echeances) as EcheancesAvisMesh).positions) <= Date.now())
      throw new AidHttpError(409, 'échéance positions passée');
    const jeton = l.jeton;
    return {
      id: l.id,
      nom: `avis-${l.id}`,
      question: l.question,
      carte: l.carte,
      sieges,
      echeances: JSON.parse(l.echeances),
      jeton,
      charter: charterAvis({
        jeton,
        carte: l.carte,
        nbSousQuestions: decouperSousQuestions(l.question).length,
      }),
      texte: citerQuestion(l.question, jeton),
    };
  }
  async ouvrir(p: ParametresAvisMesh) {
    // La prise atomique interdit toute seconde ouverture, même après un arrêt du daemon.
    const prise = this.deps.db
      .prepare(
        "UPDATE avis_mesh SET etat = 'ouverture' WHERE id = ? AND etat = 'confirmation' AND canal IS NULL",
      )
      .run(p.id);
    if (prise.changes !== 1) throw new AidHttpError(409, 'demande déjà exécutée');
    let canal: string;
    try {
      canal = await this.deps.ecrivain.ouvrirSalle(p);
    } catch (e) {
      this.deps.db.prepare("UPDATE avis_mesh SET etat = 'echouee' WHERE id = ?").run(p.id);
      this.garderErreur(p.id, e);
      throw e;
    }
    this.deps.db
      .prepare("UPDATE avis_mesh SET canal = ?, etat = 'ouverture-motion' WHERE id = ?")
      .run(canal, p.id);
    await this.ouvrirMotionPrise(p.id, canal, p.texte, p.echeances);
  }
  preparerMotion(id: string, echeances: EcheancesAvisMesh) {
    const l = this.ligne(id);
    if (l.etat !== 'salle-sans-motion' || !l.canal || l.motion !== null)
      throw new AidHttpError(409, 'reprise permise à salle-sans-motion seulement');
    try {
      validerEcheancesAvis(echeances);
    } catch (e) {
      throw new AidHttpError(400, (e as Error).message);
    }
    return { id, canal: l.canal, texte: citerQuestion(l.question, l.jeton), echeances };
  }
  async reprendreMotion(p: {
    id: string;
    canal: string;
    texte: string;
    echeances: EcheancesAvisMesh;
  }) {
    this.preparerMotion(p.id, p.echeances);
    const prise = this.deps.db
      .prepare(
        "UPDATE avis_mesh SET etat = 'ouverture-motion', echeances = ?, erreur = NULL WHERE id = ? AND canal = ? AND etat = 'salle-sans-motion' AND motion IS NULL",
      )
      .run(JSON.stringify(p.echeances), p.id, p.canal);
    if (prise.changes !== 1) throw new AidHttpError(409, 'motion déjà exécutée');
    await this.ouvrirMotionPrise(p.id, p.canal, p.texte, p.echeances);
  }
  private garderErreur(id: string, erreur: unknown) {
    const detail =
      erreur instanceof AidHttpError
        ? { status: erreur.status, message: erreur.message }
        : { status: 503, message: 'committee : écriture échouée' };
    this.deps.db
      .prepare('UPDATE avis_mesh SET erreur = ? WHERE id = ?')
      .run(JSON.stringify(detail), id);
  }
  private async ouvrirMotionPrise(
    id: string,
    canal: string,
    texte: string,
    echeances: EcheancesAvisMesh,
  ) {
    try {
      const motion = await this.deps.ecrivain.ouvrirMotion({ canal, texte, echeances });
      this.deps.db
        .prepare("UPDATE avis_mesh SET motion = ?, etat = 'ouverte', erreur = NULL WHERE id = ?")
        .run(motion, id);
    } catch (e) {
      this.deps.db.prepare("UPDATE avis_mesh SET etat = 'salle-sans-motion' WHERE id = ?").run(id);
      this.garderErreur(id, e);
      throw e;
    }
  }
  async resultats(id: string) {
    const l = this.ligne(id);
    if (!l.canal || l.motion === null) {
      if (l.erreur) {
        const e = JSON.parse(l.erreur) as { status: number; message: string };
        throw new AidHttpError(e.status, e.message);
      }
      throw new AidHttpError(409, l.etat);
    }
    const r = await this.deps.lecteur.resultats(l.canal, l.motion);
    if (!r.ok) {
      if (r.status && r.message) throw new AidHttpError(r.status, r.message);
      throw new AidHttpError(503, r.kind === 'non-relaye' ? 'non relayé par le proxy' : r.kind);
    }
    if (r.data.motion.id !== l.motion) throw new AidHttpError(502, 'motion inattendue');
    return { l, donnees: r.data };
  }
  async lire(id: string): Promise<ResultatAvisMesh> {
    const { l, donnees } = await this.resultats(id);
    const phase = donnees.motion.phase === 'closed' ? 'clos' : donnees.motion.phase;
    if (!['positions', 'rebuttal', 'vote', 'clos'].includes(phase))
      throw new AidHttpError(502, 'phase inconnue');
    const sieges = JSON.parse(l.sieges) as SiegeAvis[];
    const lecture = {
      sousQuestions: decouperSousQuestions(l.question),
      bulletins: versBulletinsAvis(donnees),
      phase: phase as PhaseAvis,
    };
    const baseline = sieges.find((s) => s.role === 'baseline');
    const avisBaseline = baseline
      ? lireAvis({
          ...lecture,
          bulletins: lecture.bulletins.filter((b) => b.tour !== 'vote'),
          sieges: [baseline.peer],
        }).avis[0]!
      : null;
    // La liste du gateway fait autorité, même si un bulletin contredit l'absence.
    const absents = new Set(
      donnees.positions_absent.filter((peer) =>
        sieges.some((s) => s.role === 'seat' && s.peer === peer),
      ),
    );
    const avis = lireAvis({
      ...lecture,
      bulletins: lecture.bulletins.filter((b) => !absents.has(b.cell) || b.tour === 'rebuttal'),
      sieges: sieges.filter((s) => s.role === 'seat').map((s) => s.peer),
    });
    for (const siege of avis.avis) if (absents.has(siege.cell)) siege.etat = 'absent';
    return {
      ...avis,
      phase: lecture.phase,
      echeances: {
        positions: donnees.motion.positions_deadline,
        rebuttal:
          donnees.motion.rebuttal_deadline ??
          (JSON.parse(l.echeances) as EcheancesAvisMesh).rebuttal,
        vote: donnees.motion.vote_deadline ?? (JSON.parse(l.echeances) as EcheancesAvisMesh).vote,
      },
      baseline:
        avisBaseline && donnees.baseline_absent
          ? {
              ...avisBaseline,
              etat: 'declare_absent',
              reponses: [],
              brut: null,
              ...donnees.baseline_absent,
            }
          : avisBaseline,
    };
  }
  async verifierAbsence(id: string) {
    const { l, donnees } = await this.resultats(id);
    if (
      donnees.motion.phase !== 'positions' ||
      Date.now() <= Date.parse(donnees.motion.positions_deadline)
    )
      throw new AidHttpError(409, 'baseline absent : positions après échéance seulement');
    if (donnees.baseline_absent !== null)
      throw new AidHttpError(409, 'baseline déjà déclaré absent');
    const baseline = (JSON.parse(l.sieges) as SiegeAvis[]).find((s) => s.role === 'baseline');
    if (donnees.ballots.some((b) => b.peer === baseline?.peer && b.round === 'positions'))
      throw new AidHttpError(409, 'le baseline a déjà posté');
    return { id, canal: l.canal!, motion: l.motion!, raison: RAISON_BASELINE_ABSENT };
  }
  async declarerAbsent(id: string) {
    const params = await this.verifierAbsence(id);
    try {
      await this.deps.ecrivain.baselineAbsent(params);
    } catch (e) {
      this.garderErreur(id, e);
      throw e;
    }
  }
}

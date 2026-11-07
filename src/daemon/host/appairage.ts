import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

// Chantier 31 (D176, lab M4 et DM 91366) : les demandes d'appairage, en mémoire seulement. Une
// seule demande vit à la fois. Le code sert une fois et vit 5 minutes. Une seconde réclamation du
// même code annule la demande. L'appareil qui a réclamé est lié à sa demande par un jeton de
// demande (le cookie `__Host-aid_demande`) : l'id de la demande, qui voyage dans le chemin, ne
// suffit jamais seul. Rien ici ne touche au réseau ni à la base : l'horloge est injectée.

export const DUREE_CODE_MS = 5 * 60 * 1000;
export const PLAFOND_RECLAMATIONS = 5;
export const FENETRE_PLAFOND_MS = 60 * 1000;
/** sans ambiguïté à l'œil : ni 0/O, ni 1/I/L */
export const ALPHABET_CODE_COURT = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export type RaisonAnnulation = 'deux-reclamations' | 'remplacee' | 'refusee' | 'coupee';

export type EtatDemande =
  | 'attente' // créée sur le Mac, QR affiché, personne n'a réclamé
  | 'reclamee' // un appareil a réclamé : code court à comparer sur le Mac
  | 'approuvee' // approuvée sur le Mac : l'appareil n'a pas encore pris son accès
  | 'consommee' // l'appareil a pris son accès
  | 'annulee'
  | 'expiree';

/** Ce que le Mac voit de la demande en cours (D176). */
export interface VueDemande {
  id: string;
  etat: EtatDemande;
  expireA: string;
  codeCourt: string | null;
  nom: string | null;
  identite: string | null;
  raison: RaisonAnnulation | null;
}

interface Demande {
  id: string;
  code: string;
  creeA: number;
  etat: EtatDemande;
  raison: RaisonAnnulation | null;
  reclamation: {
    nom: string;
    identite: string | null;
    codeCourt: string;
    jetonDemande: string;
  } | null;
}

export type Reclamation =
  | { ok: true; demandeId: string; codeCourt: string; jetonDemande: string }
  | { ok: false; raison: 'inconnu' | 'plafond' };

export type Approbation = { ok: true } | { ok: false; raison: 'inconnu' | 'identite-absente' };

export type LectureAppareil =
  | { etat: 'attente' }
  | { etat: 'approuvee'; nom: string; identite: string | null }
  | { etat: 'inconnu' };

function egal(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function codeCourt(): string {
  const c = Array.from(
    { length: 6 },
    () => ALPHABET_CODE_COURT[randomInt(ALPHABET_CODE_COURT.length)],
  );
  return `${c.slice(0, 3).join('')}-${c.slice(3).join('')}`;
}

export class Appairages {
  private demande: Demande | null = null;
  private readonly tentatives = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  private vivante(): Demande | null {
    const d = this.demande;
    if (!d) return null;
    if (
      (d.etat === 'attente' || d.etat === 'reclamee' || d.etat === 'approuvee') &&
      this.now() - d.creeA >= DUREE_CODE_MS
    ) {
      d.etat = 'expiree';
    }
    return d;
  }

  private annuler(raison: RaisonAnnulation): void {
    const d = this.vivante();
    if (d && (d.etat === 'attente' || d.etat === 'reclamee' || d.etat === 'approuvee')) {
      d.etat = 'annulee';
      d.raison = raison;
    }
  }

  /** Machines › Ajouter un appareil, sur le Mac. Annule la précédente (« Nouveau code »). */
  creer(): { id: string; code: string; expireA: string } {
    this.annuler('remplacee');
    const d: Demande = {
      // 192 bits : au-delà des 128 exigés par le lab
      id: randomBytes(24).toString('base64url'),
      code: randomBytes(32).toString('base64url'),
      creeA: this.now(),
      etat: 'attente',
      raison: null,
      reclamation: null,
    };
    this.demande = d;
    return { id: d.id, code: d.code, expireA: new Date(d.creeA + DUREE_CODE_MS).toISOString() };
  }

  /** Plafond par source, sur une fenêtre glissante ; une source inconnue partage le seau global. */
  private plafond(source: string): boolean {
    const t = this.now();
    for (const [s, liste] of this.tentatives) {
      const vives = liste.filter((x) => t - x < FENETRE_PLAFOND_MS);
      if (vives.length === 0) this.tentatives.delete(s);
      else this.tentatives.set(s, vives);
    }
    const liste = this.tentatives.get(source) ?? [];
    if (liste.length >= PLAFOND_RECLAMATIONS) return true;
    liste.push(t);
    this.tentatives.set(source, liste);
    return false;
  }

  /**
   * POST /appairage/reclamer, la seule écriture sans authentification du port des appareils.
   * Toute erreur rend `inconnu`, sans dire pourquoi : code faux, expiré, annulé ou déjà pris.
   */
  reclamer(entree: {
    code: unknown;
    nom: string;
    identite: string | null;
    source: string;
  }): Reclamation {
    if (this.plafond(entree.source || 'global')) return { ok: false, raison: 'plafond' };
    const d = this.vivante();
    if (!d || typeof entree.code !== 'string' || !egal(entree.code, d.code)) {
      return { ok: false, raison: 'inconnu' };
    }
    if (d.etat === 'reclamee' || d.etat === 'approuvee') {
      // lab M4 : deux appareils ont le même code ; personne n'entre
      this.annuler('deux-reclamations');
      return { ok: false, raison: 'inconnu' };
    }
    if (d.etat !== 'attente') return { ok: false, raison: 'inconnu' };
    d.reclamation = {
      nom: entree.nom,
      identite: entree.identite,
      codeCourt: codeCourt(),
      jetonDemande: randomBytes(32).toString('base64url'),
    };
    d.etat = 'reclamee';
    return {
      ok: true,
      demandeId: d.id,
      codeCourt: d.reclamation.codeCourt,
      jetonDemande: d.reclamation.jetonDemande,
    };
  }

  /** Sur le Mac seulement. Sans identité Tailscale, il faut la case « Appareil taggé » (lab M4). */
  approuver(id: string, opts: { sansIdentite?: boolean } = {}): Approbation {
    const d = this.vivante();
    if (!d || !egal(id, d.id) || d.etat !== 'reclamee' || !d.reclamation) {
      return { ok: false, raison: 'inconnu' };
    }
    if (d.reclamation.identite === null && opts.sansIdentite !== true) {
      return { ok: false, raison: 'identite-absente' };
    }
    d.etat = 'approuvee';
    return { ok: true };
  }

  refuser(id: string): boolean {
    const d = this.vivante();
    if (!d || !egal(id, d.id)) return false;
    const avant = d.etat;
    this.annuler('refusee');
    return avant !== d.etat;
  }

  /** « Couper tous les accès » et l'arrêt du mode host annulent la demande en cours. */
  toutAnnuler(): void {
    this.annuler('coupee');
  }

  /**
   * GET /appairage/:demandeId : il faut l'id **et** le jeton de demande (DM 91366). La première
   * lecture d'une demande approuvée la consomme ; l'appelant émet alors l'accès (registre).
   */
  lirePourAppareil(id: string, jetonDemande: unknown): LectureAppareil {
    const d = this.vivante();
    if (
      !d ||
      !d.reclamation ||
      typeof jetonDemande !== 'string' ||
      !egal(id, d.id) ||
      !egal(jetonDemande, d.reclamation.jetonDemande)
    ) {
      return { etat: 'inconnu' };
    }
    if (d.etat === 'reclamee') return { etat: 'attente' };
    if (d.etat === 'approuvee') {
      d.etat = 'consommee';
      return { etat: 'approuvee', nom: d.reclamation.nom, identite: d.reclamation.identite };
    }
    return { etat: 'inconnu' };
  }

  /** Ce que Machines affiche ; jamais le code ni le jeton de demande. */
  vueMac(): VueDemande | null {
    const d = this.vivante();
    if (!d) return null;
    return {
      id: d.id,
      etat: d.etat,
      expireA: new Date(d.creeA + DUREE_CODE_MS).toISOString(),
      codeCourt: d.reclamation?.codeCourt ?? null,
      nom: d.reclamation?.nom ?? null,
      identite: d.reclamation?.identite ?? null,
      raison: d.raison,
    };
  }
}

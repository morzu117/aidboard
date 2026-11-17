import {
  mkdirSync,
  chmodSync,
  lstatSync,
  readFileSync,
  renameSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { controlerLigneCommandant, type ControleCommandant } from '../../shared/commandant.js';
import { nomMeshValide } from '../config.js';
import { ClientCommandant, type ErreurCommandant, type OptionsClientCommandant } from './client.js';
import { IdentifiantsCockpit, type EtatIdentifiantCockpit } from './identifiant.js';

type Validee = Extract<ControleCommandant, { valide: true }>;
type Refusee = Extract<ControleCommandant, { valide: false }>;
export interface EtatFileCommandant {
  lignes: Validee[];
  refusees: Refusee[];
  identifiant: { etat: EtatIdentifiantCockpit; saisie: string | null };
  derniereLecture: string | null;
  erreur: ErreurCommandant | null;
}
interface Entree {
  etat: EtatFileCommandant;
  generation: number;
  ouvertJusqua: number;
  minuteur?: ReturnType<typeof setTimeout>;
  lecture?: Promise<void>;
  notifies: Set<number>;
}
export interface OptionsServiceCommandant {
  home: string;
  meshes: () => Record<string, { gateway: string; cell: string }>;
  notifier: (id: number) => Promise<void>;
  maintenant?: () => number;
  client?: OptionsClientCommandant;
}
const ARRETS = new Set<EtatIdentifiantCockpit>(['expire', 'revoque', 'inconnu']);

/** Le contenu des demandes reste en mémoire ; seuls les ids notifiés sont persistés. */
export class ServiceCommandant {
  private readonly identifiants: IdentifiantsCockpit;
  private readonly entrees = new Map<string, Entree>();
  private arrete = false;
  private readonly maintenant: () => number;
  constructor(private readonly options: OptionsServiceCommandant) {
    this.identifiants = new IdentifiantsCockpit(options.home);
    this.maintenant = options.maintenant ?? Date.now;
  }
  private obtenir(mesh: string): Entree {
    if (
      !nomMeshValide(mesh) ||
      !Object.hasOwn(this.options.meshes(), mesh) ||
      !this.options.meshes()[mesh]?.cell
    )
      throw new Error('Mesh commandant inconnu');
    let entree = this.entrees.get(mesh);
    if (!entree) {
      const lu = this.identifiants.lire(mesh);
      entree = {
        etat: {
          lignes: [],
          refusees: [],
          identifiant: { etat: lu ? 'valide' : 'absent', saisie: lu?.saisie ?? null },
          derniereLecture: null,
          erreur: null,
        },
        generation: 0,
        ouvertJusqua: 0,
        notifies: this.lireNotifies(mesh),
      };
      this.entrees.set(mesh, entree);
    }
    return entree;
  }
  etat(mesh: string): EtatFileCommandant {
    return structuredClone(this.obtenir(mesh).etat);
  }
  async demarrer(): Promise<void> {
    for (const [mesh, config] of Object.entries(this.options.meshes())) {
      if (!config.cell) continue;
      try {
        this.obtenir(mesh);
        void this.actualiser(mesh);
      } catch {
        /* un fichier local illisible n'expose jamais son contenu */
      }
    }
  }
  async saisir(mesh: string, valeur: unknown): Promise<void> {
    const e = this.obtenir(mesh);
    this.identifiants.ecrire(mesh, valeur);
    e.generation++;
    clearTimeout(e.minuteur);
    e.etat = {
      lignes: [],
      refusees: [],
      identifiant: { etat: 'valide', saisie: this.identifiants.lire(mesh)!.saisie },
      derniereLecture: null,
      erreur: null,
    };
    // Une lecture précédente peut se terminer, mais sa génération ne peut plus publier.
    await e.lecture;
    await this.actualiser(mesh);
  }
  supprimer(mesh: string): void {
    const e = this.obtenir(mesh);
    this.identifiants.supprimer(mesh);
    e.generation++;
    clearTimeout(e.minuteur);
    e.etat = {
      lignes: [],
      refusees: [],
      identifiant: { etat: 'absent', saisie: null },
      derniereLecture: null,
      erreur: null,
    };
  }
  async battement(mesh: string): Promise<void> {
    const e = this.obtenir(mesh);
    const ouverture = e.ouvertJusqua <= this.maintenant();
    e.ouvertJusqua = this.maintenant() + 65_000;
    if (ouverture) await this.actualiser(mesh);
    else this.programmer(mesh, e);
  }
  private programmer(mesh: string, e: Entree): void {
    clearTimeout(e.minuteur);
    if (this.arrete || e.etat.identifiant.etat === 'absent' || ARRETS.has(e.etat.identifiant.etat))
      return;
    const rythme = e.ouvertJusqua > this.maintenant() ? 30_000 : 300_000;
    const derniere = e.etat.derniereLecture
      ? Date.parse(e.etat.derniereLecture)
      : this.maintenant();
    e.minuteur = setTimeout(
      () => {
        void this.actualiser(mesh);
      },
      Math.max(0, derniere + rythme - this.maintenant()),
    );
    e.minuteur.unref();
  }
  actualiser(mesh: string): Promise<void> {
    const e = this.obtenir(mesh);
    if (this.arrete || e.etat.identifiant.etat === 'absent' || ARRETS.has(e.etat.identifiant.etat))
      return Promise.resolve();
    if (e.lecture) return e.lecture;
    e.lecture = this.lire(mesh, e).finally(() => {
      e.lecture = undefined;
      this.programmer(mesh, e);
    });
    return e.lecture;
  }
  private traiterErreur(e: Entree, erreur: ErreurCommandant): void {
    e.etat.erreur = erreur;
    if ('http' in erreur && (erreur.http === 401 || erreur.http === 403)) {
      e.etat.identifiant.etat = 'refuse';
      if (erreur.genre === 'passerelle' && erreur.http === 401) {
        const etats = {
          cockpit_credential_expired: 'expire',
          cockpit_credential_revoked: 'revoque',
          cockpit_credential_unknown: 'inconnu',
        } as const;
        if (erreur.code in etats)
          e.etat.identifiant.etat = etats[erreur.code as keyof typeof etats];
      }
      e.etat.lignes = [];
      e.etat.refusees = [];
      if (ARRETS.has(e.etat.identifiant.etat)) e.generation++;
    }
  }
  private async lire(mesh: string, e: Entree): Promise<void> {
    const generation = e.generation;
    const courant = () => !this.arrete && generation === e.generation;
    try {
      const lu = this.identifiants.lire(mesh);
      if (!lu) {
        if (courant()) this.supprimer(mesh);
        return;
      }
      const client = new ClientCommandant(
        this.options.meshes()[mesh]!.gateway,
        lu.valeur,
        this.options.client,
      );
      const resultat = await client.liste();
      if (!courant()) return;
      e.etat.derniereLecture = new Date(this.maintenant()).toISOString();
      if (!resultat.ok) {
        this.traiterErreur(e, resultat.erreur);
        return;
      }
      if (!Array.isArray(resultat.valeur)) {
        e.etat.erreur = { genre: 'transport', code: 'json' };
        return;
      }
      e.etat.identifiant.etat = 'valide';
      e.etat.erreur = null;
      const lignes: Validee[] = [],
        refusees: Refusee[] = [];
      const idsEnAttente = new Set<number>();
      for (const brute of resultat.valeur) {
        const controle = controlerLigneCommandant(brute);
        if (!controle.valide) {
          refusees.push(controle);
          continue;
        }
        if (controle.ligne.status === 'pending') idsEnAttente.add(controle.ligne.id);
        // Le détail est systématiquement relu avant publication, y compris si la ligne a changé.
        const detail = await client.detail(controle.ligne.id);
        if (!courant()) return;
        if (!detail.ok) {
          this.traiterErreur(e, detail.erreur);
          if (e.etat.identifiant.etat !== 'valide') return;
          continue;
        }
        const verifie = controlerLigneCommandant(detail.valeur);
        if (!verifie.valide) refusees.push(verifie);
        else if (verifie.ligne.id !== controle.ligne.id)
          refusees.push({ valide: false, id: controle.ligne.id, raison: 'forme' });
        else lignes.push(verifie);
      }
      if (!courant()) return;
      if (refusees.length === 0 && e.etat.erreur === null) {
        const notifies = new Set([...e.notifies].filter((id) => idsEnAttente.has(id)));
        if (notifies.size !== e.notifies.size) {
          this.ecrireNotifies(mesh, notifies);
          e.notifies = notifies;
        }
      }
      e.etat.lignes = lignes;
      e.etat.refusees = refusees;
      for (const ligne of lignes) {
        if (!courant()) return;
        const id = ligne.ligne.id;
        if (ligne.ligne.status !== 'pending' || e.notifies.has(id)) continue;
        // Écrire avant l'envoi garantit l'absence de doublon après un redémarrage.
        e.notifies.add(id);
        try {
          this.ecrireNotifies(mesh, e.notifies);
        } catch {
          e.notifies.delete(id);
          e.etat.erreur = { genre: 'transport', code: 'reseau' };
          continue;
        }
        if (courant()) {
          try {
            await this.options.notifier(id);
          } catch {
            /* notification sans contenu */
          }
        }
      }
    } catch {
      if (courant()) e.etat.erreur = { genre: 'transport', code: 'reseau' };
    }
  }
  async detail(
    mesh: string,
    id: number,
  ): Promise<ControleCommandant | { erreur: ErreurCommandant }> {
    const e = this.obtenir(mesh),
      generation = e.generation;
    if (!Number.isSafeInteger(id) || id < 0)
      return { erreur: { genre: 'transport', code: 'requete' } };
    if (e.etat.identifiant.etat === 'absent' || ARRETS.has(e.etat.identifiant.etat))
      return { erreur: { genre: 'transport', code: 'identifiant' } };
    try {
      const lu = this.identifiants.lire(mesh);
      if (!lu) return { erreur: { genre: 'transport', code: 'identifiant' } };
      const resultat = await new ClientCommandant(
        this.options.meshes()[mesh]!.gateway,
        lu.valeur,
        this.options.client,
      ).detail(id);
      if (this.arrete || generation !== e.generation)
        return { erreur: { genre: 'transport', code: 'identifiant' } };
      if (!resultat.ok) {
        this.traiterErreur(e, resultat.erreur);
        this.programmer(mesh, e);
        return { erreur: resultat.erreur };
      }
      const controle = controlerLigneCommandant(resultat.valeur);
      if (controle.valide && controle.ligne.id !== id)
        return { valide: false, id, raison: 'forme' };
      return controle;
    } catch {
      return { erreur: { genre: 'transport', code: 'reseau' } };
    }
  }
  private cheminNotifies(mesh: string): string {
    return join(this.options.home, 'cockpit', `${mesh}.notifies.json`);
  }
  private lireNotifies(mesh: string): Set<number> {
    try {
      const chemin = this.cheminNotifies(mesh);
      if (!lstatSync(chemin).isFile() || lstatSync(chemin).isSymbolicLink())
        throw new Error('Historique invalide');
      const ids: unknown = JSON.parse(readFileSync(chemin, 'utf8'));
      if (!Array.isArray(ids) || !ids.every((id) => Number.isSafeInteger(id) && id >= 0))
        throw new Error('Historique invalide');
      return new Set(ids);
    } catch (erreur) {
      if ((erreur as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
      throw new Error('Historique des notifications illisible');
    }
  }
  private ecrireNotifies(mesh: string, ids: Set<number>): void {
    const dossier = join(this.options.home, 'cockpit');
    mkdirSync(dossier, { recursive: true, mode: 0o700 });
    if (lstatSync(dossier).isSymbolicLink()) throw new Error('Dossier invalide');
    chmodSync(dossier, 0o700);
    const temporaire = join(dossier, `.notifies-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporaire, JSON.stringify([...ids]), { mode: 0o600, flag: 'wx' });
      renameSync(temporaire, this.cheminNotifies(mesh));
    } finally {
      rmSync(temporaire, { force: true });
    }
  }
  async arreter(): Promise<void> {
    this.arrete = true;
    for (const e of this.entrees.values()) clearTimeout(e.minuteur);
    await Promise.all([...this.entrees.values()].map((e) => e.lecture));
  }
}

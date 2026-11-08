import { decoderBase64url, jsonCanonique, type ParamsAction } from '../../shared/pda.js';
import type { Db } from '../db.js';
import type { creerFournisseurClePda } from './cle.js';
import { signerDemande } from './demande.js';
import type { RegistrePda } from './registre.js';
import type { RelaisPda, ReponseRelais } from './relais.js';
import { verifierAssertion } from './webauthn.js';

export interface LigneDemande {
  id: string;
  hDemande: string;
  numero: string | null;
  numero_mac: string | null;
  action: string;
  params: string | null;
  classe: string | null;
  etatAvantNettoyage?: string;
  perimee?: boolean;
  echeance: number;
}
export class RelaisInjoignable extends Error {
  constructor() {
    super('relais injoignable');
  }
}

export class FilePda {
  private arrete = false;
  private minuterie: ReturnType<typeof setTimeout> | undefined;
  private suite: Promise<unknown> = Promise.resolve();
  private dernierePublication: number | null = null;
  private readonly maintenant;
  constructor(
    private readonly deps: {
      db: Db;
      registre: RegistrePda;
      fournisseur: ReturnType<typeof creerFournisseurClePda>;
      relais: RelaisPda;
      actif: () => boolean;
      contexte: () => { origine: string; rpId: string } | null;
      journal: (type: string, donnees: Record<string, unknown>) => void;
      signaler: () => void;
      maintenant?: () => number;
      executer?: (ligne: LigneDemande) => Promise<void>;
      preparerConsommation?: (ligne: LigneDemande) => Promise<() => void>;
    },
  ) {
    this.maintenant = deps.maintenant ?? Date.now;
    // D210 : aucune demande d'une session précédente ne survit à l'allumage.
    const anciennes = this.ouvertes();
    deps.db
      .prepare(
        "UPDATE pda_demandes SET etat = 'expiree', resultat = NULL, consomme_a = ? WHERE etat = 'ouverte'",
      )
      .run(new Date(this.maintenant()).toISOString());
    if (anciennes.length) deps.signaler();
    void this.enFile(async () => {
      for (const { id } of anciennes) {
        if (!this.actif()) return;
        await deps.relais.retirer(id);
      }
      await this.publier();
    }).catch(() => {});
  }
  disponible() {
    return this.actif() && this.deps.contexte() !== null;
  }
  signaler() {
    this.deps.signaler();
  }
  private actif() {
    return !this.arrete && this.deps.actif();
  }
  private enFile<T>(operation: () => Promise<T>): Promise<T> {
    const tache = this.suite.then(operation);
    this.suite = tache.catch(() => this.deps.journal('pda.file.echec', {}));
    return tache;
  }
  private ouvertes() {
    return this.deps.db
      .prepare("SELECT id, echeance FROM pda_demandes WHERE etat = 'ouverte'")
      .all() as Array<{ id: string; echeance: number }>;
  }
  private programmer() {
    if (!this.actif() || this.minuterie !== undefined || !this.ouvertes().length) return;
    this.minuterie = setTimeout(() => {
      this.minuterie = undefined;
      void (async () => {
        try {
          await this.tour();
        } catch {
          this.deps.journal('pda.file.echec', {});
        } finally {
          this.programmer();
        }
      })();
    }, 15_000);
    this.minuterie.unref?.();
  }
  private async publier() {
    if (!this.actif()) return;
    const appareils = this.deps.db
      .prepare("SELECT id, cle_relais FROM pda_appareils WHERE etat = 'actif'")
      .all() as Array<{ id: string; cle_relais: string }>;
    const publie = await this.deps.relais.publierAutorises(
      appareils.map((a) => ({ id: a.id, cle: JSON.parse(a.cle_relais) })),
    );
    if (publie) this.dernierePublication = this.maintenant();
  }
  publierAutorises() {
    return this.enFile(() => this.publier());
  }
  creerDemande(entree: { action: 'essai'; sujet: string } | ParamsAction) {
    return this.enFile(async () => {
      if (!this.actif() || !this.deps.contexte())
        throw new Error('PDA ou nom Tailscale indisponible');
      const d = await signerDemande(
        { ...entree, maintenant: this.maintenant() },
        this.deps.fournisseur,
      );
      if (!this.actif() || !this.deps.contexte()) throw new Error('PDA indisponible');
      this.deps.db
        .prepare(
          `INSERT INTO pda_demandes
        (id, action, sujet, h_demande, numero, echeance, etat, cree_a, classe, params, resume, numero_mac)
        VALUES (?, ?, ?, ?, ?, ?, 'ouverte', ?, ?, ?, ?, ?)`,
        )
        .run(
          d.corps.id,
          d.corps.action,
          d.corps.v === 1 ? d.corps.sujet : '',
          d.hDemande,
          d.corps.numero ?? '',
          d.corps.echeance,
          new Date(d.corps.emise).toISOString(),
          d.corps.v === 2 ? d.corps.classe : null,
          d.corps.v === 2 ? jsonCanonique(d.corps.params) : null,
          d.corps.v === 2 ? d.corps.resume : null,
          d.numeroMac,
        );
      await this.publier();
      if (!this.actif()) throw new Error('PDA indisponible');
      if (!(await this.deps.relais.deposer(d.corps.id, d.enveloppe))) {
        this.deps.db
          .prepare(
            "UPDATE pda_demandes SET etat = 'expiree', consomme_a = ? WHERE id = ? AND etat = 'ouverte'",
          )
          .run(new Date(this.maintenant()).toISOString(), d.corps.id);
        this.deps.signaler();
        throw new RelaisInjoignable();
      }
      if (this.actif()) this.deps.signaler();
      this.programmer();
      return { id: d.corps.id };
    });
  }
  annuler(id: string) {
    return this.enFile(async () => {
      const modifie = this.deps.db
        .prepare(
          "UPDATE pda_demandes SET etat = 'expiree', resultat = 'annulee', consomme_a = ? WHERE id = ? AND etat = 'ouverte'",
        )
        .run(new Date(this.maintenant()).toISOString(), id);
      if (!modifie.changes) return false;
      this.deps.signaler();
      await this.deps.relais.retirer(id);
      return true;
    });
  }
  etat(id: string) {
    return this.deps.db.prepare('SELECT etat FROM pda_demandes WHERE id = ?').get(id) as
      { etat: string } | undefined;
  }
  private async traiter(r: ReponseRelais) {
    const refus = (raison: string, appareil?: string) =>
      this.deps.journal('pda.refus', { ...(appareil ? { appareil } : {}), raison });
    let entree: Record<string, unknown>;
    try {
      if (r.corps.length > Math.ceil((8192 * 4) / 3)) return refus('taille');
      const octets = decoderBase64url(r.corps);
      if (octets.length > 8192) return refus('taille');
      entree = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(octets));
      if (!entree || typeof entree !== 'object' || Array.isArray(entree)) return refus('schema');
    } catch {
      return refus('schema');
    }
    const appareil = typeof entree.appareil === 'string' ? entree.appareil : undefined;
    if (appareil !== r.appareil) return refus('appareil', appareil);
    const demande = this.deps.db
      .prepare(
        "SELECT id, h_demande AS hDemande, CASE WHEN classe = 'toujours' THEN NULL ELSE numero END AS numero, numero_mac, echeance, action, classe, params FROM pda_demandes WHERE id = ?",
      )
      .get(r.id) as LigneDemande | undefined;
    if (!demande) return refus('demande', appareil);
    const ctx = this.deps.contexte();
    if (!ctx) return refus('origine', appareil);
    const resultat = await verifierAssertion(entree, {
      ...ctx,
      appareil: appareil ? this.deps.registre.actif(appareil) : null,
      demande: {
        id: demande.id,
        hDemande: demande.hDemande,
        numero: demande.numero,
        echeance: demande.echeance,
      },
      ...(demande.classe === 'toujours' && demande.numero_mac !== null
        ? { numeroAttendu: demande.numero_mac }
        : {}),
      maintenant: this.maintenant(),
    });
    const consommer =
      resultat.ok && resultat.valeur === 'oui'
        ? await this.deps.preparerConsommation?.(demande)
        : undefined;
    if (!this.actif()) return;
    if (!resultat.ok && resultat.raison === 'numero' && resultat.signee) {
      if (!appareil || !this.deps.registre.actif(appareil)?.actif)
        return refus('appareil', appareil);
      if (this.maintenant() > demande.echeance) return refus('echeance', appareil);
      const annulee = this.deps.db.transaction(
        () =>
          this.deps.db
            .prepare(
              "UPDATE pda_demandes SET etat = 'expiree', resultat = 'annulee', raison = 'numero' WHERE id = ? AND etat = 'ouverte'",
            )
            .run(demande.id).changes,
      )();
      if (!annulee) {
        this.deps.journal('pda.tardive', { id: demande.id });
        return;
      }
      this.deps.journal('pda.numero_faux', { id: demande.id, appareil });
      this.deps.signaler();
      try {
        await this.deps.relais.retirer(demande.id);
      } catch {
        this.deps.journal('pda.retrait.echec', { id: demande.id });
      }
      return;
    }
    if (!resultat.ok) return refus(resultat.raison, appareil);
    // La vérification attend le hachage : une révocation ou l'échéance peut survenir entre-temps.
    if (!appareil || !this.deps.registre.actif(appareil)?.actif) return refus('appareil', appareil);
    if (this.maintenant() > demande.echeance) return refus('echeance', appareil);
    const consomme = this.deps.db.transaction(() => {
      const changements = this.deps.db
        .prepare(
          "UPDATE pda_demandes SET etat = ?, consomme_a = ? WHERE id = ? AND etat = 'ouverte'",
        )
        .run(
          resultat.valeur === 'oui' ? 'confirmee' : 'refusee',
          new Date(this.maintenant()).toISOString(),
          demande.id,
        ).changes;
      // D224 : l'archivage du nettoyage partage la transaction de consommation.
      if (changements && resultat.valeur === 'oui') consommer?.();
      return changements;
    })();
    if (!consomme) {
      this.deps.journal('pda.tardive', { id: demande.id });
      return;
    }
    this.deps.signaler();
    this.deps.journal(demande.action === 'essai' ? 'pda.essai' : 'pda.reponse', {
      id: demande.id,
      valeur: resultat.valeur,
    });
    if (this.actif()) {
      try {
        await this.deps.relais.retirer(demande.id);
      } catch {
        this.deps.journal('pda.retrait.echec', { id: demande.id });
      }
    }
    if (resultat.valeur === 'oui' && demande.params !== null) {
      await this.deps.executer?.(demande);
      // Déjà dans la file : ne pas réenfiler la publication après une activation.
      if (demande.action === 'pda.activer') await this.publier();
    }
  }
  tour() {
    return this.enFile(async () => {
      if (!this.actif() || !this.ouvertes().length) return;
      if (
        this.dernierePublication === null ||
        this.maintenant() - this.dernierePublication > 5 * 60_000
      )
        await this.publier();
      if (!this.actif()) return;
      const reponses = await this.deps.relais.tirer(0);
      for (const r of reponses) {
        if (!this.actif()) return;
        await this.traiter(r);
      }
      // Traiter avant d'expirer permet de journaliser le refus d'une assertion arrivée en retard.
      for (const d of this.ouvertes()) {
        if (!this.actif()) return;
        if (d.echeance < this.maintenant()) {
          this.deps.db
            .prepare(
              "UPDATE pda_demandes SET etat = 'expiree', consomme_a = ? WHERE id = ? AND etat = 'ouverte'",
            )
            .run(new Date(this.maintenant()).toISOString(), d.id);
          this.deps.signaler();
          await this.deps.relais.retirer(d.id);
        }
      }
    });
  }
  async arreter() {
    this.arrete = true;
    if (this.minuterie !== undefined) clearTimeout(this.minuterie);
    this.minuterie = undefined;
    await this.suite;
  }
}

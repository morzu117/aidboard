import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db.js';

// Chantier 31 (D177) : le registre des appareils. Le jeton n'est jamais gardé : seule son
// empreinte l'est. L'horloge est injectée pour les tests.

export const DUREE_ACCES_MS = 8 * 3600 * 1000;
/** `dernier_contact` s'écrit au plus une fois par minute et par appareil */
export const TOUCHE_MS = 60 * 1000;
/** un appareil révoqué ou expiré reste visible 30 jours dans la liste, puis disparaît */
export const GARDE_MS = 30 * 24 * 3600 * 1000;
export const NOM_MAX = 40;

export type EtatAppareil = 'actif' | 'expire' | 'revoque';

export interface Appareil {
  id: string;
  nom: string;
  /** l'identité Tailscale vue à l'appairage, null sans en-tête (D179) */
  identite: string | null;
  creeA: string;
  dernierContact: string | null;
  expireA: string;
  revoqueA: string | null;
  etat: EtatAppareil;
}

export type Authentification =
  { ok: true; appareil: Appareil } | { ok: false; raison: 'inconnu' | 'expire' | 'revoque' };

interface Ligne {
  id: string;
  nom: string;
  identite: string | null;
  cree_a: string;
  dernier_contact: string | null;
  expire_a: string;
  revoque_a: string | null;
}

export function empreinte(jeton: string): string {
  return createHash('sha256').update(jeton).digest('hex');
}

// caractères de contrôle, et ceux qui retournent ou cachent du texte (bidi, largeur nulle)
// eslint-disable-next-line no-control-regex -- les retirer est le but
const CONTROLES = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;

/** Le nom proposé par l'appareil : une donnée étrangère, nettoyée, jamais rendue en HTML. */
export function nomAppareil(brut: unknown): string {
  const texte = typeof brut === 'string' ? brut : '';
  const propre = texte.replace(CONTROLES, '').trim();
  return propre === '' ? 'Appareil' : [...propre].slice(0, NOM_MAX).join('');
}

export class RegistreAppareils {
  private readonly ecouteurs = new Set<(ids: string[]) => void>();

  /** D177 : le port des appareils ferme les sockets d'un appareil révoqué. Rend le désabonnement. */
  surRevocation(f: (ids: string[]) => void): () => void {
    this.ecouteurs.add(f);
    return () => this.ecouteurs.delete(f);
  }

  private prevenir(ids: string[]): void {
    if (ids.length > 0) for (const f of this.ecouteurs) f(ids);
  }

  constructor(
    private readonly db: Db,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  private vers(l: Ligne): Appareil {
    const etat: EtatAppareil =
      l.revoque_a !== null ? 'revoque' : Date.parse(l.expire_a) <= this.now() ? 'expire' : 'actif';
    return {
      id: l.id,
      nom: l.nom,
      identite: l.identite,
      creeA: l.cree_a,
      dernierContact: l.dernier_contact,
      expireA: l.expire_a,
      revoqueA: l.revoque_a,
      etat,
    };
  }

  /** Un appareil approuvé (D176) : le jeton ne sort qu'ici, une fois, pour le cookie. */
  emettre(entree: { nom: string; identite: string | null }): { appareil: Appareil; jeton: string } {
    this.purger();
    const jeton = randomBytes(32).toString('base64url');
    const id = `ap_${randomBytes(9).toString('base64url')}`;
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO appareils (id, nom, identite, cree_a, dernier_contact, expire_a, revoque_a, empreinte)
         VALUES (?, ?, ?, ?, NULL, ?, NULL, ?)`,
      )
      .run(
        id,
        nomAppareil(entree.nom),
        entree.identite,
        this.iso(t),
        this.iso(t + DUREE_ACCES_MS),
        empreinte(jeton),
      );
    return { appareil: this.lire(id)!, jeton };
  }

  /** Chaque requête d'un appareil passe ici ; sans prolongation : `expire_a` ne bouge jamais. */
  authentifier(jeton: unknown): Authentification {
    if (typeof jeton !== 'string' || jeton.length < 32 || jeton.length > 128) {
      return { ok: false, raison: 'inconnu' };
    }
    const l = this.db
      .prepare('SELECT * FROM appareils WHERE empreinte = ?')
      .get(empreinte(jeton)) as Ligne | undefined;
    if (!l) return { ok: false, raison: 'inconnu' };
    const a = this.vers(l);
    if (a.etat !== 'actif') return { ok: false, raison: a.etat };
    const t = this.now();
    if (l.dernier_contact === null || t - Date.parse(l.dernier_contact) >= TOUCHE_MS) {
      this.db
        .prepare('UPDATE appareils SET dernier_contact = ? WHERE id = ?')
        .run(this.iso(t), l.id);
      a.dernierContact = this.iso(t);
    }
    return { ok: true, appareil: a };
  }

  lire(id: string): Appareil | null {
    const l = this.db.prepare('SELECT * FROM appareils WHERE id = ?').get(id) as Ligne | undefined;
    return l ? this.vers(l) : null;
  }

  /** Les plus récents d'abord ; révoqués et expirés compris, jusqu'à la purge. */
  lister(): Appareil[] {
    this.purger();
    return (
      this.db.prepare('SELECT * FROM appareils ORDER BY cree_a DESC, id').all() as Ligne[]
    ).map((l) => this.vers(l));
  }

  /** Révoquer agit tout de suite et ne demande rien (règles globales). Faux si déjà coupé ou inconnu. */
  revoquer(id: string): boolean {
    const r = this.db
      .prepare('UPDATE appareils SET revoque_a = ? WHERE id = ? AND revoque_a IS NULL')
      .run(this.iso(this.now()), id);
    if (r.changes > 0) this.prevenir([id]);
    return r.changes > 0;
  }

  /** « Couper tous les accès » : rend les ids des appareils coupés (31.8 ferme leurs sockets). Le Mac reste. */
  toutRevoquer(): string[] {
    const t = this.iso(this.now());
    const ids = (
      this.db
        .prepare('SELECT id FROM appareils WHERE revoque_a IS NULL AND expire_a > ?')
        .all(t) as Array<{ id: string }>
    ).map((r) => r.id);
    this.db.prepare('UPDATE appareils SET revoque_a = ? WHERE revoque_a IS NULL').run(t);
    this.prevenir(ids);
    return ids;
  }

  private purger(): void {
    const limite = this.iso(this.now() - GARDE_MS);
    this.db
      .prepare(
        'DELETE FROM appareils WHERE (revoque_a IS NOT NULL AND revoque_a < ?) OR expire_a < ?',
      )
      .run(limite, limite);
  }
}

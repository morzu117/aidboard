import { CREATION_EN_COURS } from '../../shared/ecritures.js';
import { liensSwairm } from '../../shared/swairm-board.js';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';
import { creerProxyClient, VERBES_LECTURE } from '../mesh/proxy.js';

export interface CarteEnVol {
  mesh: string;
  ligne_swairm: string;
  projet: number;
  etat: 'en-vol' | 'incertain';
  depuis: string;
}
export type RelectureCarte = { ok: true; id: number | null } | { ok: false };

/** D340 : aucun cache, recherche textuelle, filtre d'étape ou repli CLI. */
export class CreationsCartes {
  private readonly relectures = new Map<string, Promise<RelectureCarte>>();
  constructor(
    private readonly db: Db,
    private readonly socket: (mesh: string) => string,
  ) {}

  liste(mesh: string): CarteEnVol[] {
    return this.db.prepare('SELECT * FROM cartes_en_vol WHERE mesh = ?').all(mesh) as CarteEnVol[];
  }

  verifier(mesh: string, ligne: string): void {
    if (
      this.db
        .prepare('SELECT 1 FROM cartes_en_vol WHERE mesh = ? AND ligne_swairm = ?')
        .get(mesh, ligne)
    )
      throw new AidHttpError(409, CREATION_EN_COURS);
  }

  reserver(mesh: string, ligne: string, projet: number): void {
    const resultat = this.db
      .prepare(
        "INSERT INTO cartes_en_vol (mesh, ligne_swairm, projet, etat, depuis) VALUES (?, ?, ?, 'en-vol', ?) ON CONFLICT (mesh, ligne_swairm) DO NOTHING",
      )
      .run(mesh, ligne, projet, new Date().toISOString());
    if (!resultat.changes) throw new AidHttpError(409, CREATION_EN_COURS);
  }

  effacer(mesh: string, ligne: string): void {
    this.db
      .prepare('DELETE FROM cartes_en_vol WHERE mesh = ? AND ligne_swairm = ?')
      .run(mesh, ligne);
  }

  incertain(mesh: string, ligne: string): void {
    this.db
      .prepare("UPDATE cartes_en_vol SET etat = 'incertain' WHERE mesh = ? AND ligne_swairm = ?")
      .run(mesh, ligne);
  }

  async lire(mesh: string, projet: number, ligne: string): Promise<RelectureCarte> {
    try {
      const reponse = await creerProxyClient({
        socket: this.socket(mesh),
        verbes: VERBES_LECTURE,
      }).appeler('board.cards.list', { project: projet });
      if (!reponse.ok || Array.isArray(reponse.body) || !Array.isArray(reponse.body.cards))
        return { ok: false };
      let trouve: number | null = null;
      // Une carte mal formée n'est jamais silencieusement ignorée lors du dédoublonnage.
      for (const brut of reponse.body.cards) {
        if (!brut || typeof brut !== 'object' || Array.isArray(brut)) return { ok: false };
        const carte = brut as Record<string, unknown>;
        if (
          !Number.isSafeInteger(carte.id) ||
          (carte.id as number) <= 0 ||
          !(typeof carte.body === 'string' || carte.body === null)
        )
          return { ok: false };
        if (
          typeof carte.body === 'string' &&
          liensSwairm(carte.body).some((lien) => `Swairm: ${lien.projet}#${lien.id}` === ligne)
        )
          trouve ??= carte.id as number;
      }
      return { ok: true, id: trouve };
    } catch {
      return { ok: false };
    }
  }

  relire(mesh: string, ligne: string): Promise<RelectureCarte> {
    const cle = JSON.stringify([mesh, ligne]);
    const enCours = this.relectures.get(cle);
    if (enCours) return enCours;
    const vol = this.liste(mesh).find((v) => v.ligne_swairm === ligne);
    if (!vol || vol.etat !== 'incertain') return Promise.resolve({ ok: false });
    const lecture = this.lire(mesh, vol.projet, ligne)
      .then((resultat) => {
        if (resultat.ok) this.effacer(mesh, ligne);
        return resultat;
      })
      .finally(() => this.relectures.delete(cle));
    this.relectures.set(cle, lecture);
    return lecture;
  }

  async reprendre(): Promise<void> {
    this.db.prepare("UPDATE cartes_en_vol SET etat = 'incertain'").run();
    const lignes = this.db.prepare('SELECT * FROM cartes_en_vol').all() as CarteEnVol[];
    await Promise.all(
      lignes.map(async (v) => {
        const lecture = await this.relire(v.mesh, v.ligne_swairm);
        if (!lecture.ok) throw new Error('relecture indisponible');
      }),
    );
  }
}

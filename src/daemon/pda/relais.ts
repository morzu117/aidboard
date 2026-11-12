import { sign } from 'node:crypto';
import { hacher, octetsRequeteRelais, signatureBasse } from '../../shared/pda.js';
import { validerRelais } from '../config.js';
import type { creerFournisseurClePda } from './cle.js';

export interface ReponseRelais {
  curseur: number;
  id: string;
  appareil: string;
  corps: string;
}
export interface RelaisPda {
  publierAutorises(liste: Array<{ id: string; cle: unknown }>): Promise<boolean>;
  deposer(id: string, enveloppe: { corps: string; sig: string }): Promise<boolean>;
  publierResultat(id: string, enveloppe: { corps: string; sig: string }): Promise<boolean>;
  retirer(id: string): Promise<unknown>;
  tirer(apres: number): Promise<ReponseRelais[]>;
}

/** Le transport est injectable uniquement au constructeur, pour les tests. */
export class ClientRelais implements RelaisPda {
  private derniereHeure = 0;
  constructor(
    private readonly options: {
      relais: string;
      fournisseur: ReturnType<typeof creerFournisseurClePda>;
      journal: (type: string) => void;
      maintenant?: () => number;
      transport?: (url: URL, options: RequestInit) => Promise<Pick<Response, 'status' | 'body'>>;
    },
  ) {
    validerRelais(options.relais);
  }

  private async requete(
    methode: string,
    chemin: string,
    contenu?: unknown,
  ): Promise<{ corps: unknown } | null> {
    try {
      const corps = contenu === undefined ? '' : JSON.stringify(contenu);
      // Deux requêtes identiques dans la même milliseconde doivent rester distinctes pour l'anti-rejeu.
      const heure = String(
        (this.derniereHeure = Math.max(
          (this.options.maintenant ?? Date.now)(),
          this.derniereHeure + 1,
        )),
      );
      const signature = signatureBasse(
        sign(
          'sha256',
          octetsRequeteRelais({
            methode,
            chemin,
            hachageCorps: await hacher(Buffer.from(corps)),
            heure,
          }),
          {
            key: this.options.fournisseur.obtenir(),
            dsaEncoding: 'ieee-p1363',
          },
        ),
      );
      const reponse = await (this.options.transport ?? fetch)(
        new URL(chemin, this.options.relais),
        {
          method: methode,
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
          headers: {
            'Content-Type': 'application/json',
            'X-Aid-Heure': heure,
            'X-Aid-Sig': Buffer.from(signature).toString('base64url'),
          },
          ...(contenu === undefined ? {} : { body: corps }),
        },
      );
      if (reponse.status < 200 || reponse.status >= 300) {
        void reponse.body?.cancel().catch(() => {});
        throw new Error();
      }
      const lecteur = reponse.body?.getReader();
      const morceaux: Uint8Array[] = [];
      let taille = 0;
      if (lecteur) {
        try {
          for (;;) {
            const { done, value } = await lecteur.read();
            if (done) break;
            taille += value.byteLength;
            if (taille > 64 * 1024) {
              void lecteur.cancel().catch(() => {});
              throw new Error();
            }
            morceaux.push(value);
          }
        } finally {
          lecteur.releaseLock();
        }
      }
      return {
        corps: taille
          ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(morceaux)))
          : null,
      };
    } catch {
      this.options.journal('pda.relais.echec');
      return null;
    }
  }
  async publierAutorises(liste: Array<{ id: string; cle: unknown }>) {
    return (await this.requete('PUT', '/autorises', { appareils: liste })) !== null;
  }
  async deposer(id: string, enveloppe: { corps: string; sig: string }) {
    return (await this.requete('PUT', `/demandes/${encodeURIComponent(id)}`, enveloppe)) !== null;
  }
  async publierResultat(id: string, enveloppe: { corps: string; sig: string }) {
    return (await this.requete('PUT', `/resultats/${encodeURIComponent(id)}`, enveloppe)) !== null;
  }
  retirer(id: string) {
    return this.requete('DELETE', `/demandes/${encodeURIComponent(id)}`);
  }
  async tirer(apres: number): Promise<ReponseRelais[]> {
    const reponses = (await this.requete('GET', `/reponses?apres=${apres}`))?.corps;
    if (!Array.isArray(reponses)) return [];
    return reponses.filter(
      (r): r is ReponseRelais =>
        r &&
        Number.isSafeInteger(r.curseur) &&
        r.curseur > apres &&
        typeof r.id === 'string' &&
        typeof r.appareil === 'string' &&
        typeof r.corps === 'string',
    );
  }
}

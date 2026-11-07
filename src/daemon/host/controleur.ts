import type { FastifyInstance } from 'fastify';
import type { AidConfig } from '../config.js';
import { lireTailnet, type TailscaleExec } from '../mesh/tailscale.js';
import type { Appairages } from './appairage.js';
import type { RegistreAppareils } from './appareils.js';
import {
  type OptionsServeurAppareils,
  ouvrirServeurAppareils,
  type ServeurAppareils,
} from './serveur.js';

// Chantier 31 (D171, D172) : allumer et éteindre le port des appareils sans redémarrer le
// daemon. Éteindre révoque tous les appareils et annule la demande d'appairage (D177).

export interface EtatPortAppareils {
  disponible: boolean;
  raison: string | null;
}

export interface OptionsModeHost {
  config: AidConfig;
  port: () => number;
  interdits: () => Array<{ port: number; nom: string }>;
  registre: RegistreAppareils;
  appairages: Appairages;
  webRoot: string | null;
  /** D175, D178 : ce que le port des appareils lit */
  etat?: OptionsServeurAppareils['etat'];
  livraison?: OptionsServeurAppareils['livraison'];
  tours?: OptionsServeurAppareils['tours'];
  reponses?: OptionsServeurAppareils['reponses'];
  signal?: OptionsServeurAppareils['signal'];
  board?: OptionsServeurAppareils['board'];
  tailscaleExec?: TailscaleExec;
  logger?: boolean;
  log?: (m: string) => void;
}

export class ModeHost {
  private serveur: ServeurAppareils | null = null;
  private nom: string | null = null;
  private file: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: OptionsModeHost) {}

  /** les bascules passent l'une après l'autre : jamais deux instances sur le même port */
  private enFile<T>(f: () => Promise<T>): Promise<T> {
    const suite = this.file.then(f, f);
    this.file = suite.catch(() => undefined);
    return suite;
  }

  /** Le nom `.ts.net`, relu par GET /api/host : un nom changé ou apparu est pris tout de suite. */
  noterNom(nom: string | null): void {
    this.nom = nom;
  }

  etat(): EtatPortAppareils {
    if (!this.opts.config.modeHost.actif) return { disponible: false, raison: 'mode host éteint' };
    if (!this.serveur) return { disponible: false, raison: 'non démarré' };
    if (!this.serveur.disponible) return { disponible: false, raison: this.serveur.raison };
    if (this.nom === null) return { disponible: false, raison: 'nom Tailscale du Mac non lu' };
    return { disponible: true, raison: null };
  }

  get appairages(): Appairages {
    return this.opts.appairages;
  }

  get registre(): RegistreAppareils {
    return this.opts.registre;
  }

  /** le nom `.ts.net` du Mac, celui du QR (D176) */
  nomLu(): string | null {
    return this.nom;
  }

  /** tests : l'instance du port des appareils, null quand il n'écoute pas */
  instance(): FastifyInstance | null {
    return this.serveur?.disponible ? this.serveur.app : null;
  }

  /** le port réellement ouvert (0 en config = un port au hasard, en test) */
  portOuvert(): number | null {
    return this.serveur?.disponible ? this.serveur.port : null;
  }

  demarrer(): Promise<EtatPortAppareils> {
    return this.enFile(async () => {
      if (this.serveur?.disponible) return this.etat();
      const t = await lireTailnet(this.opts.config.mesh.tailscale.bin, this.opts.tailscaleExec);
      this.nom = t.nom;
      this.serveur = await ouvrirServeurAppareils({
        port: this.opts.port(),
        interdits: this.opts.interdits(),
        nom: () => this.nom,
        registre: this.opts.registre,
        appairages: this.opts.appairages,
        etat: this.opts.etat,
        livraison: this.opts.livraison,
        tours: this.opts.tours,
        reponses: this.opts.reponses,
        signal: this.opts.signal,
        board: this.opts.board,
        webRoot: this.opts.webRoot,
        logger: this.opts.logger,
      });
      if (!this.serveur.disponible) {
        this.opts.log?.(`port des appareils indisponible : ${this.serveur.raison}`);
      }
      return this.etat();
    });
  }

  /** Arrêt du daemon : on ferme seulement. Éteindre le mode host : on coupe aussi les accès. */
  arreter(opts: { couper: boolean }): Promise<string[]> {
    return this.enFile(async () => {
      const s = this.serveur;
      this.serveur = null;
      // couper d'abord : les sockets des appareils se ferment en 4401 « revoque » (D183)
      let coupes: string[] = [];
      if (opts.couper) {
        this.opts.appairages.toutAnnuler();
        coupes = this.opts.registre.toutRevoquer();
      }
      if (s?.disponible) await s.app.close();
      return coupes;
    });
  }
}

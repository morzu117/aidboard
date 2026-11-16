import { creerFournisseurCles } from '../push/vapid.js';
import type { FastifyInstance } from 'fastify';
import type { AidConfig } from '../config.js';
import { lireServe, lireTailnet, type TailscaleExec } from '../mesh/tailscale.js';
import type { Appairages } from './appairage.js';
import type { RegistreAppareils } from './appareils.js';
import {
  type OptionsServeurAppareils,
  ouvrirServeurAppareils,
  type ServeurAppareils,
} from './serveur.js';

// Chantier 31 (D171, D172) : allumer et éteindre le port des appareils sans redémarrer le
// daemon. Éteindre révoque tous les appareils et annule la demande d'appairage (D177).

export const RELECTURE_HOST_MS = 60_000;

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
  code?: OptionsServeurAppareils['code'];
  tours?: OptionsServeurAppareils['tours'];
  pda?: OptionsServeurAppareils['pda'];
  clePda?: OptionsServeurAppareils['clePda'];
  push?: OptionsServeurAppareils['push'];
  reponses?: OptionsServeurAppareils['reponses'];
  signal?: OptionsServeurAppareils['signal'];
  board?: OptionsServeurAppareils['board'];
  tailscaleExec?: TailscaleExec;
  relectureHostMs?: number;
  logger?: boolean;
  log?: (m: string) => void;
}

export class ModeHost {
  private serveur: ServeurAppareils | null = null;
  private nom: string | null = null;
  private raison: string | null = null;
  private lecturesIllisibles = 0;
  private minuteur: ReturnType<typeof setInterval> | null = null;
  private file: Promise<unknown> = Promise.resolve();

  readonly fournisseurPush;

  constructor(private readonly opts: OptionsModeHost) {
    this.fournisseurPush =
      opts.push && (opts.push.fournisseur ?? creerFournisseurCles(opts.push.dossierEtat));
    if (opts.push?.actif()) this.fournisseurPush!.obtenir();
  }

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
    if (this.raison) return { disponible: false, raison: this.raison };
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

  async lireTailscale() {
    const bin = this.opts.config.mesh.tailscale.bin;
    const [tailnet, serve] = await Promise.all([
      lireTailnet(bin, this.opts.tailscaleExec).catch(() => {
        return { etat: 'stopped' as const, nom: null, compte: null };
      }),
      lireServe(
        bin,
        {
          appareils: this.portOuvert() ?? this.opts.port(),
          interdits: this.opts.interdits().map((p) => p.port),
        },
        this.opts.tailscaleExec,
      ).catch(() => {
        return { etat: 'illisible' as const, funnel: false, interdits: [] };
      }),
    ]);
    return { tailnet, serve };
  }

  private programmerRelecture(): void {
    if (this.minuteur) return;
    this.minuteur = setInterval(() => {
      void this.enFile(async () => {
        if (!this.minuteur || !this.opts.config.modeHost.actif) return;
        const lecture = await this.lireTailscale();
        if (lecture.tailnet.etat === 'running') this.noterNom(lecture.tailnet.nom);
        this.lecturesIllisibles =
          lecture.serve.etat === 'illisible' ? this.lecturesIllisibles + 1 : 0;
        if ((lecture.serve.funnel || this.lecturesIllisibles >= 2) && this.serveur?.disponible) {
          this.raison = lecture.serve.funnel
            ? 'Funnel actif : le port des appareils est arrêté'
            : 'État de Serve illisible : le port des appareils est arrêté';
          this.opts.log?.(this.raison);
          const serveur = this.serveur;
          this.serveur = null;
          if (serveur?.disponible) await serveur.app.close();
        }
      }).catch(() => this.opts.log?.('relecture du mode host impossible'));
    }, this.opts.relectureHostMs ?? RELECTURE_HOST_MS);
    this.minuteur.unref();
  }

  demarrer(lecture?: Awaited<ReturnType<ModeHost['lireTailscale']>>): Promise<EtatPortAppareils> {
    return this.enFile(async () => {
      const lu = lecture ?? (await this.lireTailscale());
      if (lu.tailnet.etat === 'running') this.noterNom(lu.tailnet.nom);
      this.lecturesIllisibles = 0;
      this.programmerRelecture();
      if (lu.serve.funnel || lu.serve.etat === 'illisible') {
        this.raison = lu.serve.funnel
          ? 'Funnel actif : le cockpit serait sur internet'
          : 'État de Serve illisible';
        this.opts.log?.(this.raison);
        return this.etat();
      }
      this.raison = null;
      if (this.serveur?.disponible) return this.etat();
      this.serveur = await ouvrirServeurAppareils({
        port: this.opts.port(),
        interdits: this.opts.interdits(),
        nom: () => this.nom,
        registre: this.opts.registre,
        appairages: this.opts.appairages,
        etat: this.opts.etat,
        livraison: this.opts.livraison,
        pda: this.opts.pda,
        clePda: this.opts.clePda,
        relaisPda: () => this.opts.config.modeHost.relais,
        code: this.opts.code,
        tours: this.opts.tours,
        push: this.opts.push && { ...this.opts.push, fournisseur: this.fournisseurPush },
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

  annulerRelecture(): void {
    if (this.minuteur) clearInterval(this.minuteur);
    this.minuteur = null;
  }

  /** Arrêt du daemon : on ferme seulement. Éteindre le mode host : on coupe aussi les accès. */
  arreter(opts: { couper: boolean }): Promise<string[]> {
    return this.enFile(async () => {
      this.annulerRelecture();
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

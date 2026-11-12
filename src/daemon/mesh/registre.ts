import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { envSwarph } from './env.js';
import { meshExec } from './exec.js';
import type { AidConfig, MeshConfig } from '../config.js';
import type { Db } from '../db.js';
import type { EventStore } from '../events/store.js';
import { empreinteChemin, empreinteGateway, empreinteMesh } from '../../shared/meshes.js';
import { AidHttpError } from '../errors.js';
import { activerMesh, archiverMesh } from './identite.js';
import { MeshService, type MeshServiceDeps } from './service.js';
import { BoardReader } from './board.js';
import { SwarphReader } from './lectures.js';
import { CommitteeReader, CommitteeWriter } from './committee.js';
import { AvisMeshService } from './avis.js';

export interface ServicesMesh {
  mesh: MeshService;
  board: BoardReader;
  boardHost: BoardReader;
  swarph: SwarphReader;
  lecteur: CommitteeReader;
  ecrivain: CommitteeWriter;
  avis: AvisMeshService;
  proxySocket: string;
}
interface EntreeMesh {
  nom: string;
  config: MeshConfig;
  empreinte: string;
  erreur: string | null;
  services: ServicesMesh | null;
}

/** Une identité et un jeu de transports par mesh ; aucune activation implicite d'un rebranchement. */
export class MeshRegistry {
  readonly binaire: string | null;
  private initialisation: Promise<void> | null = null;
  private readonly entrees = new Map<string, EntreeMesh>();
  constructor(
    private readonly deps: {
      config: AidConfig;
      db: Db;
      store: EventStore;
      log: (ligne: string) => void;
      exec?: MeshServiceDeps['exec'];
      tailscale?: MeshServiceDeps['tailscale'];
    },
  ) {
    this.binaire = resoudreBinaire(deps.config.mesh.bin);
    for (const [nom, config] of Object.entries(deps.config.meshes)) {
      const entree: EntreeMesh = {
        nom,
        config: {
          ...config,
          bin: this.binaire ?? resolve(deps.config.mesh.bin),
          tailscale: deps.config.mesh.tailscale,
        },
        empreinte: '',
        erreur: null,
        services: null,
      };
      this.entrees.set(nom, entree);
    }
  }

  get principal(): ServicesMesh | null {
    return this.entrees.get('principal')?.services ?? null;
  }

  obtenir(nom = 'principal'): ServicesMesh {
    const entree = this.entrees.get(nom);
    if (!entree) throw new AidHttpError(404, 'mesh inconnu');
    if (!entree.config.cell) throw new AidHttpError(404, 'mesh désactivé');
    if (!entree.services) throw new AidHttpError(409, entree.erreur ?? 'demarrage');
    return entree.services;
  }

  configuration(nom = 'principal'): MeshConfig {
    this.obtenir(nom);
    return this.entrees.get(nom)!.config;
  }

  signature(nom: string) {
    const entree = this.entrees.get(nom);
    if (!entree) throw new AidHttpError(404, 'mesh inconnu');
    if (entree.config.cell && !entree.services)
      throw new AidHttpError(409, entree.erreur ?? 'mesh inactif');
    const config = this.configuration(nom);
    if (!config.gateway) throw new AidHttpError(409, 'gateway_requis');
    return {
      nom,
      cell: config.cell,
      gateway: empreinteGateway(config.gateway),
      proxy: empreinteChemin(config.proxySocket ?? ''),
    };
  }

  liste() {
    return [...this.entrees.values()].map((e) => ({
      nom: e.nom,
      cell: e.config.cell,
      actif: e.services !== null,
      erreur: e.erreur,
      etat: e.services?.mesh.current() ?? null,
      ecriture: !!e.services && !!e.config.proxySocket && !e.config.proxyLectureSeule,
    }));
  }

  instantane() {
    return Object.fromEntries(
      [...this.entrees.values()].flatMap((e) =>
        e.services
          ? [
              [
                e.nom,
                {
                  state: e.services.mesh.current(),
                  inbox: e.services.mesh.inbox(),
                  checkedAt: e.services.mesh.checkedAt(),
                  tailscaleManage: e.services.mesh.tailscaleManage,
                },
              ],
            ]
          : [],
      ),
    );
  }

  init(): Promise<void> {
    this.initialisation ??= Promise.all(
      [...this.entrees.values()].map(async (e) => {
        if (!e.config.cell) return;
        await this.activer(e);
        if (!e.services) return;
        try {
          await e.services.mesh.init();
        } catch {
          e.erreur = 'demarrage';
        }
      }),
    ).then(() => undefined);
    return this.initialisation;
  }

  async arreter(): Promise<void> {
    await this.initialisation;
    this.dispose();
  }

  async archiver(nom: string): Promise<void> {
    const entree = this.entrees.get(nom);
    if (!entree) throw new AidHttpError(404, 'mesh inconnu');
    if (entree.erreur !== 'rebranche') throw new AidHttpError(409, 'mesh non rebranche');
    this.deps.db.transaction(() => {
      archiverMesh(this.deps.db, nom, new Date().toISOString());
    })();
    await this.activer(entree);
    await entree.services?.mesh.init();
  }

  dispose(): void {
    for (const e of this.entrees.values()) e.services?.mesh.dispose();
  }

  private async activer(e: EntreeMesh): Promise<void> {
    try {
      e.empreinte = empreinteMesh(e.config.cell, e.config.gateway);
      if (activerMesh(this.deps.db, e.nom, e.empreinte) === 'rebranche') {
        e.erreur = 'rebranche';
        return;
      }
      if (this.binaire) {
        try {
          const resultat = await (this.deps.exec ?? meshExec)(this.binaire, ['--version'], {
            env: envSwarph(e.config),
            timeoutMs: 10_000,
          });
          if (!resultat.ok || resultat.timedOut) {
            throw new Error(resultat.stderr || resultat.spawnErrorCode || 'échec de --version');
          }
        } catch (erreur) {
          e.erreur = 'binaire';
          this.deps.log(
            `mesh ${e.nom} : binaire : ${String((erreur as Error).message).slice(0, 200)}`,
          );
          return;
        }
      }
      const mesh = new MeshService({
        ...this.deps,
        config: e.config,
        exec: this.binaire
          ? this.deps.exec
          : async (bin, args, options) =>
              bin === e.config.bin
                ? {
                    ok: false,
                    timedOut: false,
                    stdout: '',
                    stderr: 'swarph : ENOENT',
                    spawnErrorCode: 'ENOENT',
                  }
                : (this.deps.exec ?? meshExec)(bin, args, options),
        nom: e.nom,
        home: e.config.home!,
      });
      const options = {
        mesh,
        cell: e.config.cell,
        proxySocket: e.config.proxySocket,
        gateway: e.config.gateway,
        log: this.deps.log,
      };
      const lecteur = new CommitteeReader(options);
      const ecrivain = new CommitteeWriter(options);
      e.services = {
        mesh,
        board: new BoardReader(options),
        boardHost: new BoardReader({ ...options, cacheMs: 60_000 }),
        swarph: new SwarphReader({ ...options, config: e.config }),
        lecteur,
        ecrivain,
        avis: new AvisMeshService({
          db: this.deps.db,
          config: e.config,
          lecteur,
          ecrivain,
          nom: e.nom,
        }),
        proxySocket: e.config.proxySocket,
      };
      e.erreur = null;
    } catch {
      e.services?.mesh.dispose();
      e.services = null;
      e.erreur = 'demarrage';
    }
  }
}

/** Figer la recherche au démarrage, y compris les entrées relatives du PATH. */
function resoudreBinaire(bin: string): string | null {
  const candidats = isAbsolute(bin)
    ? [bin]
    : (process.env.PATH ?? '').split(delimiter).map((dossier) => resolve(dossier, bin));
  for (const candidat of candidats) {
    try {
      if (!statSync(candidat).isFile()) continue;
      accessSync(candidat, constants.X_OK);
      return candidat;
    } catch {
      // Un candidat absent, non exécutable ou inaccessible n'est pas retenu.
    }
  }
  return null;
}

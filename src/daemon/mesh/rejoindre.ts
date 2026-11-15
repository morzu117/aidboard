import { spawn } from 'node:child_process';
import { lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AidPaths } from '../paths.js';
import { normaliserGateway } from '../../shared/meshes.js';
import { nomMeshValide, type AidConfig } from '../config.js';
import { meshPaths } from './paths.js';

export type EtatRejoindre =
  | { etat: 'aucune' }
  | { etat: 'demande' }
  | { etat: 'en-attente'; code: string; expiration: number }
  | { etat: 'approuve'; temoin?: string; redemarrage?: boolean; libelle?: string }
  | { etat: 'refuse' | 'expire' }
  | { etat: 'annule'; code?: string }
  | { etat: 'a-voir'; cell?: string; mesh?: string; gateway?: string; cheminJeton?: string }
  | { etat: 'interrompue'; cell: string; mesh: string; gateway: string; cheminJeton: string }
  | { etat: 'echec'; libelle: string };

export interface DemandeRejoindre {
  gateway: string;
  cell: string;
  mesh: string;
}

const nomCell = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/;
const codeLigne = /^Code: ([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}) /;
const temoinLigne =
  /^No interactive answers were supplied; no handshake was sent\. Send your own answers to ([a-z][a-z0-9-]{0,62}[a-z0-9])\.$/;

function resultat(raison: string): EtatRejoindre {
  if (raison === 'access_denied') return { etat: 'refuse' };
  if (raison === 'expired_token' || raison === 'join request expired') return { etat: 'expire' };
  if (
    raison === 'authenticated identity check failed; the private credential file is retained' ||
    raison === 'invalid token pickup response; operator recovery may be needed'
  )
    return { etat: 'a-voir' };
  const raisons = [
    'symlinked credential directory refused',
    'credential directory must belong to this user',
    'invalid join response',
    'gateway redirect refused',
    'gateway response too large',
    'invalid gateway response',
    'already_redeemed',
    'name_unavailable',
    'pickup_failed',
    'invalid peer name',
    'invalid gateway URL',
    'native Windows credential storage is unsupported; use Linux or WSL',
  ];
  if (raisons.includes(raison)) return { etat: 'echec', libelle: raison };
  if (/^join request refused \(HTTP [0-9]{3}\)$/.test(raison))
    return { etat: 'echec', libelle: raison };
  for (const prefixe of [
    'non-tailnet HTTP requires --allow-unsafe-http',
    'gateway request failed',
    'local storage failure or cancellation',
  ]) {
    if (raison.startsWith(prefixe)) return { etat: 'echec', libelle: prefixe };
  }
  return { etat: 'echec', libelle: 'échec' };
}

function existe(chemin: string): boolean {
  try {
    lstatSync(chemin);
    return true;
  } catch (erreur) {
    if ((erreur as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw erreur;
  }
}

export function validerGatewayRejoindre(gateway: string): string {
  const adresse = normaliserGateway(gateway);
  const url = new URL(adresse);
  const octets = url.hostname.split('.').map(Number);
  const tailnet =
    url.hostname.endsWith('.ts.net') ||
    (isIPv4(url.hostname) && octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127);
  if (url.protocol === 'http:' && !tailnet)
    throw new Error('non-tailnet HTTP requires --allow-unsafe-http');
  return adresse;
}

/** Un lanceur par daemon ; aucun contenu de jeton ni sortie brute n'est exposé. */
export class LanceurRejoindre {
  private courant: EtatRejoindre = { etat: 'aucune' };
  private arreter?: () => Promise<void>;
  private actif = false;
  private readonly fichierEtat?: string;

  constructor(
    private readonly config: Pick<AidConfig, 'mesh' | 'meshes'>,
    private readonly enregistrer?: (demande: DemandeRejoindre) => {
      redemarrage: boolean;
      libelle?: string;
    },
    paths?: Pick<AidPaths, 'home'>,
  ) {
    if (!paths) return;
    this.fichierEtat = join(paths.home, 'rejoindre.json');
    try {
      const demande = JSON.parse(readFileSync(this.fichierEtat, 'utf8')) as Record<string, unknown>;
      if (
        !demande ||
        typeof demande.cell !== 'string' ||
        !nomCell.test(demande.cell) ||
        typeof demande.mesh !== 'string' ||
        !nomMeshValide(demande.mesh) ||
        typeof demande.gateway !== 'string' ||
        typeof demande.depuis !== 'number' ||
        !Number.isFinite(demande.depuis) ||
        Object.keys(demande).some((cle) => !['cell', 'mesh', 'gateway', 'depuis'].includes(cle))
      )
        return;
      validerGatewayRejoindre(demande.gateway);
      const chemins = meshPaths({ ...this.config.mesh, cell: demande.cell });
      this.courant = {
        etat: existe(chemins.tokenFile) ? 'a-voir' : 'interrompue',
        cell: demande.cell,
        mesh: demande.mesh,
        gateway: demande.gateway,
        cheminJeton: chemins.tokenFile,
      };
    } catch {
      // Un état illisible ou mal formé ne permet aucune reprise.
    } finally {
      this.effacerEtat();
    }
  }

  private effacerEtat(): void {
    if (!this.fichierEtat) return;
    try {
      unlinkSync(this.fichierEtat);
    } catch {
      // Une absence ou un refus de suppression ne doit pas masquer l'état final.
    }
  }

  etat(): EtatRejoindre {
    if (this.courant.etat === 'interrompue' && existe(this.courant.cheminJeton))
      this.courant = { ...this.courant, etat: 'a-voir' };
    return { ...this.courant };
  }

  lancer(demande: DemandeRejoindre): void {
    if (this.actif) throw new Error('Une demande est déjà en cours');
    const gateway = validerGatewayRejoindre(demande.gateway);
    if (!nomCell.test(demande.cell)) throw new Error('invalid peer name');
    if (!nomMeshValide(demande.mesh)) throw new Error('Nom de mesh invalide');
    if (Object.hasOwn(this.config.meshes, demande.mesh)) throw new Error('Mesh déjà configuré');
    const home = this.config.mesh.home ?? process.env.HOME ?? homedir();
    const chemins = meshPaths(
      { cell: demande.cell, home, cellFile: '', stateRoot: '', inboxLog: '' },
      home,
    );
    if (existe(chemins.tokenFile)) throw new Error('Fichier de jeton déjà présent');
    if (existe(chemins.tokenFile.replace(/\.peer_token$/, '.join.json')))
      throw new Error('Fichier join.json déjà présent');
    const env: NodeJS.ProcessEnv = { HOME: home, PYTHONUNBUFFERED: '1' };
    for (const cle of Object.keys(process.env)) {
      if (['PATH', 'LANG', 'SSL_CERT_FILE', 'SSL_CERT_DIR'].includes(cle) || cle.startsWith('LC_'))
        env[cle] = process.env[cle];
    }
    if (this.fichierEtat) {
      try {
        writeFileSync(
          this.fichierEtat,
          JSON.stringify({ cell: demande.cell, mesh: demande.mesh, gateway, depuis: Date.now() }),
          { mode: 0o600, flag: 'wx' },
        );
      } catch (erreur) {
        if ((erreur as NodeJS.ErrnoException).code === 'EEXIST')
          throw new Error(`Demande précédente non effacée : supprimer ${this.fichierEtat}`);
        throw erreur;
      }
    }
    this.actif = true;
    this.courant = { etat: 'demande' };
    const enfant = spawn(this.config.mesh.bin, ['join', gateway, '--name', demande.cell], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let code: string | undefined;
    let temoin: string | undefined;
    let issue: EtatRejoindre = { etat: 'echec', libelle: 'échec' };
    let interruption: 'annule' | 'expire' | undefined;
    let tue = false;
    let minuterieArret: ReturnType<typeof setTimeout> | undefined;
    let termine = false;
    const fin = new Promise<void>((resolve) => {
      const terminer = (statut: number | null) => {
        if (termine) return;
        termine = true;
        clearTimeout(delai);
        clearTimeout(minuterieArret);
        if (tue) {
          for (const chemin of [
            chemins.tokenFile,
            chemins.tokenFile.replace(/\.peer_token$/, '.join.json'),
          ]) {
            try {
              const fichier = lstatSync(chemin);
              if (fichier.isFile() && fichier.size === 0) unlinkSync(chemin);
            } catch {
              // Une absence ou un refus de suppression ne justifie jamais de lire le jeton.
            }
          }
        }
        let jeton;
        try {
          jeton = lstatSync(chemins.tokenFile);
        } catch {
          // Aucun contenu n'est lu, même si le chemin est un lien symbolique.
        }
        if (statut === 0 && jeton?.isFile() && jeton.size > 0 && (jeton.mode & 0o777) === 0o600)
          this.courant = { etat: 'approuve', ...(temoin ? { temoin } : {}) };
        else if (jeton || statut === 0) this.courant = { etat: 'a-voir' };
        else if (interruption === 'annule')
          this.courant = { etat: 'annule', ...(code ? { code } : {}) };
        else if (interruption === 'expire') this.courant = { etat: 'expire' };
        else this.courant = issue;
        if (this.courant.etat === 'approuve' && this.enregistrer) {
          this.courant = { ...this.courant, ...this.enregistrer({ ...demande, gateway }) };
        }
        this.effacerEtat();
        this.actif = false;
        this.arreter = undefined;
        resolve();
      };
      enfant.once('error', () => {
        if (enfant.pid === undefined) {
          issue = { etat: 'echec', libelle: 'swarph introuvable' };
          terminer(null);
        }
      });
      enfant.once('close', terminer);
    });
    const interrompre = (motif: 'annule' | 'expire'): Promise<void> => {
      if (!interruption) {
        interruption = motif;
        enfant.kill('SIGINT');
        minuterieArret = setTimeout(() => {
          tue = true;
          enfant.kill('SIGKILL');
        }, 10_000);
      }
      return fin;
    };
    this.arreter = () => interrompre('annule');
    const delai = setTimeout(() => void interrompre('expire'), 16 * 60_000);
    const lire = (flux: NodeJS.ReadableStream, erreur: boolean) => {
      let ligne = '';
      let tronquee = false;
      let total = 0;
      flux.on('data', (bloc: Buffer) => {
        // On draine toujours les pipes, mais on ne conserve au plus que 4096 octets par ligne.
        if (total > 1024 * 1024) return;
        for (const octet of bloc) {
          if (++total > 1024 * 1024) {
            if (erreur) issue = { etat: 'echec', libelle: 'échec' };
            ligne = '';
            break;
          }
          if (octet === 10) {
            if (!tronquee) interpreter(ligne.replace(/\r$/, ''), erreur);
            else if (erreur && ligne.startsWith('swarph join: '))
              issue = { etat: 'echec', libelle: 'échec' };
            ligne = '';
            tronquee = false;
          } else if (ligne.length < 4096) ligne += String.fromCharCode(octet);
          else tronquee = true;
        }
      });
      flux.on('end', () => {
        if (erreur && tronquee && ligne.startsWith('swarph join: '))
          issue = { etat: 'echec', libelle: 'échec' };
        if (ligne && !tronquee && total <= 1024 * 1024) interpreter(ligne, erreur);
      });
    };
    const interpreter = (ligne: string, erreur: boolean) => {
      if (erreur) {
        if (ligne.startsWith('swarph join: ')) {
          // La raison brute reste locale et est immédiatement réduite à une liste fermée.
          issue = resultat(ligne.slice(13));
        }
        return;
      }
      const trouve = codeLigne.exec(ligne);
      if (trouve && !code) {
        code = trouve[1]!;
        if (!interruption)
          this.courant = { etat: 'en-attente', code, expiration: Date.now() + 15 * 60_000 };
      }
      const temoinTrouve = temoinLigne.exec(ligne);
      if (temoinTrouve) temoin = temoinTrouve[1];
    };
    lire(enfant.stdout, false);
    lire(enfant.stderr, true);
  }

  async annuler(): Promise<void> {
    await this.arreter?.();
  }
}

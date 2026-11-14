import { spawn } from 'node:child_process';
import { lstatSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
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
  | { etat: 'a-voir' }
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
    (octets.length === 4 && octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127);
  if (url.protocol === 'http:' && !tailnet)
    throw new Error('non-tailnet HTTP requires --allow-unsafe-http');
  return adresse;
}

/** Un lanceur par daemon ; aucun contenu de jeton ni sortie brute n'est exposé. */
export class LanceurRejoindre {
  private courant: EtatRejoindre = { etat: 'aucune' };
  private arreter?: () => Promise<void>;
  private actif = false;

  constructor(
    private readonly config: Pick<AidConfig, 'mesh' | 'meshes'>,
    private readonly enregistrer?: (demande: DemandeRejoindre) => {
      redemarrage: boolean;
      libelle?: string;
    },
  ) {}

  etat(): EtatRejoindre {
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
    const env = { ...process.env, HOME: home, PYTHONUNBUFFERED: '1' };
    for (const cle of [
      'SWARPH_SELF',
      'MESH_GATEWAY_URL',
      'MESH_GATEWAY_TOKEN',
      'GH_TOKEN',
      'GITHUB_TOKEN',
    ])
      delete (env as NodeJS.ProcessEnv)[cle];
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
    let echec = false;
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
        if (echec && enfant.pid === undefined) this.courant = issue;
        else if (interruption === 'annule')
          this.courant = { etat: 'annule', ...(code ? { code } : {}) };
        else if (interruption === 'expire') this.courant = { etat: 'expire' };
        else if (statut === 0 && !echec) {
          try {
            const jeton = lstatSync(chemins.tokenFile);
            this.courant =
              jeton.isFile() && jeton.size > 0 && (jeton.mode & 0o777) === 0o600
                ? { etat: 'approuve', ...(temoin ? { temoin } : {}) }
                : { etat: 'a-voir' };
          } catch {
            this.courant = { etat: 'a-voir' };
          }
        } else this.courant = issue;
        if (this.courant.etat === 'approuve' && this.enregistrer) {
          this.courant = { ...this.courant, ...this.enregistrer(demande) };
        }
        this.actif = false;
        this.arreter = undefined;
        resolve();
      };
      enfant.once('error', () => {
        echec = true;
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

// Chantier 31 (mode host par le tailnet) : ce que le daemon lit de Tailscale et ce que le Mac
// voit du mode host. Aucun jeton, aucun secret : le nom `.ts.net` et le login sont des données de
// Julien, montrées sur son Mac seulement.

/** D173 : `tailscale status --json`, la part qui sert au mode host. */
export interface LectureTailnet {
  /** `absent` : binaire introuvable ; `stopped` : Tailscale ne tourne pas ou ne répond pas */
  etat: 'running' | 'stopped' | 'absent';
  /** `Self.DNSName` sans le point final, null s'il manque (MagicDNS coupé) */
  nom: string | null;
  /** le login du compte du Mac, null s'il manque (nœud taggé) */
  compte: string | null;
}

/** D173 : `tailscale serve status --json`. */
export interface LectureServe {
  /**
   * `ok` : Serve vise le port des appareils en HTTPS ; `absent` : aucun service ;
   * `autre` : Serve tourne, mais pas vers ce port ; `illisible` : sortie inattendue
   */
  etat: 'ok' | 'absent' | 'autre' | 'illisible';
  /** un Funnel est actif : quelque chose de ce Mac est sur internet par Serve */
  funnel: boolean;
  /** D182 : ports locaux interdits que Serve expose (daemon, pont Tauri, artefacts) */
  interdits: number[];
}

/** D172, D173 : `GET /api/host`, sur le port du Mac seulement. */
export interface EtatModeHost {
  actif: boolean;
  /** le port des appareils (D171) */
  port: number;
  tailnet: LectureTailnet;
  serve: LectureServe;
  /** la commande à copier si Serve ne vise pas le port des appareils (D37 : A-I-D ne la lance pas) */
  commande: string;
}

/** GET et PUT /api/host (D172) : l'état lu de Tailscale, plus celui du port des appareils. */
export interface EtatModeHostDaemon extends EtatModeHost {
  code: boolean;
  push: boolean;
  abonnements: number;
  /** le port des appareils écoute, et le nom du Mac est lu */
  disponible: boolean;
  raison: string | null;
}

/**
 * Chantier 31 (D175) : l'état vu par un appareil. Construit champ par champ : un champ ajouté
 * plus tard à `StateSnapshot` n'arrive pas ici tant qu'il n'y est pas ajouté.
 */
export type RaisonAppareil = 'permission' | 'question' | 'autre';

export interface EtatPourAppareil {
  lastEventId: string | null;
  workspaces: Array<{ id: string; name: string }>;
  topics: Array<{
    id: string;
    workspaceId: string;
    slug: string;
    title: string;
    type: string;
    branch: string;
    state: string;
    phase: string | null;
    prNumber: number | null;
    createdAt: string;
    updatedAt: string;
  }>;
  runs: Array<{ id: string; topicId: string; state: string; createdAt: string }>;
  actions: Array<{
    id: string;
    topicId: string | null;
    state: string;
    startedAt: string;
    finishedAt: string | null;
  }>;
  agents: Array<{
    id: string;
    runId: string;
    kind: string;
    role: string;
    transport: string;
    status: string;
    statusReason: RaisonAppareil | null;
    statusAt: string | null;
    pausedAt: string | null;
    createdAt: string;
    updatedAt: string;
    /** à la place de `pending`, dont seuls la question et les choix filtrés sont montrés */
    attend: boolean;
    question?: { coupee: boolean; pendingId: string; texte: string; options: string[] };
    tour?: { id: string; resume: string | null; marque: 'relu' | 'a_reprendre' | null };
  }>;
  mesh?: {
    state: {
      connected: boolean;
      tailscale: string;
      monitor: string;
      pending: number;
      since: string | null;
      cell: string;
    };
    /** jamais `content` */
    inbox: Array<{
      id: number;
      from: string;
      kind: string;
      createdAt: string;
      seenAt: string | null;
    }>;
  };
}

// Chantier 31 (D176) : l'appairage vu du Mac.
export type RaisonAnnulation = 'deux-reclamations' | 'remplacee' | 'refusee' | 'coupee';

export type EtatDemande =
  | 'attente' // créée sur le Mac, QR affiché, personne n'a réclamé
  | 'reclamee' // un appareil a réclamé : code court à comparer sur le Mac
  | 'approuvee' // approuvée sur le Mac : l'appareil n'a pas encore pris son accès
  | 'consommee' // l'appareil a pris son accès
  | 'annulee'
  | 'expiree';

/** Ce que le Mac voit de la demande en cours (D176). */
export interface VueDemande {
  id: string;
  etat: EtatDemande;
  expireA: string;
  codeCourt: string | null;
  nom: string | null;
  identite: string | null;
  raison: RaisonAnnulation | null;
}

// Chantier 31 (D177) : un appareil du registre, jamais son empreinte.
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

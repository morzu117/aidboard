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
  /** le port des appareils écoute, et le nom du Mac est lu */
  disponible: boolean;
  raison: string | null;
}

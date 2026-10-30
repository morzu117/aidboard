import type { AgentSettings, ModelOption } from '../../shared/agentSettings.js';
/** Défini dans le partagé (D65) : le front en dépend sans dépendre du daemon. */
import type { ConversationEvent } from '../../shared/conversation.js';
export type { ConversationEvent };

export interface ConversationDriverOptions {
  bin: string;
  cwd: string;
  /** Déjà filtré par l'appelant (`agentEnv` de `pty/spawn.ts`) : le pilote ne choisit pas l'environnement. */
  env: NodeJS.ProcessEnv;
  sessionId: string;
  resume: boolean;
  extraArgs?: string[];
  /** Chantier 16 (D67) : réglages au lancement ; absent = ceux de la CLI. */
  settings?: AgentSettings;
  /** D70 : dossier des pièces jointes, lisible par l'agent sans demande. */
  attachmentsDir?: string;
}

/** Pièce jointe déjà déposée sur disque par le daemon (D70) : le pilote la lit ou la cite par son chemin. */
export interface AttachedFile {
  path: string;
  name: string;
  type: string;
}

/** Les formats d'image que claude et codex acceptent en ligne ; le reste est cité par son chemin. */
export const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Le texte du message, suivi des chemins des pièces jointes que le modèle ne reçoit pas en ligne. */
export function withAttachmentPaths(text: string, files: AttachedFile[]): string {
  const cites = files.filter((f) => !INLINE_IMAGE_TYPES.has(f.type));
  if (cites.length === 0) return text;
  const liste = cites.map((f) => `- ${f.path}`).join('\n');
  return `${text}${text ? '\n\n' : ''}Pièces jointes (à lire à ces chemins) :\n${liste}`;
}

/** Contrat D59 : un pilote par agent conversationnel, consommé par `AgentManager` et le canal WS. */
export interface ConversationDriver {
  readonly sessionId: string;
  start(): void;
  send(text: string, files?: AttachedFile[]): void;
  interrupt(): void;
  answer(requestId: string, decision: 'yes' | 'always' | 'no'): void;
  /** D68 : appliqué sans relancer le process (claude : tout de suite ; codex : au tour suivant). */
  configure(settings: AgentSettings): void;
  /** D71 : modèles annoncés par la CLI, vide tant qu'elle n'a rien dit. */
  catalog?(): ModelOption[];
  stop(): Promise<void>;
  onEvent(cb: (event: ConversationEvent) => void): () => void;
}

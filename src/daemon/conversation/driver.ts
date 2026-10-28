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
}

/** Contrat D59 : un pilote par agent conversationnel, consommé par `AgentManager` et le canal WS. */
export interface ConversationDriver {
  readonly sessionId: string;
  start(): void;
  send(text: string): void;
  interrupt(): void;
  answer(requestId: string, decision: 'yes' | 'always' | 'no'): void;
  stop(): Promise<void>;
  onEvent(cb: (event: ConversationEvent) => void): () => void;
}

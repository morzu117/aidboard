import type { PendingRequest } from '../../shared/model.js';

/** Flux d'événements normalisés D59 : format A-I-D, jamais celui d'une CLI d'agent donnée. */
export type ConversationEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'message'; role: 'assistant' | 'user'; text: string }
  | { type: 'thinking' }
  | { type: 'tool_start'; toolId: string; name: string; input: unknown }
  | { type: 'tool_end'; toolId: string; output: string; isError: boolean }
  | { type: 'request'; request: PendingRequest }
  | { type: 'turn_end'; ok: boolean; costUsd?: number; durationMs?: number; error?: string }
  | { type: 'exit'; code: number | null; signal: NodeJS.Signals | null; message?: string }
  | { type: 'request_cancelled'; requestId: string };

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

import type { PendingOption, PendingRequest } from './model.js';

/** Pièce jointe d'un message utilisateur (D70) : ce que le fil affiche, jamais le contenu. */
export interface AttachmentInfo {
  name: string;
  type: string;
  size: number;
}

/** Flux d'événements normalisés D59 : format A-I-D, jamais celui d'une CLI d'agent donnée. */
export type ConversationEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'message'; role: 'assistant' | 'user'; text: string; attachments?: AttachmentInfo[] }
  | { type: 'thinking' }
  | { type: 'tool_start'; toolId: string; name: string; input: unknown }
  | { type: 'tool_end'; toolId: string; output: string; isError: boolean }
  | { type: 'request'; request: PendingRequest }
  | { type: 'turn_end'; ok: boolean; costUsd?: number; durationMs?: number; error?: string }
  | { type: 'exit'; code: number | null; signal: NodeJS.Signals | null; message?: string }
  // Chantier 17 (D75) : le lien avec un agent distant ; l'agent, lui, continue sur le serveur.
  // `sessionFound` faux : la session tmux avait disparu, l'agent a été relancé par reprise de session.
  | { type: 'connection_lost'; at: string }
  | { type: 'connection_resumed'; at: string; afterMs: number; sessionFound: boolean }
  | { type: 'resume_failed'; reason: string }
  // Chantier 17 (R.5) : la réponse donnée à une demande ; `auto` : par une règle du serveur, sans l'opérateur.
  | { type: 'request_answered'; requestId: string; answer: PendingOption['answer']; auto?: boolean }
  | { type: 'request_cancelled'; requestId: string };

/** Une ligne `agent_messages` telle que rendue par `/ws/agent/:agentId` (D65). */
export interface AgentStreamItem {
  seq: number;
  at: string;
  event: ConversationEvent;
  /** Question marquée (A.7) : présent et vrai seulement sur l'historique, jamais en direct. */
  marked?: boolean;
}

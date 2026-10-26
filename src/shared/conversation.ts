import type { PendingRequest } from './model.js';

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

/** Une ligne `agent_messages` telle que rendue par `/ws/agent/:agentId` (D65). */
export interface AgentStreamItem {
  seq: number;
  at: string;
  event: ConversationEvent;
}

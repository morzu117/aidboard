import type { ConversationEvent } from '../daemon/conversation/driver.js';

export type { ConversationEvent };

/** Une ligne `agent_messages` telle que rendue par `/ws/agent/:agentId` (D65). */
export interface AgentStreamItem {
  seq: number;
  at: string;
  event: ConversationEvent;
}

import type { AgentStreamItem } from '../../../src/shared/conversation.js';
import type { PendingRequest } from '../../../src/shared/model.js';

export interface ToolCall {
  toolId: string;
  name: string;
  input: unknown;
  output?: string;
  isError?: boolean;
  done: boolean;
  interrupted?: boolean;
}

export type Block =
  | { kind: 'message'; seq: number; at: string; role: 'user' | 'assistant'; text: string }
  | { kind: 'tools'; seq: number; calls: ToolCall[] }
  | { kind: 'decision'; seq: number; request: PendingRequest }
  | { kind: 'turn_end'; seq: number; ok: false; error?: string }
  | { kind: 'exit'; seq: number; message?: string };

export interface Turn {
  id: number;
  blocks: Block[];
}

// Un tour = message utilisateur puis ce que l'agent produit jusqu'au turn_end ; session/thinking/request_cancelled n'ont pas de ligne propre.
export function buildTurns(items: AgentStreamItem[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  let openTools: ToolCall[] = [];
  let openToolsSeq = 0;

  const ensureTurn = (seq: number) => {
    if (!current) current = { id: seq, blocks: [] };
  };
  const closeTools = () => {
    if (openTools.length > 0 && current)
      current.blocks.push({ kind: 'tools', seq: openToolsSeq, calls: openTools });
    openTools = [];
  };
  // turn_end/exit ferment les outils encore ouverts : sans quoi le spinner tourne pour toujours.
  const interrupteOutilsOuverts = () => {
    for (const c of openTools) if (!c.done) c.interrupted = true;
  };
  const closeTurn = () => {
    closeTools();
    if (current) turns.push(current);
    current = null;
  };

  for (const item of items) {
    const { seq, event } = item;
    switch (event.type) {
      case 'message':
        closeTools();
        if (event.role === 'user') {
          closeTurn();
          current = {
            id: seq,
            blocks: [{ kind: 'message', seq, at: item.at, role: 'user', text: event.text }],
          };
        } else {
          ensureTurn(seq);
          current!.blocks.push({
            kind: 'message',
            seq,
            at: item.at,
            role: 'assistant',
            text: event.text,
          });
        }
        break;
      case 'tool_start':
        ensureTurn(seq);
        if (openTools.length === 0) openToolsSeq = seq;
        openTools.push({ toolId: event.toolId, name: event.name, input: event.input, done: false });
        break;
      case 'tool_end': {
        const call = openTools.find((c) => c.toolId === event.toolId);
        if (call) {
          call.output = event.output;
          call.isError = event.isError;
          call.done = true;
        }
        break;
      }
      case 'request':
        closeTools();
        ensureTurn(seq);
        current!.blocks.push({ kind: 'decision', seq, request: event.request });
        break;
      case 'turn_end':
        interrupteOutilsOuverts();
        closeTools();
        if (!event.ok) {
          ensureTurn(seq);
          current!.blocks.push({ kind: 'turn_end', seq, ok: false, error: event.error });
        }
        closeTurn();
        break;
      case 'exit':
        interrupteOutilsOuverts();
        closeTools();
        ensureTurn(seq);
        current!.blocks.push({ kind: 'exit', seq, message: event.message });
        closeTurn();
        break;
      case 'session':
      case 'thinking':
      case 'request_cancelled':
        break;
    }
  }
  closeTurn();
  return turns;
}

// Toutes les erreurs de tour n'évoquent pas une interruption volontaire : seules ces deux formes la distinguent.
export function tourInterrompu(error: string | undefined): boolean {
  return /interrompu|error_during_execution/i.test(error ?? '');
}

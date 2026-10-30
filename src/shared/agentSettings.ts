/** Mode d'exécution d'un agent conversationnel (D66) : jamais de contournement total des permissions. */
export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'plan';

/** Réglages d'un agent `stream` (D67) : `null` = la valeur par défaut de la CLI. */
export interface AgentSettings {
  mode: PermissionMode;
  model: string | null;
  effort: string | null;
}

export interface ModeOption {
  id: PermissionMode;
  label: string;
}

export interface ModelOption {
  id: string;
  label: string;
  efforts: string[];
}

/** Ce que le composer peut proposer pour un agent donné (D71). */
export interface AgentOptions {
  modes: ModeOption[];
  models: ModelOption[];
  efforts: string[];
}

export const DEFAULT_SETTINGS: AgentSettings = { mode: 'default', model: null, effort: null };

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export const MODES: Record<'claude' | 'codex', ModeOption[]> = {
  claude: [
    { id: 'default', label: 'Demander' },
    { id: 'acceptEdits', label: 'Modifs auto' },
    { id: 'auto', label: 'Auto' },
    { id: 'plan', label: 'Plan' },
  ],
  codex: [
    { id: 'default', label: 'Demander' },
    { id: 'auto', label: 'Auto' },
  ],
};

export const CLAUDE_MODELS: ModelOption[] = [
  { id: 'fable', label: 'Fable 5.1', efforts: CLAUDE_EFFORTS },
  { id: 'opus', label: 'Opus 5.5', efforts: CLAUDE_EFFORTS },
  { id: 'sonnet', label: 'Sonnet 5.5', efforts: CLAUDE_EFFORTS },
  { id: 'haiku', label: 'Haiku 5.5', efforts: CLAUDE_EFFORTS },
];

export function agentOptions(kind: 'claude' | 'codex', codexModels: ModelOption[]): AgentOptions {
  const models = kind === 'claude' ? CLAUDE_MODELS : codexModels;
  const efforts =
    kind === 'claude' ? CLAUDE_EFFORTS : [...new Set(models.flatMap((m) => m.efforts))];
  return { modes: MODES[kind], models, efforts };
}

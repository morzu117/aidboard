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
  /** Chantier 22 (D80) : les commandes `/` du composer, celles d'A-I-D d'abord. */
  commands: AgentCommand[];
}

/** Chantier 22 (D80) : une commande `/` du composer. */
export interface AgentCommand {
  name: string;
  description: string;
  /** `aid` : exécutée par A-I-D, la même pour tous les agents (D81) ; `agent` : annoncée et exécutée par l'agent (D82). */
  source: 'aid' | 'agent';
  /** Arguments attendus, pour l'aide (`<id>`) ; absent : aucun. */
  args?: string;
}

/** D81 : les commandes qu'A-I-D exécute lui-même, pour tous les agents ; elles ne partent jamais telles quelles. */
export const AID_COMMANDS: AgentCommand[] = [
  { name: 'model', args: '<id>', description: 'Changer de modèle', source: 'aid' },
  {
    name: 'effort',
    args: '<niveau>',
    description: 'Changer l’effort de raisonnement',
    source: 'aid',
  },
  { name: 'mode', args: '<id>', description: 'Changer le mode d’exécution', source: 'aid' },
  { name: 'compact', description: 'Compacter la conversation', source: 'aid' },
  { name: 'stop', description: 'Interrompre le tour en cours', source: 'aid' },
  { name: 'aide', description: 'Lister les commandes', source: 'aid' },
];

/** D82 : celles d'A-I-D, puis celles de l'agent ; un nom déjà porté par A-I-D, ou en double, n'apparaît qu'une fois. */
export function withAidCommands(agent: AgentCommand[]): AgentCommand[] {
  const vus = new Set(AID_COMMANDS.map((c) => c.name));
  const propres = agent.filter((c) => !vus.has(c.name) && Boolean(vus.add(c.name)));
  return [...AID_COMMANDS, ...propres];
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

export function agentOptions(
  kind: 'claude' | 'codex',
  codexModels: ModelOption[],
  agentCommands: AgentCommand[] = [],
): AgentOptions {
  const models = kind === 'claude' ? CLAUDE_MODELS : codexModels;
  const efforts =
    kind === 'claude' ? CLAUDE_EFFORTS : [...new Set(models.flatMap((m) => m.efforts))];
  return { modes: MODES[kind], models, efforts, commands: withAidCommands(agentCommands) };
}

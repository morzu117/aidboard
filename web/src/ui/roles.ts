import type { Agent } from '../../../src/shared/model.js';

// « free » : agent lancé à la main, hors de la chaîne plan → dev → review → triage → retro.
const LABELS: Partial<Record<Agent['role'], string>> = {
  free: 'libre',
  orchestrator: 'orchestrateur',
};

export const roleLabel = (role: Agent['role']): string => LABELS[role] ?? role;

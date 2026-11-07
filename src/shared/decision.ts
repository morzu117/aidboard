/** Même décision pour le badge, « À traiter » et les notifications push. */
export const attendDecision = (agent: {
  question?: unknown;
  attend: boolean;
  statusReason: string | null;
}) => !!agent.question || (agent.attend && agent.statusReason === 'permission');

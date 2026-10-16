// Statut estimé d'un agent sans hooks (plan 06, E8) : on ne lit que le silence du terminal et ses dernières lignes.
// C'est une estimation, affichée comme telle ; dès qu'un hook parle, elle se tait.

export type Estimate = 'working' | 'idle' | 'needs_input';

export const WORKING_WITHIN_MS = 5_000;
export const PROMPT_AFTER_MS = 3_000;
export const IDLE_AFTER_MS = 30_000;

// Ce qu'affichent les TUI qui attendent une réponse : choix numéroté, (y/n), « Do you want to… ? »
const PROMPTS = [
  /\((y\/n|o\/n)\)|\[(y\/n|Y\/n|y\/N)\]/,
  /^\s*[❯›>]\s*1\.\s+\S/,
  /\b(Do you want to|Would you like to|Voulez-vous|Veux-tu)\b.*\?\s*$/i,
];

export function lastLine(screen: string[]): string {
  for (let i = screen.length - 1; i >= 0; i--) {
    const l = screen[i]!.trim();
    if (l) return l.slice(0, 200);
  }
  return '';
}

export function promptDetected(screen: string[]): boolean {
  const tail = screen.filter((l) => l.trim()).slice(-8);
  return tail.some((l) => PROMPTS.some((re) => re.test(l)));
}

/** Le statut à émettre, ou null s'il ne change pas. */
export function estimate(
  silenceMs: number,
  screen: string[],
  previous: Estimate | null,
): { status: Estimate; promptDetected: boolean; lastLine: string } | null {
  const prompt = promptDetected(screen);
  let status: Estimate | null = null;
  if (silenceMs < WORKING_WITHIN_MS && !(prompt && silenceMs >= PROMPT_AFTER_MS))
    status = 'working';
  if (prompt && silenceMs >= PROMPT_AFTER_MS) status = 'needs_input';
  else if (silenceMs >= IDLE_AFTER_MS) status = 'idle';
  if (!status || status === previous) return null;
  return { status, promptDetected: prompt, lastLine: lastLine(screen) };
}

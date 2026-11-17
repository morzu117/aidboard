import { readFileSync } from 'node:fs';

// Les patrons sont le contrat de l'inventaire ; les ids stables restent prioritaires.
const inventaire = JSON.parse(
  readFileSync(new URL('./audit/inventaire.json', import.meta.url), 'utf8'),
) as string[];
const patrons = inventaire
  .filter((id) => id.includes('*'))
  .map((id) => ({
    id,
    expression: new RegExp(
      `^${id
        .split('*')
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.+?')}$`,
    ),
  }));
export function normaliserNode(id: string): string {
  if (inventaire.includes(id)) return id;
  return patrons.find((p) => p.expression.test(id))?.id ?? id;
}

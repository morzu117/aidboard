import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function controlerCouverture(
  inventaire: string,
  exceptions: string,
  releve: string,
): string[] {
  const ids = JSON.parse(readFileSync(inventaire, 'utf8')) as string[];
  const nonCouverts = JSON.parse(readFileSync(exceptions, 'utf8')) as {
    node: string;
    raison: string;
  }[];
  const clics = readFileSync(releve, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(
      (ligne) =>
        JSON.parse(ligne) as { node: string | null; action?: string | null; element: string },
    );
  const couverts = new Set(clics.flatMap((c) => [c.node, c.action]).filter(Boolean));
  const erreurs: string[] = [];
  for (const exception of nonCouverts) {
    if (!exception.raison?.trim()) erreurs.push(`Raison absente : ${exception.node}`);
    if (!ids.includes(exception.node)) erreurs.push(`Absent de l'inventaire : ${exception.node}`);
    if (couverts.has(exception.node))
      erreurs.push(`Cliquet : retirer ${exception.node} des non-couverts`);
  }
  for (const id of ids) {
    if (!couverts.has(id) && !nonCouverts.some((e) => e.node === id))
      erreurs.push(`Jamais cliqué : ${id}`);
  }
  // Un clic sur un élément sans identifiant n'établit aucune couverture.
  return erreurs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const erreurs = controlerCouverture(
      new URL('./audit/inventaire.json', import.meta.url).pathname,
      new URL('./audit/non-couverts.json', import.meta.url).pathname,
      join(tmpdir(), 'aid-couverture-ui.jsonl'),
    );
    if (erreurs.length) {
      console.error(erreurs.join('\n'));
      process.exitCode = 1;
    } else console.log('Couverture UI : inventaire couvert ou motivé, cliquet respecté.');
  } catch (erreur) {
    console.error(`Contrôle de couverture impossible : ${String(erreur)}`);
    process.exitCode = 1;
  }
}

import { link, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { routage, type DatesVerification } from '../../shared/routage.js';
import type { Ask } from '../../shared/swairm-ask.js';

export function lireVerifications(dossier: string): DatesVerification {
  const dates: DatesVerification = {};
  for (const fournisseur of routage.challenge) {
    try {
      dates[fournisseur] = readFileSync(join(dossier, `.verifie-${fournisseur}`), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return dates;
}

export async function enregistrerVerifications(dossier: string, demande: Ask): Promise<void> {
  const dates = lireVerifications(dossier);
  const nouveaux = routage.challenge.filter(
    (fournisseur) =>
      !dates[fournisseur] &&
      demande.avis.some(
        (avis) => avis.etat === 'ok' && avis.modele_demande.startsWith(`${fournisseur}:`),
      ),
  );
  if (!nouveaux.length) return;

  const temporaire = await mkdtemp(join(dossier, '.verification-'));
  try {
    const source = join(temporaire, 'date');
    await writeFile(source, demande.genere_a, { mode: 0o600 });
    for (const fournisseur of nouveaux) {
      try {
        // Publie la date entière et préserve celle déjà enregistrée.
        await link(source, join(dossier, `.verifie-${fournisseur}`));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
  } finally {
    await rm(temporaire, { recursive: true, force: true });
  }
}

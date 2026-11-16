import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { optionsNavigateur, preparerAudit } from './audit/environnement.js';
import { explorer } from './audit/explorateur.js';
import { CLASSES } from './audit/classement.js';

test.use({ launchOptions: optionsNavigateur });
test('explorateur : rapport structuré de deux écrans, sans assertion sur les trouvailles', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const environnement = await preparerAudit(browser);
  const dossier = await mkdtemp(join(tmpdir(), 'aid-audit-essai-'));
  try {
    const rapport = await explorer({
      ...environnement,
      ecrans: environnement.ecrans.filter((e) => e.nom === 'appareil /' || e.nom === 'PDA /pda'),
      dossier,
    });
    expect(rapport.ecrans).toHaveLength(4);
    expect(rapport.ecrans.every((e) => !e.erreurChargement)).toBe(true);
    expect(rapport.resultats.length).toBeGreaterThan(0);
    for (const resultat of rapport.resultats) {
      expect(resultat.exclusion !== null || CLASSES.includes(resultat.classe!)).toBe(true);
      expect(resultat.observation.requetes.every((r) => Object.keys(r).join() === 'chemin')).toBe(
        true,
      );
      expect(
        resultat.observation.reponses.every(
          (r) => Object.keys(r).sort().join() === 'chemin,statut',
        ),
      ).toBe(true);
    }
    expect(JSON.parse(await readFile(join(dossier, 'rapport.json'), 'utf8'))).toEqual(rapport);
    expect(await readFile(join(dossier, 'rapport.md'), 'utf8')).toContain('| Classe | Écran |');
    for (const ecran of rapport.ecrans) {
      const capture = await readFile(join(dossier, ecran.capture));
      expect(capture.subarray(1, 4).toString()).toBe('PNG');
    }
  } finally {
    await environnement.fermer();
  }
});

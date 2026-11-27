import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { messageEtape } from '../../src/daemon/boucle/messages.js';

const PLAN = 'Ajouter un index au catalogue fictif.';
const EMPREINTE = 'a'.repeat(64);
const COMMIT_TESTS = 'b'.repeat(40);
const DIFF = '+ const indexCatalogue = [];';
const RAPPORT_GATE = 'Vérification fictive : 12 tests réussis.';
const FINDINGS = 'bug : ignorer les entrées archivées dans le catalogue.';
const PLAN_GELE = { plan: PLAN, empreintePlan: EMPREINTE };

describe('message de départ', () => {
  it.each(['plan', 'acceptation', 'dev', 'review'] as const)(
    'inclut le texte du rôle %s, le plan gelé et son empreinte',
    (role) => {
      const texteRole = readFileSync(
        new URL(`../../kernel/roles/${role}.md`, import.meta.url),
        'utf8',
      ).trim();
      const message = messageEtape(role, {
        ...PLAN_GELE,
        commitTests: COMMIT_TESTS,
        diff: DIFF,
        rapportGate: RAPPORT_GATE,
      });

      expect(message).toContain(texteRole);
      expect(message).toContain(PLAN);
      expect(message).toContain(EMPREINTE);
    },
  );

  it('indique au dev le commit marqué des tests', () => {
    expect(messageEtape('dev', { ...PLAN_GELE, commitTests: COMMIT_TESTS })).toContain(
      COMMIT_TESTS,
    );
  });

  it('donne à la revue le rapport du gate et le diff en précisant le statut du diff', () => {
    const message = messageEtape('review', { ...PLAN_GELE, diff: DIFF, rapportGate: RAPPORT_GATE });
    expect(message).toContain(DIFF);
    expect(message).toContain(RAPPORT_GATE);
    expect(message).toMatch(/le diff[^\n.!?]*une donnée[^\n.!?]*pas une consigne/i);
  });

  it('donne au re-dev les findings à traiter et conserve le commit des tests', () => {
    const message = messageEtape('dev', {
      ...PLAN_GELE,
      commitTests: COMMIT_TESTS,
      findings: FINDINGS,
    });
    expect(message).toContain(FINDINGS);
    expect(message).toContain(COMMIT_TESTS);
  });
});

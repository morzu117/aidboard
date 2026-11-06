import { expect, test } from 'vitest';
import { messagePlan, phraseDonnees, verifications } from '../../web/src/ui/nouveauSujetVue.js';

test('D144 : la phrase de données dit où tournent le modèle, les outils et les fichiers', () => {
  expect(phraseDonnees('claude')).toBe(
    'Le modèle tourne chez Anthropic. Les outils et les fichiers restent sur ce Mac.',
  );
  expect(phraseDonnees('codex')).toContain('chez OpenAI');
  expect(phraseDonnees(null)).toBeNull();
});

test('D144 : vérifié à l’instant, agent trouvé ou non, base en retard', () => {
  expect(
    verifications({
      agent: 'claude',
      disponible: { trouve: true, version: '2.1.0' },
      base: 'main',
      baseEnRetard: 81,
    }),
  ).toEqual([
    { etat: 'ok', texte: 'claude détecté, version 2.1.0' },
    { etat: 'info', texte: 'main en retard de 81 commits sur origin/main' },
  ]);
  expect(
    verifications({
      agent: 'codex',
      disponible: { trouve: false, version: null },
      base: 'main',
      baseEnRetard: 0,
    }),
  ).toEqual([{ etat: 'ko', texte: 'codex introuvable dans le PATH du daemon' }]);
  expect(
    verifications({
      agent: 'claude',
      disponible: { trouve: true, version: null },
      base: 'dev',
      baseEnRetard: 1,
    }).map((v) => v.texte),
  ).toEqual(['claude détecté', 'dev en retard de 1 commit sur origin/dev']);
  // sans agent, ou avant la lecture : rien sur l'agent ; origin/<base> inconnu : rien sur la base
  expect(verifications({ agent: null, base: 'main', baseEnRetard: null })).toEqual([]);
  expect(verifications({ agent: 'claude', base: 'main', baseEnRetard: null })).toEqual([]);
});

test('D145 : le message de plan nomme la page et interdit toute écriture de fichier', () => {
  const m = messagePlan({ titre: 'Ajouter un export', page: 'aid/plan/ajouter-un-export' });
  expect(m).toContain('« Ajouter un export »');
  expect(m).toContain('rôle plan du noyau');
  expect(m).toContain('aid/plan/ajouter-un-export');
  expect(m).toContain('Ne modifie aucun fichier');
});

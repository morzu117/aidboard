import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { artefactPresent, executer } from '../../src/daemon/boucle/conducteur.js';

const TETE_DEPART = 'a'.repeat(40);
const SLUG = 'catalogue-fictif';
const PLAN = 'Indexer le catalogue fictif.';
const COMMIT_TESTS = 'c'.repeat(40);
const CONDUITE = {
  depot: join(tmpdir(), 'aid-worktree-fictif'),
  slug: SLUG,
  teteDepart: TETE_DEPART,
  reglages: {
    phases: ['plan', 'acceptation', 'dev', 'review'],
    gate: 'npm run gate',
    redevCap: 2,
    genres: { plan: 'claude', acceptation: 'claude', dev: 'claude', review: 'codex' } as const,
    delais: { plan: 30, acceptation: 60, dev: 90, gate: 30, revue: 30 },
  },
  message: { plan: PLAN, empreintePlan: 'b'.repeat(64), commitTests: COMMIT_TESTS },
};

type Genre = 'claude' | 'codex';
type Role = keyof typeof CONDUITE.reglages.genres;
type Acteur = { genre: Genre; modele: string; sessionId: string };

function fauxPilote() {
  let prochainId = 0;

  return {
    lancer: vi.fn(
      async ({ genre }: { depot: string; role: Role; genre: Genre }): Promise<Acteur> => ({
        genre,
        modele: 'modele-fictif',
        sessionId: `session-fictive-${++prochainId}`,
      }),
    ),
    ecrire: vi
      .fn<(sessionId: string, texte: string) => Promise<void>>()
      .mockResolvedValue(undefined),
    arreter: vi.fn<(sessionId: string) => Promise<void>>().mockResolvedValue(undefined),
    consignerActeur: vi
      .fn<(acteur: Acteur & { role: Role }) => Promise<void>>()
      .mockResolvedValue(undefined),
    escalader: vi.fn<(raison: string) => Promise<void>>().mockResolvedValue(undefined),
    lirePage: vi.fn<(slug: string) => Promise<string | undefined>>().mockResolvedValue(undefined),
    lireMessagesCommits: vi
      .fn<(depot: string, teteDepart: string) => Promise<string[]>>()
      .mockResolvedValue([]),
  };
}

describe('exécution des actions de la boucle', () => {
  it.each([
    ['plan', 'plan', 'claude'],
    ['acceptation', 'acceptation', 'claude'],
    ['dev', 'dev', 'claude'],
    ['revue', 'review', 'codex'],
  ] as const)(
    'lance %s avec le rôle %s et le genre %s, puis envoie le message',
    async (etape, role, genre) => {
      const deps = fauxPilote();
      const acteurReel: Acteur = {
        genre: 'claude',
        modele: 'modele-effectif-fictif',
        sessionId: 'session-effective-fictive',
      };
      deps.lancer.mockResolvedValueOnce(acteurReel);

      await executer({ type: 'lancer_etape', etape }, CONDUITE, deps);

      expect(deps.lancer).toHaveBeenCalledExactlyOnceWith({ depot: CONDUITE.depot, role, genre });
      expect(deps.ecrire).toHaveBeenCalledExactlyOnceWith(
        acteurReel.sessionId,
        expect.stringContaining(PLAN),
      );
      expect(deps.ecrire.mock.lastCall?.[1]).toContain(CONDUITE.message.empreintePlan);
      expect(deps.consignerActeur).toHaveBeenCalledExactlyOnceWith({ ...acteurReel, role });
    },
  );

  it('crée deux sessions distinctes pour deux lancements successifs du même rôle', async () => {
    const deps = fauxPilote();

    await executer({ type: 'lancer_etape', etape: 'dev' }, CONDUITE, deps);
    await executer(
      { type: 'lancer_etape', etape: 'dev' },
      { ...CONDUITE, sessionId: 'session-fictive-1' },
      deps,
    );

    expect(deps.lancer).toHaveBeenCalledTimes(2);
    expect(deps.consignerActeur).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionId: 'session-fictive-1', role: 'dev' }),
    );
    expect(deps.consignerActeur).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionId: 'session-fictive-2', role: 'dev' }),
    );
    expect(deps.ecrire).toHaveBeenNthCalledWith(2, 'session-fictive-2', expect.any(String));
  });

  it('démarre le dev dans une autre session que le testeur', async () => {
    const deps = fauxPilote();

    await executer({ type: 'lancer_etape', etape: 'acceptation' }, CONDUITE, deps);
    await executer(
      { type: 'lancer_etape', etape: 'dev' },
      { ...CONDUITE, sessionId: 'session-fictive-1' },
      deps,
    );

    expect(deps.lancer).toHaveBeenCalledTimes(2);
    expect(deps.consignerActeur).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionId: 'session-fictive-1', role: 'acceptation' }),
    );
    expect(deps.consignerActeur).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionId: 'session-fictive-2', role: 'dev' }),
    );
    expect(deps.ecrire).toHaveBeenNthCalledWith(
      2,
      'session-fictive-2',
      expect.stringContaining(COMMIT_TESTS),
    );
  });

  it('relance par écrit dans la session de la tentative puis arrête cette session', async () => {
    const deps = fauxPilote();
    const contexte = { ...CONDUITE, sessionId: 'session-deja-ouverte' };

    await executer({ type: 'relancer_etape', etape: 'plan' }, contexte, deps);

    expect(deps.ecrire).toHaveBeenCalledExactlyOnceWith(
      contexte.sessionId,
      expect.stringMatching(/\S/),
    );
    expect(deps.arreter).not.toHaveBeenCalled();

    await executer({ type: 'arreter_etape', etape: 'plan' }, contexte, deps);

    expect(deps.arreter).toHaveBeenCalledExactlyOnceWith(contexte.sessionId);
    expect(deps.ecrire).toHaveBeenCalledTimes(1);
    expect(deps.lancer).not.toHaveBeenCalled();
    expect(deps.consignerActeur).not.toHaveBeenCalled();
  });

  it.each(['ambiguity', 'needs_input'])(
    'pose une escalade et transmet la raison %s',
    async (raison) => {
      const deps = fauxPilote();

      await executer({ type: 'escalader', raison }, CONDUITE, deps);

      expect(deps.escalader).toHaveBeenCalledExactlyOnceWith(raison);
      expect(deps.lancer).not.toHaveBeenCalled();
    },
  );
});

describe('artefact de fin d’étape', () => {
  it.each([
    [undefined, false],
    [PLAN, true],
  ])('vérifie la page de plan (%s → %s)', async (page, attendu) => {
    const deps = fauxPilote();
    deps.lirePage.mockResolvedValue(page);

    expect(await artefactPresent('plan', CONDUITE, deps)).toBe(attendu);
    expect(deps.lirePage).toHaveBeenCalledWith(`aid/plan/${SLUG}`);
  });

  it.each([
    [
      'un commit avec le trailer du point',
      ['Retouche fictive', 'Tests fictifs\n\nDétails.\n\nAcceptation: point-fictif'],
      true,
    ],
    ['un commit ordinaire', ['Retouche fictive'], false],
    ['une mention dans le titre', ['Acceptation: point-fictif\n\nDétails.'], false],
    [
      'une mention dans le corps',
      ['Retouche fictive\n\nAcceptation: point-fictif\n\nDétails.'],
      false,
    ],
    ['un trailer sans point', ['Tests fictifs\n\nAcceptation: '], false],
    ['aucun commit', [], false],
  ] as const)(
    'vérifie les commits depuis la tête de départ avec %s',
    async (_cas, messages, attendu) => {
      const deps = fauxPilote();
      deps.lireMessagesCommits.mockResolvedValue([...messages]);

      expect(await artefactPresent('acceptation', CONDUITE, deps)).toBe(attendu);
      expect(deps.lireMessagesCommits).toHaveBeenCalledWith(CONDUITE.depot, TETE_DEPART);
    },
  );

  it.each([
    ['commit et handoff', ['Implémentation fictive'], 'Handoff fictif.', true],
    ['commit seul', ['Implémentation fictive'], undefined, false],
    ['handoff seul', [], 'Handoff fictif.', false],
  ] as const)('vérifie la fin du dev avec %s', async (_cas, messages, page, attendu) => {
    const deps = fauxPilote();
    deps.lireMessagesCommits.mockResolvedValue([...messages]);
    deps.lirePage.mockResolvedValue(page);

    expect(await artefactPresent('dev', CONDUITE, deps)).toBe(attendu);
    if (attendu) {
      expect(deps.lireMessagesCommits).toHaveBeenCalledWith(CONDUITE.depot, TETE_DEPART);
      expect(deps.lirePage).toHaveBeenCalledWith(`aid/dev-handoff/${SLUG}`);
    }
  });

  it.each(['plan', 'acceptation', 'dev'] as const)(
    'refuse le simple turn_end de %s en l’absence de commit et de page',
    async (etape) => {
      const deps = fauxPilote();
      const finDeTour = { type: 'turn_end', sessionId: 'session-fictive-terminee' } as const;

      expect(
        await artefactPresent(etape, { ...CONDUITE, sessionId: finDeTour.sessionId }, deps),
      ).toBe(false);
    },
  );
});

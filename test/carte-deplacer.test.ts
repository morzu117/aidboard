import { expect, test } from 'vitest';
import { argsEtat, lireParamsEtat, resumeEtat } from '../src/shared/etats.js';
import { ACTIONS_MESH, CLASSE_ACTION, validerParamsAction } from '../src/shared/confirmations.js';
import { parseCard } from '../src/shared/board.js';
const params = {
  carte: 42,
  etape: 'review' as const,
  attendu: { stage: 'build' as const, stageVersion: 0 },
};

test('D293 : contrat exact, résumé et classe toujours non désactivable via mesh.etat', () => {
  expect(lireParamsEtat('carte.deplacer', params)).toEqual({ ok: true, params });
  expect(argsEtat('carte.deplacer', params)).toEqual({
    verb: 'board.cards.move',
    args: { id: 42, stage: 'review', expect_stage: 'build', expect_stage_version: 0 },
  });
  expect(resumeEtat('carte.deplacer', params)).toBe(
    'Déplace la carte #42 de build vers review. Aucune obligation ni message.',
  );
  expect(ACTIONS_MESH.has('mesh.etat')).toBe(true);
  expect(CLASSE_ACTION['mesh.etat']).toBe('toujours');
  expect(validerParamsAction('mesh.etat', { action: 'carte.deplacer', params })).toBe(true);
});

test.each([
  null,
  [],
  {},
  { ...params, inconnu: true },
  { ...params, [Symbol('inconnu')]: true },
  ...[undefined, null, 0, -1, 1.5, '42', true, Infinity, Number.MAX_SAFE_INTEGER + 1].map(
    (carte) => ({ ...params, carte }),
  ),
  ...[undefined, null, 'build', 'done', 'parked', 'spec', 'REVIEW'].map((etape) => ({
    ...params,
    etape,
  })),
  ...[
    undefined,
    null,
    [],
    {},
    { stage: 'build' },
    { stageVersion: 0 },
    { stage: 'build', stageVersion: 0, inconnu: true },
    { stage: 'done', stageVersion: 0 },
    { stage: 'spec', stageVersion: 0 },
    { stage: 'ready', stageVersion: 0 },
    { stage: 'review', stageVersion: 0 },
    ...[-1, 0.5, '0', true, Infinity, Number.MAX_SAFE_INTEGER + 1].map((stageVersion) => ({
      stage: 'build',
      stageVersion,
    })),
  ].map((attendu) => ({ ...params, attendu })),
])('parseur fermé : refus %#', (brut) => {
  expect(lireParamsEtat('carte.deplacer', brut).ok).toBe(false);
});

test.each(['build', 'review'] as const)('ready depuis %s accepté', (stage) => {
  expect(
    lireParamsEtat('carte.deplacer', {
      ...params,
      etape: 'ready',
      attendu: { stage, stageVersion: 2 },
    }).ok,
  ).toBe(true);
});
test.each([undefined, null, '1', true, -1, 0.5])(
  'version de carte illisible %s',
  (stage_version) => {
    expect(parseCard({ id: 42, stage_version })!.value.stageVersion).toBeNull();
  },
);

test('409 générique du gateway sans diagnostic de porte inventé', async () => {
  const { libelleDeplacement } = await import('../src/shared/deplacements.js');
  expect(libelleDeplacement({ code: 'upstream_error', status: 409 })).toBe(
    'La carte a changé ou une porte a refusé le déplacement. Relis la carte.',
  );
});

test('frontière proxy : seules les valeurs structurées connues survivent en mémoire', async () => {
  const { lireReponseProxy, VERBES_PROXY } = await import('../src/daemon/mesh/proxy.js');
  const { ETAPES_PROXY, REFUS_DEPLACEMENT } = await import('../src/shared/deplacements.js');
  const lire = (champs: Record<string, unknown>) =>
    lireReponseProxy(JSON.stringify({ request_id: 'test', ...champs }), 'test', VERBES_PROXY, true);
  for (const current_stage of ETAPES_PROXY) {
    for (const refusal of REFUS_DEPLACEMENT) {
      expect(
        lire({
          ok: false,
          error: 'upstream_error',
          current_stage,
          refusal,
          detail: 'secret-amont',
        }),
      ).toEqual({
        ok: false,
        code: 'upstream_error',
        current_stage,
        refusal,
      });
    }
  }
  for (const inconnu of ['secret-amont', null, 42, {}, ['build']]) {
    expect(
      lire({
        ok: false,
        error: 'upstream_error',
        current_stage: inconnu,
        refusal: inconnu,
        detail: 'secret-amont',
      }),
    ).toEqual({ ok: false, code: 'upstream_error' });
  }
  expect(
    lire({
      ok: true,
      status: 200,
      body: { detail: 'secret-amont', warn: 'secret-amont', autre: 'secret-amont' },
    }),
  ).toEqual({ ok: true, status: 200, body: { avertissement: true } });
  expect(lire({ ok: true, status: 200, body: { detail: 'secret-amont' } })).toEqual({
    ok: true,
    status: 200,
    body: {},
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { runEnv } from '../../src/cli/commands/env.js';

let dossier: string;

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), 'aid-boucle-env-'));
  vi.stubEnv('PATH', dossier);
  vi.stubEnv('AID_HOME', join(dossier, 'aid-home'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  installer('git');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (dossier) rmSync(dossier, { recursive: true, force: true });
});

function installer(binaire: string) {
  writeFileSync(join(dossier, binaire), '#!/bin/sh\necho 2.1.0\n', { mode: 0o700 });
}

async function verifier(dev: string, revue: string, code: number): Promise<unknown> {
  writeFileSync(
    join(dossier, 'agent.yml'),
    `outils: { boucle: {} }
capabilities: { dev_agent: ${dev}, review_agent: ${revue} }
`,
  );
  expect(await runEnv(['check', '--root', dossier, '--json'])).toBe(code);
  return JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]));
}

test.each([
  ['claude', 'codex'],
  ['codex', 'claude'],
])('env check signale %s absent avec %s présent dans le PATH', async (absent, present) => {
  installer(present);
  const profil = await verifier('claude', 'codex', 7);
  expect(profil).toMatchObject({
    ok: false,
    outils: expect.arrayContaining([
      expect.objectContaining({
        nom: 'boucle',
        etat: 'absent',
        detail: expect.stringContaining(absent),
      }),
    ]),
  });
});

test('env check accepte les rôles tous déclarés codex quand seul codex est installé', async () => {
  installer('codex');
  const profil = await verifier('codex', 'codex', 0);
  expect(profil).toMatchObject({
    ok: true,
    outils: expect.arrayContaining([expect.objectContaining({ nom: 'boucle', etat: 'ok' })]),
  });
});

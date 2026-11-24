import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runEnv } from '../src/cli/commands/env.js';

describe('aid env check', () => {
  let root: string;
  const manifeste = (texte: string) => writeFileSync(join(root, 'agent.yml'), texte);
  const executable = (nom: string, script: string) =>
    writeFileSync(join(root, nom), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const verifier = (...args: string[]) => runEnv(['check', '--root', root, ...args]);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aid-env-'));
    vi.stubEnv('PATH', root);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('rend les quatre états en JSON dans l’ordre du manifeste puis ajoute git', async () => {
    manifeste(`outils:
  "20": {}
  "10": { version: ">=22.12 <25", verifier: [sonde, "--version"] }
  manquant: {}
  ancien: { version: ">=3" }
  obscur: {}
`);
    executable('20', 'echo 20.1');
    executable('sonde', '[ "$1" = "--version" ] && echo v22.12.0 >&2; exit 4');
    executable('ancien', 'echo 2.9.0');
    executable('obscur', 'echo inconnue');
    executable('git', 'echo git version 2.43.0');
    expect(await verifier('--json')).toBe(7);
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]?.[0] ?? '')).toEqual({
      root,
      ok: false,
      outils: [
        { nom: '20', requis: true, trouve: '20.1', etat: 'ok' },
        { nom: '10', requis: true, attendu: '>=22.12 <25', trouve: '22.12.0', etat: 'ok' },
        { nom: 'manquant', requis: true, etat: 'absent' },
        { nom: 'ancien', requis: true, attendu: '>=3', trouve: '2.9.0', etat: 'hors-plage' },
        { nom: 'obscur', requis: true, etat: 'illisible' },
        { nom: 'git', requis: true, trouve: '2.43.0', etat: 'ok' },
      ],
    });
  });

  it('annonce les commandes personnalisées et avertit pour les outils facultatifs ou illisibles', async () => {
    manifeste(`outils:
  git: { requis: false }
  ancien: { requis: false, version: "3" }
  obscur: { verifier: [sonde] }
`);
    executable('ancien', 'echo 2.9.0');
    executable('git', 'echo lancé > trace');
    executable('sonde', 'echo inconnue');
    expect(await verifier()).toBe(0);
    expect(vi.mocked(console.log).mock.calls).toEqual([
      ['commandes du manifeste : obscur'],
      ['! ancien 2.9.0 (attendu 3) — hors-plage'],
      ['! obscur — illisible'],
    ]);
    expect(() => rmSync(join(root, 'trace'))).toThrow(/ENOENT/);
  });

  it('conseille mise seulement pour les outils absents déclarés dans [tools]', async () => {
    manifeste('outils: { alpha: {}, beta: {}, "gamma.delta": {} }');
    executable('git', 'echo git version 2.43.0');
    writeFileSync(
      join(root, 'mise.toml'),
      '[tools] # profil\nalpha = "1"\n"gamma.delta" = "2"\n[env]\nbeta = "3"\n',
    );
    expect(await verifier()).toBe(7);
    expect(vi.mocked(console.log).mock.calls).toEqual([
      ['✗ alpha — absent — lancer `mise install`'],
      ['✗ beta — absent'],
      ['✗ gamma.delta — absent — lancer `mise install`'],
      ['✓ git 2.43.0'],
    ]);
  });

  it('traite un vérificateur qui dépasse le délai comme absent', async () => {
    manifeste('outils: { lent: {} }');
    executable('lent', 'while :; do :; done');
    executable('git', 'echo git version 2.43.0');
    expect(await runEnv(['check', '--root', root], 100)).toBe(7);
    expect(console.log).toHaveBeenCalledWith('✗ lent — absent — délai dépassé');
  });

  it('vérifie seulement git sans manifeste ou sans section outils', async () => {
    executable('git', 'echo git version 2.43.0');
    expect(await verifier()).toBe(0);
    manifeste('project: { namespace: exemple }');
    expect(await verifier()).toBe(0);
    expect(vi.mocked(console.log).mock.calls).toEqual([['✓ git 2.43.0'], ['✓ git 2.43.0']]);
  });

  it.each([
    'outils: [',
    'outils: []',
    'outils: null',
    'outils: { "Nom!": {} }',
    'outils: { git: { verifier: [] } }',
    'outils: { git: { requis: oui } }',
    'outils: { git: { version: "22 || latest" } }',
  ])('refuse un manifeste invalide avant toute vérification (%s)', async (texte) => {
    manifeste(texte);
    executable('git', 'echo lancé > trace');
    expect(await verifier('--json')).toBe(2);
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledOnce();
    expect(() => rmSync(join(root, 'trace'))).toThrow(/ENOENT/);
  });
});

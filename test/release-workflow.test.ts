import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

test('Release contrôle main et pousse seulement le tag sans commit', () => {
  const workflow = parse(
    readFileSync(join(import.meta.dirname, '../.github/workflows/release.yml'), 'utf8'),
  );
  const etapes = workflow.jobs.version.steps as {
    uses?: string;
    with?: { ref?: string };
    run?: string;
  }[];
  expect(etapes.find((etape) => etape.uses?.startsWith('actions/checkout@'))?.with?.ref).toBe(
    'main',
  );
  const commandes = etapes.map((etape) => etape.run ?? '').join('\n');
  expect(commandes).not.toMatch(/git\s+commit\b/);
  expect(commandes.match(/git\s+push[^\n]*/g)).toEqual(['git push origin "v$VERSION"']);
  expect(commandes).not.toContain('npm ci');
  expect(commandes).toContain('git tag "v$VERSION"');
  expect(commandes).toContain('gh release create "v$VERSION" --draft');
  const controle = etapes.find((etape) => etape.run?.includes('npm run release:preparer'))?.run;
  expect(controle).toContain('::error::');
  expect(controle).toContain('package.json');
  expect(controle).toContain('app/src-tauri/tauri.conf.json');

  const dossier = mkdtempSync(join(tmpdir(), 'aid-controle-release-'));
  try {
    mkdirSync(join(dossier, 'app/src-tauri'), { recursive: true });
    const ecrire = (paquet: string, tauri: string) => {
      writeFileSync(join(dossier, 'package.json'), JSON.stringify({ version: paquet }));
      writeFileSync(
        join(dossier, 'app/src-tauri/tauri.conf.json'),
        JSON.stringify({ version: tauri }),
      );
    };
    const lancer = () =>
      execFileSync('bash', ['-e', '-c', controle!], {
        cwd: dossier,
        env: { ...process.env, VERSION: '1.2.3' },
        stdio: 'pipe',
      });
    ecrire('1.2.3', '1.2.3');
    expect(lancer).not.toThrow();
    for (const versions of [
      ['1.2.2', '1.2.3'],
      ['1.2.3', '1.2.2'],
    ] as const) {
      ecrire(versions[0], versions[1]);
      expect(lancer).toThrow(/::error::.*npm run release:preparer/);
    }
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
});

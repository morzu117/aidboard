import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';

const sh = promisify(execFile);
const root = join(import.meta.dirname, '..');

// Lent et réseau (npm install des dépendances) : lancé par gate:e2e, pas par gate.
describe.skipIf(process.env.AID_PACK_TEST !== '1')('paquet', () => {
  test('npm pack puis installation dans un dossier vierge : aid doctor passe et le contenu est le bon', async () => {
    const work = realpathSync(mkdtempSync(join(tmpdir(), 'aid-pack-')));
    const { stdout } = await sh(
      'npm',
      ['pack', '--ignore-scripts', '--pack-destination', work, '--json'],
      {
        cwd: root,
      },
    );
    const info = JSON.parse(stdout)[0] as { filename: string; files: Array<{ path: string }> };
    const paths = info.files.map((f) => f.path);

    expect(paths).toContain('dist/cli/aid.js');
    expect(paths).toContain('dist/web/index.html');
    expect(paths).toContain('migrations/001_init.sql');
    expect(paths).toContain('scripts/git/topic-create.sh');
    expect(paths).toContain('scripts/git/topic-cleanup.sh');
    expect(paths).toContain('scripts/hooks/aid-hook.sh');
    expect(paths).toContain('README.md');
    for (const p of paths) {
      expect(p, p).not.toMatch(/^(src|test|e2e|design|docs|\.codegraph|node_modules)\//);
      expect(p, p).not.toMatch(/\.(env|pem|key)$/);
    }

    const app = join(work, 'app');
    writeFileSync(join(work, 'package.json'), '{"name":"essai","private":true}');
    await sh('mkdir', ['-p', app]);
    writeFileSync(join(app, 'package.json'), '{"name":"essai","private":true}');
    await sh('npm', ['install', '--no-audit', '--no-fund', join(work, info.filename)], {
      cwd: app,
      timeout: 240_000,
    });

    const bin = join(app, 'node_modules', '.bin');
    expect(readdirSync(bin)).toEqual(expect.arrayContaining(['aid', 'aidboard']));
    const home = join(work, 'home');
    // un daemon déjà lancé sur 4870 (usage réel) ne doit pas faire échouer le test : port propre
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, 'config.yaml'), 'port: 4879\n');
    const env = { ...process.env, AID_HOME: home, AID_NO_BROWSER: '1' };
    const doctor = await sh(join(bin, 'aidboard'), ['doctor'], { env });
    expect(doctor.stdout).toContain('✓ node-pty : un terminal se lance');
    expect(doctor.stdout).toContain('✓ better-sqlite3');
    expect(existsSync(join(app, 'node_modules', 'aidboard', 'dist', 'cli', 'aid.js'))).toBe(true);
  }, 300_000);
});

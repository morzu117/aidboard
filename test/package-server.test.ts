import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';

const sh = promisify(execFile);
const root = join(import.meta.dirname, '..');

// Lent et réseau (npm ci des dépendances, téléchargement du Node officiel) : lancé par
// gate:e2e, pas par gate — comme pack.test.ts, dont l'archive serveur est le prolongement (13.3).
describe.skipIf(process.env.AID_PACK_TEST !== '1')('archive AID Server', () => {
  test('package-server.sh : une archive autonome qui passe aid doctor sans Node sur la machine', async () => {
    const work = realpathSync(mkdtempSync(join(tmpdir(), 'aid-srv-')));
    const out = join(work, 'release');
    const { stdout } = await sh(join(root, 'scripts', 'package-server.sh'), [], {
      cwd: root,
      env: { ...process.env, AID_RELEASE_DIR: out },
      timeout: 540_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const archive = stdout.trim();
    const version = (
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
    ).version;
    expect(archive).toBe(
      join(out, `aid-server-${version}-${process.platform}-${process.arch}.tar.gz`),
    );

    const list = (await sh('tar', ['tzf', archive], { maxBuffer: 16 * 1024 * 1024 })).stdout
      .split('\n')
      .map((p) => p.replace(/^\.\//, ''));
    for (const p of [
      'bin/aid',
      'node/bin/node',
      'dist/cli/aid.js',
      'dist/web/index.html',
      'node_modules/node-pty/package.json',
      'node_modules/better-sqlite3/package.json',
      'migrations/001_init.sql',
      'scripts/git/topic-create.sh',
      'scripts/hooks/aid-hook.sh',
      'package.json',
      'VERSION',
    ]) {
      expect(list, p).toContain(p);
    }
    // les natifs de cette plateforme (prebuilds N-API, livrés par les deux paquets)
    const cible = `${process.platform}-${process.arch}`;
    expect(list).toContain(`node_modules/better-sqlite3/prebuilds/${cible}.node`);
    expect(list).toContain(`node_modules/node-pty/prebuilds/${cible}/pty.node`);
    for (const p of list) {
      expect(p, p).not.toMatch(/^(src|test|e2e|design|docs|\.codegraph|release)\//);
      expect(p, p).not.toMatch(/^node_modules\/(\.bin\/tsup|typescript|vitest|tsup|vite)\//);
      expect(p, p).not.toMatch(/^node\/(include|lib|share)\//);
    }

    const sums = readFileSync(join(out, 'SHA256SUMS'), 'utf8');
    const { stdout: sum } = await sh('shasum', ['-a', '256', archive]);
    expect(sums).toContain(
      `${sum.split(' ')[0]}  aid-server-${version}-${process.platform}-${process.arch}.tar.gz`,
    );

    // extraite ailleurs, lancée sans aucun Node sur le PATH : seul celui de l'archive compte
    const install = join(work, 'x');
    mkdirSync(install);
    await sh('tar', ['xzf', archive, '-C', install]);
    const home = join(work, 'home');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, 'config.yaml'), 'port: 4878\n');
    const env = { HOME: home, PATH: '/usr/bin:/bin', AID_HOME: home, AID_NO_BROWSER: '1' };
    const v = await sh(join(install, 'bin', 'aid'), ['--version'], { env });
    expect(v.stdout.trim()).toBe(`aidboard ${version}`);
    const doctor = await sh(join(install, 'bin', 'aid'), ['doctor'], { env });
    expect(doctor.stdout).toContain('✓ node-pty : un terminal se lance');
    expect(doctor.stdout).toContain('✓ better-sqlite3');
    expect(doctor.stdout).toMatch(/✓ node v22\./);
  }, 600_000);
});

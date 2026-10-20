import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { assetName, currentServer, installMode, serverDir } from '../src/daemon/install.js';
import { makeOriginAndClone } from './helpers/git.js';

const home = () => mkdtempSync(join(tmpdir(), 'aid-inst-'));

function fakeRelease(h: string, version: string): string {
  const dir = join(serverDir(h), version);
  mkdirSync(join(dir, 'dist', 'cli'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'cli', 'aid.js'), '');
  return dir;
}

test('installMode : release sous ~/.aid/server/<version>, y compris à travers le lien current', () => {
  const h = home();
  const dir = fakeRelease(h, '1.2.3');
  symlinkSync('1.2.3', join(serverDir(h), 'current'));
  expect(installMode(join(dir, 'dist', 'cli', 'aid.js'), h)).toBe('release');
  expect(installMode(join(serverDir(h), 'current', 'dist', 'cli', 'aid.js'), h)).toBe('release');
  // un chunk plus profond aussi
  expect(installMode(join(dir, 'dist', 'chunk-abc.js'), h)).toBe('release');
});

test('installMode : repo quand un .git est au-dessus du build', () => {
  const h = home();
  const { clone } = makeOriginAndClone(h);
  expect(installMode(join(clone, 'dist', 'cli', 'aid.js'), h)).toBe('repo');
});

test('installMode : inconnu ailleurs (tarball npm installé à la main)', () => {
  const h = home();
  const ailleurs = join(h, 'node_modules', 'aidboard', 'dist', 'cli');
  mkdirSync(ailleurs, { recursive: true });
  expect(installMode(join(ailleurs, 'aid.js'), h)).toBe('inconnu');
});

test('currentServer : null sans installation, puis la version visée par current', () => {
  const h = home();
  expect(currentServer(h)).toBeNull();
  fakeRelease(h, '0.2.0');
  fakeRelease(h, '0.3.0');
  symlinkSync('0.3.0', join(serverDir(h), 'current'));
  expect(currentServer(h)).toEqual({ version: '0.3.0', dir: join(serverDir(h), '0.3.0') });
});

test('currentServer : null si current pointe vers une version supprimée', () => {
  const h = home();
  mkdirSync(serverDir(h), { recursive: true });
  symlinkSync('9.9.9', join(serverDir(h), 'current'));
  expect(currentServer(h)).toBeNull();
});

test('assetName : darwin et linux × arm64 et x64 ; refuse le reste', () => {
  expect(assetName('0.2.0', 'darwin', 'arm64')).toBe('aid-server-0.2.0-darwin-arm64.tar.gz');
  expect(assetName('0.2.0', 'darwin', 'x64')).toBe('aid-server-0.2.0-darwin-x64.tar.gz');
  expect(assetName('0.2.0', 'linux', 'x64')).toBe('aid-server-0.2.0-linux-x64.tar.gz');
  expect(assetName('0.2.0', 'linux', 'arm64')).toBe('aid-server-0.2.0-linux-arm64.tar.gz');
  expect(() => assetName('0.2.0', 'win32', 'x64')).toThrow(/WSL2/);
  expect(() => assetName('0.2.0', 'linux', 'ia32')).toThrow(/linux-ia32/);
});

import { expect, test } from 'vitest';
import { browserCommand, isWsl } from '../src/cli/browser.js';

const url = 'http://127.0.0.1:4870/?token=abc';
const wsl = 'Linux version 5.15.0-microsoft-standard-WSL2';
const base = { url, procVersion: null, platform: 'linux' as NodeJS.Platform };

test('macOS : open', () => {
  expect(browserCommand({ ...base, platform: 'darwin', has: () => false })).toEqual(['open', url]);
});

test('WSL2 : wslview si présent, sinon cmd.exe /c start', () => {
  expect(browserCommand({ ...base, procVersion: wsl, has: (b) => b === 'wslview' })).toEqual([
    'wslview',
    url,
  ]);
  expect(browserCommand({ ...base, procVersion: wsl, has: (b) => b === 'cmd.exe' })).toEqual([
    'cmd.exe',
    '/c',
    'start',
    '""',
    url,
  ]);
  expect(browserCommand({ ...base, procVersion: wsl, has: () => false })).toBeNull();
});

test('Linux : xdg-open, sinon rien', () => {
  expect(
    browserCommand({
      ...base,
      procVersion: 'Linux version 6.1.0-debian',
      has: (b) => b === 'xdg-open',
    }),
  ).toEqual(['xdg-open', url]);
  expect(browserCommand({ ...base, has: () => false })).toBeNull();
});

test('l’URL ouverte est toujours en 127.0.0.1, jamais localhost', () => {
  expect(url).not.toContain('localhost');
  expect(isWsl(wsl)).toBe(true);
  expect(isWsl('Linux version 6.1.0')).toBe(false);
  expect(isWsl(null)).toBe(false);
});

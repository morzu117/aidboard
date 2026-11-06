import { expect, test } from 'vitest';
import {
  memoireLocale,
  parseMeminfo,
  parseMemoire,
  parseVmStat,
} from '../src/daemon/machines/memoire.js';

// Chantier 29 (D156) : la mémoire disponible, sur des sorties synthétiques de vm_stat et /proc/meminfo.

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   100000.
Pages active:                                 675126.
Pages inactive:                               200000.
Pages speculative:                              4000.
Pages throttled:                                   0.
Pages wired down:                             280840.
Pages purgeable:                                2128.
`;

const MEMINFO = `MemTotal:        8000000 kB
MemFree:          500000 kB
MemAvailable:    3000000 kB
`;

test('vm_stat : libres, inactives et spéculatives, à la taille de page de l’en-tête', () => {
  expect(parseVmStat(VM_STAT)).toBe((100000 + 200000 + 4000) * 16384);
  expect(parseVmStat(VM_STAT.replace('16384', '4096'))).toBe((100000 + 200000 + 4000) * 4096);
});

test('vm_stat illisible : null', () => {
  expect(parseVmStat('')).toBeNull();
  expect(parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\n')).toBeNull();
});

test('/proc/meminfo : MemAvailable, pas MemFree', () => {
  expect(parseMeminfo(MEMINFO)).toBe(3000000 * 1024);
  expect(parseMeminfo('MemFree: 500000 kB\n')).toBeNull();
});

test('la sortie de la commande distante, quelle que soit la branche', () => {
  expect(parseMemoire('MemAvailable:    3000000 kB\n')).toBe(3000000 * 1024);
  expect(parseMemoire(VM_STAT)).toBe((100000 + 200000 + 4000) * 16384);
  expect(parseMemoire('bash: vm_stat: command not found')).toBeNull();
});

test('sur une plateforme inconnue : null, sans exception', async () => {
  expect(await memoireLocale('win32')).toBeNull();
});

test.runIf(process.platform === 'darwin' || process.platform === 'linux')(
  'sur cette machine : une mesure positive',
  async () => {
    expect(await memoireLocale()).toBeGreaterThan(0);
  },
);

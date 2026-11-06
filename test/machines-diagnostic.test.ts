import { expect, test } from 'vitest';
import { commandeDiagnostic, lireDiagnostic } from '../src/daemon/machines/diagnostic.js';

// Chantier 29 (D155) : la commande distante du diagnostic et la lecture de sa sortie.

test('la commande ne vise que les agents trouvés, par leur binaire connu', () => {
  const c = commandeDiagnostic(['claude', 'cursor']);
  expect(c).toContain('$(claude --version');
  expect(c).toContain('$(cursor-agent --version');
  expect(c).not.toContain('codex');
  expect(c).toContain('echo aid-memoire; if [ -r /proc/meminfo ]');
  // un nom inconnu n'entre jamais dans la commande
  expect(commandeDiagnostic(['rm -rf ~'])).not.toContain('rm');
});

test('versions, numéro seul ou ligne courte, et la mémoire après la marque', () => {
  const out = [
    'aid-version:claude 2.1.0 (Claude Code)',
    'aid-version:codex ',
    'aid-version:cursor nightly',
    'aid-memoire',
    'MemAvailable:    3000000 kB',
  ].join('\n');
  expect(lireDiagnostic(out)).toEqual({
    versions: { claude: '2.1.0', codex: null, cursor: 'nightly' },
    octets: 3000000 * 1024,
  });
  expect(lireDiagnostic('aid-version:claude 2.1.0\n').octets).toBeNull();
});

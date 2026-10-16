import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test('maquette.css est identique au bloc <style> des maquettes (aucune retouche à la main)', () => {
  for (const f of ['aid-1-1-accueil', 'aid-1-2-boite-de-reception', 'aid-1-3-sujet']) {
    const html = readFileSync(new URL(`../../design/maquettes/${f}.html`, import.meta.url), 'utf8');
    const css = /<style[^>]*>([\s\S]*?)<\/style>/.exec(html)![1]!;
    const ours = readFileSync(
      new URL('../../web/src/styles/maquette.css', import.meta.url),
      'utf8',
    );
    expect(sha(ours), f).toBe(sha(css));
  }
});

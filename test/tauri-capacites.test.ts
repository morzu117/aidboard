import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// Chantier 30 (D170) : aucune capacité Tauri ne donne l'IPC à une origine chargée par URL. Le cockpit
// est une URL (WebviewUrl::External) ; un artefact, a fortiori, ne doit jamais atteindre les commandes.
const DOSSIER = join(import.meta.dirname, '../app/src-tauri/capabilities');

interface Capacite {
  identifier?: string;
  remote?: unknown;
  windows?: string[];
  webviews?: string[];
}

const capacites = readdirSync(DOSSIER)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ fichier: f, c: JSON.parse(readFileSync(join(DOSSIER, f), 'utf8')) as Capacite }));

test('D170 : les capacités sont lues (le dossier n’est pas vide)', () => {
  expect(capacites.map((x) => x.fichier)).toContain('default.json');
});

test.each(capacites.map((x) => [x.fichier, x.c] as const))(
  'D170 : %s ne porte aucune entrée remote',
  (_fichier, c) => {
    expect(c).not.toHaveProperty('remote');
  },
);

test.each(capacites.map((x) => [x.fichier, x.c] as const))(
  'D170 : %s ne vise que la fenêtre main, jamais une webview ajoutée',
  (_fichier, c) => {
    expect(c.windows ?? []).toEqual(['main']);
    expect(c.webviews ?? []).toEqual([]);
  },
);

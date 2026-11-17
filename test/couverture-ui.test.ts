import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from 'vitest';
import { controlerCouverture } from '../e2e/couverture-ui.js';
import { normaliserNode } from '../e2e/normaliser-node.js';

test('D345 : fichiers synthétiques, manque, cliquet, justification et inventaire', () => {
  const dossier = mkdtempSync(join(tmpdir(), 'aid-couverture-test-'));
  const inventaire = join(dossier, 'inventaire.json');
  const exceptions = join(dossier, 'exceptions.json');
  const releve = join(dossier, 'clics.jsonl');
  try {
    writeFileSync(inventaire, JSON.stringify(['action.a', 'action.b']));
    writeFileSync(exceptions, JSON.stringify([{ node: 'action.b', raison: 'Action externe.' }]));
    writeFileSync(releve, JSON.stringify({ node: 'action.libelle', action: 'action.a' }) + '\n');
    expect(controlerCouverture(inventaire, exceptions, releve)).toEqual([]);
    writeFileSync(releve, JSON.stringify({ node: null, element: 'button' }) + '\n');
    expect(controlerCouverture(inventaire, exceptions, releve)).toEqual([
      'Jamais cliqué : action.a',
    ]);
    writeFileSync(releve, JSON.stringify({ node: 'action.b' }) + '\n');
    expect(controlerCouverture(inventaire, exceptions, releve)).toContain(
      'Cliquet : retirer action.b des non-couverts',
    );
    writeFileSync(exceptions, JSON.stringify([{ node: 'inconnu', raison: ' ' }]));
    expect(controlerCouverture(inventaire, exceptions, releve)).toEqual(
      expect.arrayContaining([
        'Raison absente : inconnu',
        "Absent de l'inventaire : inconnu",
        'Jamais cliqué : action.a',
      ]),
    );
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
});

test('D345 : normalisation partagée, ids stables et segments variables', () => {
  expect(normaliserNode('1-1.table.ligne-01ABC.ouvrir')).toBe('1-1.table.ligne-*.ouvrir');
  expect(normaliserNode('pda.demande.01ABC.confirmer')).toBe('pda.demande.*.confirmer');
  expect(normaliserNode('1-2.filtres.workspace-tous')).toBe('1-2.filtres.workspace-tous');
  expect(normaliserNode('nouveau.bouton')).toBe('nouveau.bouton');
});

import { expect, test } from 'vitest';
import { INLINE_IMAGE_TYPES } from '../src/daemon/conversation/driver.js';
import { agentOptions, CLAUDE_MODELS, REMOTE_CONTROL } from '../src/shared/agentSettings.js';
import { CAPACITES, capacitesDe, type Lieu } from '../src/shared/capacites.js';

// Chantier 29 (D153) : la table des capacités, confrontée à ce que les pilotes et le composer savent faire.

const MAC: Lieu = { machine: 'mac', transport: 'stream' };
const PTY: Lieu = { machine: 'mac', transport: 'pty' };
const SERVEUR: Lieu = { machine: 'serveur', transport: 'stream' };

test('huit capacités, chacune avec son libellé', () => {
  expect(CAPACITES.map((c) => c.id)).toEqual([
    'outils',
    'images',
    'approbations',
    'interruption',
    'reprise',
    'effort',
    'distant',
    'conso',
  ]);
  expect(Object.keys(capacitesDe('claude', MAC)).sort()).toEqual(CAPACITES.map((c) => c.id).sort());
});

test('claude en stream sur le Mac : tout sauf la consommation', () => {
  const c = capacitesDe('claude', MAC);
  expect(
    Object.entries(c)
      .filter(([, v]) => !v)
      .map(([k]) => k),
  ).toEqual(['conso']);
});

test('sur un serveur : pas d’images, le reste comme sur le Mac', () => {
  expect(capacitesDe('claude', SERVEUR).images).toBe(false);
  expect(capacitesDe('claude', SERVEUR).reprise).toBe(true);
  expect(capacitesDe('codex', SERVEUR).interruption).toBe(true);
});

test('en PTY : outils, approbations et interruption dans le terminal, rien d’autre', () => {
  const c = capacitesDe('claude', PTY);
  expect(
    Object.entries(c)
      .filter(([, v]) => v)
      .map(([k]) => k),
  ).toEqual(['outils', 'approbations', 'interruption']);
});

test('le contrôle distant suit REMOTE_CONTROL des pilotes', () => {
  for (const kind of ['claude', 'codex'] as const) {
    expect(capacitesDe(kind, MAC).distant).toBe(REMOTE_CONTROL[kind]);
    expect(capacitesDe(kind, SERVEUR).distant).toBe(REMOTE_CONTROL[kind]);
  }
});

test('les images du Mac : le pilote passe des images en ligne', () => {
  expect(INLINE_IMAGE_TYPES.has('image/png')).toBe(true);
  expect(capacitesDe('codex', MAC).images).toBe(true);
});

test('l’effort suit les options annoncées par l’agent', () => {
  expect(agentOptions('claude', []).efforts.length).toBeGreaterThan(0);
  expect(capacitesDe('claude', MAC).effort).toBe(true);
  // codex sans modèle annoncé : aucun effort
  expect(agentOptions('codex', []).efforts).toEqual([]);
  expect(capacitesDe('codex', MAC, false).effort).toBe(false);
  const avec = agentOptions('codex', [
    { id: 'gpt', label: 'GPT', efforts: CLAUDE_MODELS[0]!.efforts },
  ]);
  expect(capacitesDe('codex', MAC, avec.efforts.length > 0).effort).toBe(true);
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { codexHome, fournisseurs } from '../src/daemon/machines/fournisseurs.js';

// Chantier 29 (D159) : fournisseurs et alertes, par présence seulement. Les valeurs sont synthétiques et ne doivent
// apparaître nulle part dans le résultat.

const VALEUR = 'sk-ant-synthetique-0000-ne-doit-pas-sortir';
const STRIP = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const base = { strip: STRIP, ollama: true, codexHome: '/home/u/.codex', existe: () => false };

test('sans clé : abonnements, identifiants gérés par les CLI, Ollama pour la mémoire', () => {
  const r = fournisseurs({ ...base, env: { HOME: '/home/u' } });
  expect(r.alertes).toEqual([]);
  expect(r.fournisseurs.map((f) => [f.id, f.acces, f.usage, f.secret])).toEqual([
    [
      'anthropic',
      'Abonnement · claude CLI · repli payant désactivé',
      false,
      'Identifiants gérés par le CLI',
    ],
    ['openai', 'codex CLI · identifiants gérés par le CLI', false, 'Identifiants gérés par le CLI'],
    ['ollama', 'Endpoint local · sans clé · recherche de la mémoire', false, 'Aucun secret'],
  ]);
});

test('clé Anthropic retirée par env.strip : pas de repli payant, mais l’alerte', () => {
  const r = fournisseurs({ ...base, env: { HOME: '/home/u', ANTHROPIC_API_KEY: VALEUR } });
  const a = r.fournisseurs[0]!;
  expect(a.usage).toBe(false);
  expect(a.acces).toBe('Abonnement · claude CLI · repli payant désactivé');
  expect(a.alerte).toBe('env:ANTHROPIC_API_KEY');
  expect(r.alertes.map((x) => x.titre)).toEqual([
    "ANTHROPIC_API_KEY dans l'environnement du daemon",
  ]);
  expect(JSON.stringify(r)).not.toContain(VALEUR);
});

test('clé Anthropic transmise (strip vidé) : facturation à l’usage, en ambre', () => {
  const r = fournisseurs({ ...base, strip: [], env: { ANTHROPIC_API_KEY: VALEUR } });
  expect(r.fournisseurs[0]!.usage).toBe(true);
  expect(r.fournisseurs[0]!.acces).toBe("Clé API · facturation à l'usage");
  expect(JSON.stringify(r)).not.toContain(VALEUR);
});

test('OPENAI_API_KEY : facturation à l’usage possible pour codex ; les autres clés connues ont leur alerte', () => {
  const r = fournisseurs({
    ...base,
    env: { OPENAI_API_KEY: VALEUR, OPENROUTER_API_KEY: VALEUR, AUTRE_TOKEN: VALEUR },
  });
  expect(r.fournisseurs[1]!.usage).toBe(true);
  expect(r.fournisseurs[1]!.alerte).toBe('env:OPENAI_API_KEY');
  expect(r.alertes.map((x) => x.id)).toEqual(['env:OPENAI_API_KEY', 'env:OPENROUTER_API_KEY']);
  expect(JSON.stringify(r)).not.toContain(VALEUR);
});

test('auth.json de codex présent : l’alerte, sans lire le fichier', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aid-codex-'));
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ token: VALEUR }), { mode: 0o600 });
  const r = fournisseurs({ ...base, codexHome: dir, existe: undefined, env: {} });
  expect(r.fournisseurs[1]!.secret).toBe('Identifiants dans un fichier');
  expect(r.fournisseurs[1]!.alerte).toBe('codex:auth.json');
  expect(r.alertes[0]!.titre).toBe(
    `Identifiants de codex dans un fichier (${join(dir, 'auth.json')})`,
  );
  expect(r.alertes[0]!.etapes[0]).toContain('cli_auth_credentials_store = "keyring"');
  expect(JSON.stringify(r)).not.toContain(VALEUR);
});

test('chemins courts sous le HOME, Ollama coupé, CODEX_HOME respecté', () => {
  const r = fournisseurs({ ...base, ollama: false, existe: () => true, env: { HOME: '/home/u' } });
  expect(r.alertes[0]!.titre).toBe('Identifiants de codex dans un fichier (~/.codex/auth.json)');
  expect(r.fournisseurs.map((f) => f.id)).toEqual(['anthropic', 'openai']);
  expect(codexHome({ HOME: '/home/u' })).toBe('/home/u/.codex');
  expect(codexHome({ HOME: '/home/u', CODEX_HOME: '/srv/codex' })).toBe('/srv/codex');
});

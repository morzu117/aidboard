import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lireReglagesBoucle } from '../../src/daemon/boucle/reglages.js';

describe('réglages de la boucle', () => {
  let depot: string;

  function git(...args: string[]): string {
    return execFileSync(
      'git',
      [
        '-c',
        'user.name=Personne fictive',
        '-c',
        'user.email=fictif@example.com',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { cwd: depot, encoding: 'utf8' },
    ).trim();
  }

  function enregistrerManifeste(contenu: string): string {
    writeFileSync(join(depot, 'agent.yml'), contenu);
    git('add', 'agent.yml');
    git('commit', '-qm', 'Réglages fictifs');
    return git('rev-parse', 'HEAD');
  }

  beforeEach(() => {
    depot = mkdtempSync(join(tmpdir(), 'aid-reglages-boucle-'));
    git('init', '-q');
  });

  afterEach(() => {
    rmSync(depot, { recursive: true, force: true });
  });

  it('lit les réglages au commit du GO même si HEAD et le worktree ont changé', async () => {
    const go = enregistrerManifeste(`
phases: [plan, acceptation, dev, review]
gates:
  gate: npm run gate
guardrails:
  redev_cap: 3
boucle:
  delais:
    gate: 42
`);
    enregistrerManifeste(`
phases: [dev]
gates:
  gate: "true"
guardrails:
  redev_cap: 9
boucle:
  delais:
    gate: 1
`);
    writeFileSync(join(depot, 'agent.yml'), 'gates: { gate: "false" }\n');

    expect(await lireReglagesBoucle(depot, go)).toMatchObject({
      phases: ['plan', 'acceptation', 'dev', 'review'],
      gate: 'npm run gate',
      redevCap: 3,
      delais: { gate: 42 },
    });
  });

  it('hérite des phases, du cap, des genres et des délais du noyau', async () => {
    const go = enregistrerManifeste('{}\n');

    expect(await lireReglagesBoucle(depot, go)).toEqual({
      phases: ['plan', 'dev', 'review', 'triage', 'retro'],
      gate: undefined,
      redevCap: 2,
      genres: { plan: 'claude', acceptation: 'claude', dev: 'claude', review: 'claude' },
      delais: { plan: 30, acceptation: 60, dev: 90, gate: 30, revue: 30 },
    });
  });

  it('applique les redéclarations partielles et déduit le genre de revue du préfixe codex', async () => {
    const go = enregistrerManifeste(`
capabilities:
  review_agent: codex-revue
boucle:
  delais:
    dev: 75
    revue: 20
`);

    expect(await lireReglagesBoucle(depot, go)).toMatchObject({
      genres: { plan: 'claude', acceptation: 'claude', dev: 'claude', review: 'codex' },
      delais: { plan: 30, acceptation: 60, dev: 75, gate: 30, revue: 20 },
    });
  });

  it.each(['dev_agent', 'review_agent'])('refuse un genre inconnu dans %s', async (capacite) => {
    const go = enregistrerManifeste(`capabilities:\n  ${capacite}: pilote-fictif\n`);

    await expect(async () => lireReglagesBoucle(depot, go)).rejects.toMatchObject({
      name: 'GenreAgentInconnu',
      message: expect.stringMatching(new RegExp(`${capacite}.*pilote-fictif`)),
    });
  });
});

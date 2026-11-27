import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { comparerEmpreintes, empreinteEnvironnement } from '../../src/daemon/boucle/controles.js';
import { lancerGate } from '../../src/daemon/boucle/gate.js';

describe('gardes du gate', () => {
  let depot: string;
  let tete: string;

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

  beforeEach(() => {
    depot = mkdtempSync(join(tmpdir(), 'aid-gate-garde-'));
    git('init', '-q');
    git('commit', '--allow-empty', '-qm', 'Commit fictif');
    tete = git('rev-parse', 'HEAD');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(depot, { recursive: true, force: true });
  });

  it('filtre les variables héritées et supprime le TMPDIR du gate', async () => {
    const variable = ['ANTHROPIC', 'API', 'KEY'].join('_');
    vi.stubEnv(variable, ['exemple', 'valeur', 'fictive'].join('-'));
    const resultat = await lancerGate({
      depot,
      tete,
      commande: `test -z "\${${variable}+presente}" && test -d "$TMPDIR" && printf '%s' "$TMPDIR"`,
      delaiMs: 2_000,
      listerProcessus: async () => [],
    });

    expect(resultat.issue).toBe('pass');
    expect(dirname(resultat.journal)).toBe(tmpdir());
    expect(existsSync(resultat.journal)).toBe(false);
  });

  it('envoie SIGKILL après la grâce à un groupe qui ignore SIGTERM', async () => {
    const delaiMs = 400;
    const graceMs = 120;
    const resultat = await lancerGate({
      depot,
      tete,
      commande: 'trap "" TERM; printf "%s\\n%s\\n" "$$" "$TMPDIR" > lancement; sleep 30 & wait',
      delaiMs,
      graceMs,
      listerProcessus: async () => [],
    });

    expect(resultat).toMatchObject({ issue: 'cannot_evaluate', codeSortie: null });
    expect(resultat.dureeMs).toBeGreaterThanOrEqual(delaiMs + graceMs - 5);
    const [pid, temporaire] = readFileSync(join(depot, 'lancement'), 'utf8').trim().split('\n');
    expect(Number(pid)).toBeGreaterThan(1);
    await expect
      .poll(() => {
        const processus = execFileSync('ps', ['-axo', 'pid=,stat='], { encoding: 'utf8' });
        return processus.split('\n').some((ligne) => {
          const [identifiant, statut] = ligne.trim().split(/\s+/);
          return identifiant === pid && !statut?.startsWith('Z');
        });
      })
      .toBe(false);
    expect(existsSync(temporaire!)).toBe(false);
  });
});

it('ignore les écritures de session et projette les réglages Claude de manière stable', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aid-garde-home-'));
  const config = join(home, '.claude.json');
  try {
    writeFileSync(
      config,
      JSON.stringify({
        numStartups: 1,
        projects: { fictif: { allowedTools: ['outil'], compteur: 1 } },
        mcpServers: { fictif: { command: 'exemple', args: [] } },
      }),
    );
    const avant = await empreinteEnvironnement(home);

    for (const dossier of ['.claude/sessions', '.codex/sessions', '.codex/archived_sessions']) {
      const chemin = join(home, dossier);
      mkdirSync(chemin, { recursive: true });
      writeFileSync(join(chemin, 'session.json'), '{}');
    }
    const modifie = {
      mcpServers: { fictif: { args: [], command: 'exemple' } },
      projects: {
        fictif: { compteur: 2, allowedTools: ['outil'] },
        nouveau: { compteur: 1 },
      },
      numStartups: 2,
    };
    writeFileSync(config, JSON.stringify(modifie));
    expect(comparerEmpreintes(avant, await empreinteEnvironnement(home))).toEqual([]);

    modifie.projects.fictif.allowedTools.push('autre-outil');
    writeFileSync(config, JSON.stringify(modifie));
    expect(comparerEmpreintes(avant, await empreinteEnvironnement(home))).toEqual([config]);
    writeFileSync(config, '{');
    expect((await empreinteEnvironnement(home))[config]).toBe('illisible');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

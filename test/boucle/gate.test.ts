import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { produirePreuves } from '../../src/acceptation/preuve.js';
import type { verifierAcceptation } from '../../src/acceptation/verifier.js';
import { lancerGate } from '../../src/daemon/boucle/gate.js';

describe('gate de la boucle', () => {
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

  function options(commande: string) {
    return { depot, tete, commande, delaiMs: 2_000, listerProcessus: async () => [] };
  }

  function processusActif(pid: number): boolean {
    const etat = execFileSync('ps', ['-axo', 'pid=,stat='], { encoding: 'utf8' });
    return etat.split('\n').some((ligne) => {
      const [identifiant, statut] = ligne.trim().split(/\s+/);
      return Number(identifiant) === pid && !statut?.startsWith('Z');
    });
  }

  function arreterProcessus(pid: number): void {
    if (!Number.isInteger(pid) || pid <= 1 || !processusActif(pid)) return;
    try {
      process.kill(pid, 'SIGKILL');
    } catch (erreur) {
      if ((erreur as NodeJS.ErrnoException).code !== 'ESRCH') throw erreur;
    }
  }

  beforeEach(() => {
    depot = mkdtempSync(join(tmpdir(), 'aid-boucle-gate-'));
    git('init', '-q');
    git('commit', '--allow-empty', '-qm', 'Commit fictif');
    tete = git('rev-parse', 'HEAD');
  });

  afterEach(() => {
    rmSync(depot, { recursive: true, force: true });
  });

  it('rend pass sur code 0 et associe la tête exacte au résultat', async () => {
    expect(tete).toMatch(/^[a-f0-9]{40}$/);
    const resultat = await lancerGate(options('printf "échec fictif\\n"; touch temoin; exit 0'));

    expect(resultat).toMatchObject({ issue: 'pass', tete, codeSortie: 0 });
    expect(resultat.dureeMs).toBeGreaterThanOrEqual(0);
    expect(resultat.journal).toContain('échec fictif');
    expect(existsSync(join(depot, 'temoin'))).toBe(true);
  });

  it('rend fail sur code 1 malgré le message « tests verts »', async () => {
    const resultat = await lancerGate(options('echo "tests verts"; exit 1'));

    expect(resultat).toMatchObject({ issue: 'fail', tete, codeSortie: 1 });
    expect(resultat.journal).toContain('tests verts');
  });

  it('refuse de lancer la commande si HEAD diffère de la tête attendue', async () => {
    git('commit', '--allow-empty', '-qm', 'Autre commit fictif');

    expect(await lancerGate(options('touch temoin'))).toMatchObject({
      issue: 'cannot_evaluate',
      codeSortie: null,
    });
    expect(existsSync(join(depot, 'temoin'))).toBe(false);
  });

  it('refuse également une tête abrégée qui désigne HEAD', async () => {
    const resultat = await lancerGate({ ...options('touch temoin'), tete: tete.slice(0, 12) });

    expect(resultat.issue).toBe('cannot_evaluate');
    expect(existsSync(join(depot, 'temoin'))).toBe(false);
  });

  it('termine la commande et son sleep en arrière-plan au délai', async () => {
    const cheminPids = join(depot, 'pids');
    try {
      const resultat = await lancerGate({
        ...options('sleep 30 & printf "%s\\n" "$$" "$!" > pids; wait'),
        delaiMs: 500,
      });

      expect(resultat).toMatchObject({ issue: 'cannot_evaluate', tete, codeSortie: null });
      const pids = readFileSync(cheminPids, 'utf8').trim().split('\n').map(Number);
      expect(pids).toHaveLength(2);
      expect(pids.every((pid) => Number.isInteger(pid) && pid > 1)).toBe(true);
      await expect.poll(() => pids.filter(processusActif), { timeout: 1_000 }).toEqual([]);
    } finally {
      if (existsSync(cheminPids)) {
        const pids = readFileSync(cheminPids, 'utf8').trim().split('\n').map(Number);
        pids.forEach(arreterProcessus);
      }
    }
  });

  it('borne en octets le journal cumulé de stdout et stderr', async () => {
    const resultat = await lancerGate({
      ...options(
        `node -e 'process.stdout.write("é".repeat(8192)); process.stderr.write("à".repeat(8192))'`,
      ),
      journalMaxOctets: 257,
    });

    expect(resultat).toMatchObject({ issue: 'pass', codeSortie: 0 });
    expect(Buffer.byteLength(resultat.journal)).toBeGreaterThan(0);
    expect(Buffer.byteLength(resultat.journal)).toBeLessThanOrEqual(257);
  });

  it('attend que le worktree se libère avant de lancer la commande', async () => {
    const listerProcessus = vi
      .fn(async (): Promise<number[]> => {
        expect(existsSync(join(depot, 'temoin'))).toBe(false);
        return [];
      })
      .mockImplementationOnce(async () => {
        expect(existsSync(join(depot, 'temoin'))).toBe(false);
        return [123];
      });

    const resultat = await lancerGate({
      ...options('touch temoin'),
      listerProcessus,
      delaiAttenteMs: 1_000,
    });

    expect(listerProcessus).toHaveBeenCalledWith(depot);
    expect(listerProcessus.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(resultat.issue).toBe('pass');
    expect(existsSync(join(depot, 'temoin'))).toBe(true);
  });

  it('ne lance jamais la commande si des processus occupent toujours le worktree', async () => {
    const listerProcessus = vi.fn(async () => [123]);
    const resultat = await lancerGate({
      ...options('touch temoin'),
      listerProcessus,
      delaiAttenteMs: 100,
    });

    expect(listerProcessus).toHaveBeenCalledWith(depot);
    expect(resultat).toMatchObject({ issue: 'cannot_evaluate', codeSortie: null });
    expect(existsSync(join(depot, 'temoin'))).toBe(false);
  });

  function controlesAcceptation(base: string, issue: 'pass' | 'cannot_evaluate' = 'pass') {
    const verifier = vi.fn<typeof verifierAcceptation>().mockResolvedValue({
      ok: true,
      points: {
        '69.4': { commits: [tete], fichiers: ['test/fictif.test.ts'] },
        '69.5': { commits: [tete], fichiers: ['test/fictif.test.ts', 'test/autre.test.ts'] },
      },
      fautes: [],
    });
    const produire = vi.fn<typeof produirePreuves>().mockResolvedValue([
      {
        point: '69.4',
        fautes: [],
        preuve: {
          schema_version: 1,
          repo: 'depot-fictif',
          head: tete,
          base,
          outcome: issue,
          commands: [],
          not_checked: [],
          suites: {
            base: { passed: 0, failed: 1, ids: ['cas fictif'] },
            head: { passed: 1, failed: 0, ids: ['cas fictif'] },
          },
          pass_to_fail: [],
          fail_to_pass: ['cas fictif'],
        },
      },
    ]);
    return { base, chemins: ['test/'], lancer: { '69.4': 'exit 0' }, verifier, produire };
  }

  it('appelle les contrôles du 67 et relève les fichiers d’acceptation gelés', async () => {
    const base = tete;
    git('commit', '--allow-empty', '-qm', 'Acceptation fictive');
    tete = git('rev-parse', 'HEAD');
    const acceptation = controlesAcceptation(base);

    const resultat = await lancerGate({ ...options('exit 0'), acceptation });

    expect(acceptation.verifier).toHaveBeenCalledWith({
      depot,
      base,
      chemins: acceptation.chemins,
    });
    expect(acceptation.produire.mock.calls[0]?.[0]).toMatchObject({
      depot,
      base,
      chemins: acceptation.chemins,
      lancer: acceptation.lancer,
    });
    expect(resultat.issue).toBe('pass');
    expect([...(resultat.fichiersAcceptation ?? [])].sort()).toEqual([
      'test/autre.test.ts',
      'test/fictif.test.ts',
    ]);
  });

  it('rend fail si le vérificateur signale une modification d’un fichier gelé', async () => {
    const acceptation = controlesAcceptation(tete);
    acceptation.verifier.mockResolvedValue({
      ok: false,
      points: {},
      fautes: [{ commit: tete, fichier: 'test/fictif.test.ts', raison: 'modifie_par_dev' }],
    });

    const resultat = await lancerGate({ ...options('exit 0'), acceptation });

    expect(resultat).toMatchObject({ issue: 'fail', codeSortie: 0, tete });
  });

  it('propage une preuve d’acceptation non évaluable malgré le code 0', async () => {
    const acceptation = controlesAcceptation(tete, 'cannot_evaluate');

    const resultat = await lancerGate({ ...options('exit 0'), acceptation });

    expect(resultat).toMatchObject({ issue: 'cannot_evaluate', codeSortie: 0, tete });
  });
});

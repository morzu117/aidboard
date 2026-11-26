import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { kernelInstall, runKernel, type KernelPaths } from '../src/cli/commands/kernel.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'aid-kernel-'));

function paths(): KernelPaths {
  const root = tmp();
  return {
    sourceDir: join(root, 'kernel'),
    targetDir: join(root, 'home/.agent-kernel'),
    claudeCommandsDir: join(root, 'home/.claude/commands'),
  };
}

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

describe('kernelInstall (chantier 09.2)', () => {
  test('source absente : rien à écrire, rien à retirer', () => {
    const p = paths();
    expect(kernelInstall(p)).toEqual({ written: [], removed: [], syncCommandWritten: false });
  });

  test('premier install : copie tous les fichiers de la source', () => {
    const p = paths();
    write(join(p.sourceDir, 'policy/routing.md'), 'routing v1');
    write(join(p.sourceDir, 'defaults.yml'), 'defaults v1');
    const r = kernelInstall(p);
    expect(r.written.sort()).toEqual(['defaults.yml', 'policy/routing.md'].sort());
    expect(r.removed).toEqual([]);
    expect(readFileSync(join(p.targetDir, 'policy/routing.md'), 'utf8')).toBe('routing v1');
    expect(readFileSync(join(p.targetDir, 'defaults.yml'), 'utf8')).toBe('defaults v1');
  });

  test('install déjà à jour : idempotent, rien à réécrire', () => {
    const p = paths();
    write(join(p.sourceDir, 'defaults.yml'), 'defaults v1');
    kernelInstall(p);
    const r = kernelInstall(p);
    expect(r).toEqual({ written: [], removed: [], syncCommandWritten: false });
  });

  test('un fichier modifié dans la source est réécrit, les autres restent intacts', () => {
    const p = paths();
    write(join(p.sourceDir, 'defaults.yml'), 'v1');
    write(join(p.sourceDir, 'policy/routing.md'), 'routing v1');
    kernelInstall(p);
    write(join(p.sourceDir, 'defaults.yml'), 'v2');
    const r = kernelInstall(p);
    expect(r.written).toEqual(['defaults.yml']);
    expect(readFileSync(join(p.targetDir, 'defaults.yml'), 'utf8')).toBe('v2');
    expect(readFileSync(join(p.targetDir, 'policy/routing.md'), 'utf8')).toBe('routing v1');
  });

  test('un fichier disparu du noyau est retiré de la cible', () => {
    const p = paths();
    write(join(p.sourceDir, 'roles/dev.md'), 'dev v1');
    write(join(p.sourceDir, 'roles/legacy.md'), 'legacy v1');
    kernelInstall(p);
    // 'legacy.md' disparaît du noyau (ex. adapter mort retiré)
    rmSync(join(p.sourceDir, 'roles/legacy.md'));
    const r = kernelInstall(p);
    expect(r.written).toEqual([]);
    expect(r.removed).toEqual(['roles/legacy.md']);
    expect(existsSync(join(p.targetDir, 'roles/legacy.md'))).toBe(false);
    expect(existsSync(join(p.targetDir, 'roles/dev.md'))).toBe(true);
  });

  test('--check (opts.check) : rapporte sans rien écrire ni retirer', () => {
    const p = paths();
    write(join(p.sourceDir, 'defaults.yml'), 'v1');
    const r1 = kernelInstall(p, { check: true });
    expect(r1.written).toEqual(['defaults.yml']);
    expect(existsSync(join(p.targetDir, 'defaults.yml'))).toBe(false);
  });

  test('commands/sync.md de la source est installé dans ~/.claude/commands/sync.md', () => {
    const p = paths();
    write(join(p.sourceDir, 'commands/sync.md'), 'sync v1');
    const r = kernelInstall(p);
    expect(r.syncCommandWritten).toBe(true);
    expect(readFileSync(join(p.claudeCommandsDir, 'sync.md'), 'utf8')).toBe('sync v1');
    const r2 = kernelInstall(p);
    expect(r2.syncCommandWritten).toBe(false);
  });

  test('sans commands/sync.md dans la source : pas de syncCommandWritten', () => {
    const p = paths();
    write(join(p.sourceDir, 'defaults.yml'), 'v1');
    expect(kernelInstall(p).syncCommandWritten).toBe(false);
  });

  test('cible contenant un .git (ancien clone agent-kernel) : refuse, même en --check', () => {
    const p = paths();
    write(join(p.sourceDir, 'defaults.yml'), 'v1');
    mkdirSync(join(p.targetDir, '.git'), { recursive: true });
    writeFileSync(join(p.targetDir, 'laisse-moi-tranquille.md'), 'ancien clone');
    expect(() => kernelInstall(p)).toThrow(/\.git.*ancien clone agent-kernel/);
    expect(() => kernelInstall(p, { check: true })).toThrow(/\.git.*ancien clone agent-kernel/);
    // rien n'a été touché par le refus
    expect(existsSync(join(p.targetDir, 'laisse-moi-tranquille.md'))).toBe(true);
    expect(existsSync(join(p.targetDir, 'defaults.yml'))).toBe(false);
  });
});

describe('runKernel (CLI aid kernel install [--check])', () => {
  function lines(fn: (out: (l: string) => void) => number): { code: number; out: string[] } {
    const out: string[] = [];
    const code = fn((l) => out.push(l));
    return { code, out };
  }

  test('action inconnue : erreur, code 1', () => {
    const p = paths();
    expect(runKernel('oops', [], p, () => undefined)).toBe(1);
  });

  test('install : rapporte le nombre de fichiers écrits', () => {
    const p = paths();
    write(join(p.sourceDir, 'defaults.yml'), 'v1');
    write(join(p.sourceDir, 'policy/routing.md'), 'v1');
    const { code, out } = lines((o) => runKernel('install', [], p, o));
    expect(code).toBe(0);
    expect(out.some((l) => l.includes('2 fichier(s) écrit(s)'))).toBe(true);
  });

  test('install déjà à jour : message dédié', () => {
    const p = paths();
    write(join(p.sourceDir, 'defaults.yml'), 'v1');
    runKernel('install', [], p, () => undefined);
    const { out } = lines((o) => runKernel('install', [], p, o));
    expect(out).toEqual([`✓ ${p.targetDir} déjà à jour`]);
  });

  test('install --check : « à écrire », ne matérialise rien', () => {
    const p = paths();
    write(join(p.sourceDir, 'defaults.yml'), 'v1');
    const { out } = lines((o) => runKernel('install', ['--check'], p, o));
    expect(out.some((l) => l.includes('à écrire'))).toBe(true);
    expect(existsSync(join(p.targetDir, 'defaults.yml'))).toBe(false);
  });

  test('cible avec .git (ancien clone agent-kernel) : code 1, rien écrit', () => {
    const p = paths();
    write(join(p.sourceDir, 'defaults.yml'), 'v1');
    mkdirSync(join(p.targetDir, '.git'), { recursive: true });
    expect(runKernel('install', [], p, () => undefined)).toBe(1);
    expect(existsSync(join(p.targetDir, 'defaults.yml'))).toBe(false);
  });
});

describe('/sync et la phase acceptation (chantier 67.2)', () => {
  const lire = (chemin: string) => readFileSync(new URL(`../${chemin}`, import.meta.url), 'utf8');
  const defauts = parse(lire('kernel/defaults.yml')) as { phases: string[] };
  const manifeste = parse(lire('agent.yml')) as {
    phases: string[];
    acceptation: { chemins: string[]; lancer: Record<string, string> };
  };

  // /sync est une consigne Markdown. On applique sa règle de substitution à la section Phases.
  function rendrePhases(phases: string[]): string {
    const politique = lire('kernel/policy/phases.md');
    const gabarit = lire('kernel/templates/instructions.tmpl.md');
    const lignes = phases.map((phase) => {
      const section = politique.split(`\n## ${phase}\n`)[1]?.split('\n## ')[0];
      const lecture = section?.match(/\*\*Lit\*\* — ([\s\S]+?)\n\n/)?.[1];
      const ecriture = section?.match(/\*\*Écrit\*\* — ([\s\S]+?)\n\n/)?.[1];
      if (!lecture || !ecriture) throw new Error(`Phase incomplète : ${phase}`);
      return `| ${phase} | ${lecture.replaceAll('\n', ' ')} | ${ecriture.replaceAll('\n', ' ')} |`;
    });
    return gabarit.replace(
      '{{phases.table}}',
      ['| Phase | Lit | Écrit |', '| --- | --- | --- |', ...lignes].join('\n'),
    );
  }

  test('le manifeste A-I-D rend acceptation entre plan et dev', () => {
    const rendu = rendrePhases(manifeste.phases);
    expect(rendu).toMatch(
      /\| plan \|[^\n]+\n\| acceptation \| le plan et son contrat d'acceptation, le code de la base\. \| les tests dans un commit marqué par point[^\n]+\n\| dev \|/,
    );
  });

  test('un projet sans phases explicites hérite des phases sans acceptation', () => {
    expect(defauts.phases).toEqual(['plan', 'dev', 'review', 'triage', 'retro']);
    const rendu = rendrePhases(defauts.phases);
    expect(rendu).toMatch(/\| plan \|[^\n]+\n\| dev \|/);
    expect(rendu).not.toContain('| acceptation |');
  });

  test('le schéma décrit les chemins et les commandes déclarés par A-I-D', () => {
    const schema = parse(lire('kernel/manifest.schema.yml')) as { acceptation: unknown };
    expect(schema.acceptation).toEqual({ chemins: ['string'], lancer: { '<chemin>': 'string' } });
    expect(manifeste.acceptation.chemins).toEqual(['test/', 'e2e/']);
    expect(manifeste.acceptation.lancer).toEqual({
      'test/': 'npx vitest run {fichiers}',
      'e2e/': 'npx playwright test {fichiers}',
    });
  });
});

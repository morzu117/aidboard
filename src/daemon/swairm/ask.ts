import { execFile, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ID_ASK,
  MODELES_ASK,
  parseAsk,
  parseAsks,
  type Ask,
  type Asks,
  type AskResult,
  type ModeleAsk,
} from '../../shared/swairm-ask.js';

export const BUDGET_ASK_USD = 0.5;
export interface DemandeAsk {
  question: string;
  n: number;
  modeles: ModeleAsk[];
}
export class AskOccupe extends Error {}
export function validerDemande(v: unknown): asserts v is DemandeAsk {
  const d = v as DemandeAsk | null;
  if (
    !d ||
    typeof d.question !== 'string' ||
    !d.question.trim() ||
    d.question.length > 20000 ||
    !Number.isInteger(d.n) ||
    d.n < 1 ||
    d.n > 5 ||
    !Array.isArray(d.modeles) ||
    !d.modeles.length ||
    !d.modeles.every((m) => MODELES_ASK.includes(m))
  )
    throw new RangeError('demande invalide');
}

/** Aucun texte de question ou de réponse ne passe dans les journaux. */
export class SwairmAsk {
  private courant: { depuis: string; annule: boolean; enfant?: ChildProcess } | null = null;
  constructor(
    private readonly bin = 'swairm',
    private readonly options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
  ) {}
  etat() {
    return {
      enCours: this.courant !== null,
      depuis: this.courant?.depuis ?? null,
      budgetUsd: BUDGET_ASK_USD,
    };
  }
  annuler(): void {
    if (this.courant) {
      this.courant.annule = true;
      this.courant.enfant?.kill('SIGTERM');
    }
  }
  async demander(d: DemandeAsk): Promise<AskResult<Ask>> {
    validerDemande(d);
    if (this.courant) throw new AskOccupe('demande déjà en cours');
    const courant = { depuis: new Date().toISOString(), annule: false };
    this.courant = courant;
    let dossier: string | undefined;
    try {
      dossier = await mkdtemp(join(tmpdir(), 'aid-ask-'));
      await chmod(dossier, 0o700);
      const fichier = join(dossier, 'question.txt');
      await writeFile(fichier, d.question, { mode: 0o600 });
      if (courant.annule) return { ok: false, kind: 'annule', readAt: new Date().toISOString() };
      return await this.executer(
        [
          'ask',
          '--n',
          String(d.n),
          '--modeles',
          d.modeles.join(','),
          '--question-file',
          fichier,
          '--json',
        ],
        parseAsk,
        courant,
      );
    } catch {
      return {
        ok: false,
        kind: courant.annule ? 'annule' : 'unknown',
        readAt: new Date().toISOString(),
      };
    } finally {
      try {
        if (dossier) await rm(dossier, { recursive: true, force: true });
      } finally {
        this.courant = null;
      }
    }
  }
  liste(): Promise<AskResult<Asks>> {
    return this.executer(['ask', '--list', '--json'], parseAsks);
  }
  relire(id: string): Promise<AskResult<Ask>> {
    if (!ID_ASK.test(id)) throw new RangeError('identifiant invalide');
    return this.executer(['ask', '--show', id, '--json'], parseAsk);
  }
  private executer<T>(
    args: string[],
    parse: (v: unknown) => T | null,
    courant?: NonNullable<SwairmAsk['courant']>,
  ): Promise<AskResult<T>> {
    const env = { ...(this.options.env ?? process.env) };
    for (const cle of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'OPENAI_API_KEY',
      'GH_TOKEN',
    ])
      delete env[cle];
    return new Promise((resolve) => {
      let delaiDepasse = false;
      const enfant = execFile(
        this.bin || 'swairm',
        args,
        {
          env,
          killSignal: 'SIGTERM',
          maxBuffer: 4 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          clearTimeout(delai);
          const readAt = new Date().toISOString();
          const e = err as
            (Omit<NodeJS.ErrnoException, 'code'> & { code?: string | number }) | null;
          if (courant?.annule) return resolve({ ok: false, kind: 'annule', readAt });
          if (e?.code === 'ENOENT') return resolve({ ok: false, kind: 'absent', readAt });
          if (delaiDepasse) return resolve({ ok: false, kind: 'timeout', readAt });
          if (e?.code === 2)
            return resolve(
              stderr.includes('invalid choice')
                ? { ok: false, kind: 'too-old', readAt }
                : {
                    ok: false,
                    kind: 'refusee',
                    message: stderr.split(/\r?\n/)[0]!.slice(0, 300),
                    readAt,
                  },
            );
          if (e && e.code !== 3) return resolve({ ok: false, kind: 'unknown', readAt });
          let data: T | null = null;
          try {
            data = parse(JSON.parse(stdout));
          } catch {
            /* JSON illisible */
          }
          if (data === null) return resolve({ ok: false, kind: 'format', readAt });
          resolve(e ? { ok: false, kind: 'aucun-avis', data, readAt } : { ok: true, data, readAt });
        },
      );
      const delai = setTimeout(() => {
        delaiDepasse = true;
        enfant.kill('SIGTERM');
      }, this.options.timeoutMs ?? 600000);
      if (courant) courant.enfant = enfant;
      enfant.stdin?.on('error', () => undefined);
      enfant.stdin?.end();
    });
  }
}

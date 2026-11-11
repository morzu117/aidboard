import { execFile } from 'node:child_process';
import {
  parseTrailers,
  type LecturePrSwairm,
  type CommitSwairm,
} from '../../shared/swairm-trailers.js';

const objet = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const nonLu = (raison: string): LecturePrSwairm => ({
  pr: null,
  commits: [],
  etat: 'non-lu',
  raison,
});

/** D289 : lecture seule, argv séparés, cache par dépôt et sujet, fusion en vol. */
export class SwairmPr {
  private cache = new Map<string, { a: number; resultat: Promise<LecturePrSwairm> }>();
  constructor(
    private readonly bin = '',
    private readonly options: { now?: () => number; delaiMs?: number } = {},
  ) {}

  lire(projet: string, sujet: string): Promise<LecturePrSwairm> {
    if (
      !/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$(?![\s\S])/.test(projet) ||
      !/^[A-Za-z0-9._/-]{1,200}$(?![\s\S])/.test(sujet)
    )
      return Promise.resolve(nonLu('identifiants invalides'));
    const now = this.options.now ?? Date.now;
    const cle = `${projet}#${sujet}`;
    const precedente = this.cache.get(cle);
    if (precedente && (precedente.a === -1 || now() - precedente.a < 60000))
      return precedente.resultat;
    const entree = { a: -1, resultat: this.executer(projet, sujet) };
    this.cache.set(cle, entree);
    void entree.resultat.then(() => {
      entree.a = now();
    });
    return entree.resultat;
  }

  private async executer(projet: string, sujet: string): Promise<LecturePrSwairm> {
    const fin = Date.now() + (this.options.delaiMs ?? 15000);
    const lire = (args: string[]): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const restant = fin - Date.now();
        if (restant <= 0) {
          reject(new Error('délai dépassé'));
          return;
        }
        execFile(
          this.bin || 'gh',
          args,
          { timeout: restant, maxBuffer: 4 * 1024 * 1024 },
          (erreur, stdout) => {
            if (erreur) {
              reject(
                new Error(
                  erreur.code === 'ENOENT'
                    ? 'gh absent'
                    : erreur.killed
                      ? 'délai dépassé'
                      : 'échec de gh',
                ),
              );
              return;
            }
            try {
              resolve(JSON.parse(stdout) as unknown);
            } catch {
              reject(new Error('format illisible'));
            }
          },
        );
      });
    try {
      const liste = await lire([
        'pr',
        'list',
        '-R',
        projet,
        '--head',
        sujet,
        '--state',
        'all',
        '--json',
        'number,headRefName,title,body,isCrossRepository,headRepositoryOwner,state,mergedAt',
        '--limit',
        '50',
      ]);
      if (!Array.isArray(liste)) return nonLu('format illisible');
      if (liste.length >= 50)
        return nonLu('limite de 50 PR atteinte : liste potentiellement incomplète');
      const prs = liste.filter(
        (p: unknown): p is Record<string, unknown> =>
          objet(p) &&
          p.headRefName === sujet &&
          p.isCrossRepository === false &&
          objet(p.headRepositoryOwner) &&
          typeof p.headRepositoryOwner.login === 'string' &&
          p.headRepositoryOwner.login.toLowerCase() === projet.split('/')[0]!.toLowerCase(),
      );
      const ouvertes = prs.filter((p) => p.state === 'OPEN');
      if (ouvertes.length > 1) return nonLu('plusieurs PR ouvertes');
      const mergees = prs.filter(
        (p) =>
          p.state === 'MERGED' &&
          typeof p.mergedAt === 'string' &&
          Number.isFinite(Date.parse(p.mergedAt)),
      );
      mergees.sort(
        (a, b) =>
          Date.parse(b.mergedAt as string) - Date.parse(a.mergedAt as string) ||
          Number(b.number) - Number(a.number),
      );
      const choisie = ouvertes[0] ?? mergees[0];
      if (!choisie) return { pr: null, commits: [], etat: 'ok' };
      const numero: unknown = choisie.number;
      if (typeof numero !== 'number' || !Number.isSafeInteger(numero) || numero < 1)
        return nonLu('format illisible');
      const vue = await lire([
        'pr',
        'view',
        String(numero),
        '-R',
        projet,
        '--json',
        'number,state,url,commits',
      ]);
      if (
        !objet(vue) ||
        vue.number !== numero ||
        typeof vue.state !== 'string' ||
        typeof vue.url !== 'string' ||
        !Array.isArray(vue.commits)
      )
        return nonLu('format illisible');
      const commits: CommitSwairm[] = [];
      for (const c of vue.commits) {
        if (
          !objet(c) ||
          typeof c.oid !== 'string' ||
          typeof c.committedDate !== 'string' ||
          typeof c.messageHeadline !== 'string' ||
          typeof c.messageBody !== 'string'
        )
          continue;
        const trailers = parseTrailers(`${c.messageHeadline}\n\n${c.messageBody}`);
        if (!trailers || trailers.subject !== sujet) continue;
        commits.push({
          sha: c.oid,
          date: c.committedDate,
          step: trailers.step,
          proof: trailers.proof,
          attempt: trailers.attempt,
          drone: trailers.drone,
        });
      }
      return {
        pr: {
          number: numero,
          state: vue.state,
          ...(vue.url.startsWith('https://github.com/') ? { url: vue.url } : {}),
        },
        commits,
        etat: 'ok',
      };
    } catch (erreur) {
      return nonLu(erreur instanceof Error ? erreur.message : 'échec de lecture');
    }
  }
}

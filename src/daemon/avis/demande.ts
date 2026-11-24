import { randomBytes } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, open, readdir, readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseAsk, type Ask, type Asks } from '../../shared/swairm-ask.js';
import {
  lancerFournisseur,
  validerAvis,
  type EnvironnementAvis,
  type Fournisseur,
} from './fournisseurs.js';
import { accord, lireReponse } from './lecture.js';
import { construirePrompt, decouper, PROMPT_VERSION, type SousQuestion } from './prompt.js';

export interface DemandeAvis {
  question: string;
  sousQuestions?: SousQuestion[];
  avis: { fournisseur: Fournisseur; modele: string }[];
  budgetUsd: number;
  delaiMs: number;
}

export async function relire(fichier: string): Promise<Ask> {
  const demande = parseAsk(JSON.parse(await readFile(fichier, 'utf8')));
  if (!demande || basename(fichier) !== `${demande.id}.json`) throw new Error('Demande illisible.');
  return demande;
}

async function archiver(dossier: string, demande: Ask, signal?: AbortSignal): Promise<Ask> {
  signal?.throwIfAborted();
  await mkdir(dossier, { recursive: true, mode: 0o700 });
  await chmod(dossier, 0o700);
  const temporaire = await mkdtemp(join(dossier, '.ask-'));
  try {
    const dateId = demande.genere_a.slice(0, 19).replace(/[-:]/g, '') + 'Z';
    const source = join(temporaire, 'avis.json');
    for (;;) {
      demande.id = `${dateId}-${randomBytes(2).toString('hex')}`;
      const cible = join(dossier, `${demande.id}.json`);
      const fichier = await open(source, 'w', 0o600);
      try {
        await fichier.writeFile(JSON.stringify(demande, null, 1));
        await fichier.sync();
      } finally {
        await fichier.close();
      }
      try {
        signal?.throwIfAborted();
        await link(source, cible);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw err;
      }
      return await relire(cible);
    }
  } finally {
    await rm(temporaire, { recursive: true, force: true });
  }
}

export async function lancerAvis(
  demande: DemandeAvis,
  deps: EnvironnementAvis & { dossier: string },
): Promise<Ask> {
  const { question, budgetUsd, delaiMs } = demande;
  if (
    !question.trim() ||
    question.length > 20000 ||
    demande.avis.length < 1 ||
    demande.avis.length > 5
  )
    throw new RangeError('Demande invalide.');
  const sousQuestions = demande.sousQuestions?.length ? demande.sousQuestions : decouper(question);
  if (
    sousQuestions.length > 12 ||
    new Set(sousQuestions.map(({ n }) => n)).size !== sousQuestions.length ||
    sousQuestions.some(
      ({ n, texte }) => !Number.isSafeInteger(n) || n < 1 || typeof texte !== 'string',
    )
  )
    throw new RangeError('Sous-questions invalides.');

  const prompt = construirePrompt(question, sousQuestions);
  const appels = demande.avis.map(({ fournisseur, modele }) => {
    const options = { prompt, modele, budgetUsd, delaiMs };
    validerAvis(fournisseur, options);
    return { fournisseur, options };
  });
  const avis: Ask['avis'] = [];
  let prochain = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, appels.length) }, async () => {
      while (!deps.signal?.aborted && prochain < appels.length) {
        const index = prochain++;
        const appel = appels[index]!;
        const { texte, detail, ...brut } = await lancerFournisseur(
          appel.fournisseur,
          appel.options,
          deps,
        );
        const lu = brut.etat === 'ok' ? lireReponse(texte, sousQuestions) : null;
        const etat = lu?.etat ?? brut.etat;
        avis[index] = {
          ...brut,
          i: index + 1,
          etat,
          reponses: lu?.reponses ?? [],
          brut: etat === 'invalide' ? texte.slice(0, 4000) : (detail ?? null),
        };
      }
    }),
  );
  const archive: Ask = {
    format: 'swairm-ask/1',
    id: '',
    genere_a: new Date().toISOString(),
    prompt_version: PROMPT_VERSION,
    question,
    sous_questions: sousQuestions,
    avis,
    accord: sousQuestions.map(({ n }) =>
      accord(
        n,
        avis.flatMap((a) => a.reponses.filter((r) => r.n === n).map((r) => r.verdict)),
      ),
    ),
    cout_total_usd: avis.reduce((total, a) => total + (a.cout_usd ?? 0), 0),
  };
  return archiver(deps.dossier, archive, deps.signal);
}

export async function liste(dossier: string): Promise<Asks> {
  const resultat: Asks = { format: 'swairm-asks/1', demandes: [], erreurs: [] };
  const fichiers = await readdir(dossier).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  for (const fichier of fichiers.filter((nom) => nom.endsWith('.json'))) {
    try {
      const { id, genere_a, question, avis, accord } = await relire(join(dossier, fichier));
      resultat.demandes.push({
        id,
        genere_a,
        question: question.slice(0, 200),
        n: avis.length,
        accord,
      });
    } catch {
      resultat.erreurs.push({ fichier, erreur: 'Demande illisible.' });
    }
  }
  resultat.demandes.sort((a, b) => b.genere_a.localeCompare(a.genere_a));
  resultat.demandes = resultat.demandes.slice(0, 20);
  return resultat;
}

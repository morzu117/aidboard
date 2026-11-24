import { parseArgs } from 'node:util';
import type { AidPaths } from '../../daemon/paths.js';
import { modelesAvis, routage, type NiveauAvis } from '../../shared/routage.js';
import { parseAsk, type Ask } from '../../shared/swairm-ask.js';
import { callDaemon, resolveTarget } from '../client.js';

function montant(cout: number | null): string {
  return cout === null ? 'inconnu' : `${cout} USD`;
}

function afficher(data: Ask): void {
  for (const avis of data.avis) {
    const [fournisseur, ...modele] = avis.modele_demande.split(':');
    console.log(`${fournisseur}\t${modele.join(':')}\t${avis.etat}\t${montant(avis.cout_usd)}`);
  }
  console.log('n\taccord\tverdict\tcompte');
  for (const accord of data.accord) {
    const compte = Object.entries(accord.compte)
      .map(([verdict, n]) => `${verdict}=${n}`)
      .join(', ');
    console.log(`${accord.n}\t${accord.accord}\t${accord.verdict ?? '—'}\t${compte || '—'}`);
  }
  const total = data.avis.every((avis) => avis.cout_usd !== null) ? data.cout_total_usd : null;
  console.log(`Coût total ${montant(total)}`);
}

export async function runAvis(args: string[], paths: AidPaths): Promise<number> {
  try {
    const { positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        'sous-question': { type: 'string', multiple: true },
        niveau: { type: 'string', default: 'standard' },
        n: { type: 'string', default: '3' },
        challenge: { type: 'boolean' },
        budget: { type: 'string' },
        json: { type: 'boolean' },
      },
    });
    const [question] = positionals;
    if (positionals.length !== 1 || !question?.trim())
      throw new Error('Une question est attendue.');
    if (!Object.hasOwn(routage.niveaux, values.niveau))
      throw new Error('Niveau attendu : leger, standard ou fort.');
    if (!/^[1-5]$/.test(values.n)) throw new Error('Nombre d’avis attendu entre 1 et 5.');
    const budgetUsd = values.budget === undefined ? undefined : Number(values.budget);
    if (budgetUsd !== undefined && !(budgetUsd > 0 && budgetUsd <= 2))
      throw new Error('Budget attendu entre 0 et 2 USD, hors zéro.');

    const modeles = modelesAvis(values.niveau as NiveauAvis, values.challenge ?? false);
    const { status, json } = await callDaemon(
      resolveTarget(paths),
      'POST',
      '/api/swairm/ask',
      {
        question,
        n: values.challenge ? modeles.length : Number(values.n),
        modeles,
        sousQuestions: values['sous-question']?.map((texte, i) => ({ n: i + 1, texte })),
        budgetUsd,
      },
      1_210_000,
      { 'X-AID-Confirm': 'ask' },
    );
    const data =
      status === 200 && (json.ok === true || json.kind === 'aucun-avis')
        ? parseAsk(json.data)
        : null;
    if (!data) {
      const message =
        json.kind === 'refusee' && typeof json.message === 'string'
          ? `question refusée : ${json.message}`
          : (json.message ?? json.error ?? json.kind);
      throw new Error(typeof message === 'string' ? message : 'Demande d’avis impossible.');
    }
    if (values.json) console.log(JSON.stringify(data));
    else afficher(data);
    if (!data.avis.some((avis) => avis.etat === 'ok')) return 3;
    return data.accord.every(({ accord }) => accord === 'unanime' || accord === 'majorite') ? 0 : 4;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

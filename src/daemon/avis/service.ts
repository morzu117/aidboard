import { homedir } from 'node:os';
import { join } from 'node:path';
import { nettoyer } from '../../shared/nettoyage.js';
import { ID_ASK, type Ask, type Asks, type AskResult } from '../../shared/swairm-ask.js';
import { lancerAvis, liste, relire } from './demande.js';
import { validerBudget, validerModele, type EnvironnementAvis } from './fournisseurs.js';
import { decouper, type SousQuestion } from './prompt.js';

const BUDGET_ASK_USD = 0.5;
const DELAI_AVIS_MS = 600000;

interface DemandeAsk {
  question: string;
  n: number;
  modeles: string[];
  sousQuestions?: SousQuestion[];
  budgetUsd?: number;
}

interface OptionsService extends EnvironnementAvis {
  hotesPrives?: string[];
  dossierSwairm?: string;
}

export class AskOccupe extends Error {}

function lireModele(valeur: unknown) {
  if (typeof valeur !== 'string') throw new RangeError('modèle invalide');
  const separateur = valeur.indexOf(':');
  const fournisseur = separateur === -1 ? 'claude' : valeur.slice(0, separateur);
  const modele = valeur.slice(separateur + 1);
  validerModele(fournisseur, modele);
  return { fournisseur, modele };
}

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
    !d.modeles.length
  )
    throw new RangeError('demande invalide');
  d.modeles.forEach(lireModele);
  if (d.budgetUsd !== undefined) validerBudget(d.budgetUsd);
  const sousQuestions = d.sousQuestions;
  if (
    sousQuestions !== undefined &&
    (!Array.isArray(sousQuestions) ||
      sousQuestions.length > 12 ||
      sousQuestions.some(
        (s) => !s || !Number.isSafeInteger(s.n) || s.n < 1 || typeof s.texte !== 'string',
      ) ||
      new Set(sousQuestions.map(({ n }) => n)).size !== sousQuestions.length)
  )
    throw new RangeError('sous-questions invalides');
}

function resultatAvis(data: Ask): AskResult<Ask> {
  const readAt = new Date().toISOString();
  return data.avis.some((avis) => avis.etat === 'ok')
    ? { ok: true, data, readAt }
    : { ok: false, kind: 'aucun-avis', data, readAt };
}

export class ServiceAvis {
  private readonly dossier: string;
  private readonly dossierSwairm: string;
  private courant: { depuis: string; controle: AbortController } | null = null;

  constructor(
    home: string,
    private readonly deps: OptionsService = {},
  ) {
    this.dossier = join(home, 'avis');
    this.dossierSwairm = deps.dossierSwairm ?? join(homedir(), '.swairm', 'asks');
  }

  etat() {
    return {
      enCours: this.courant !== null,
      depuis: this.courant?.depuis ?? null,
      budgetUsd: BUDGET_ASK_USD,
    };
  }

  annuler(): void {
    this.courant?.controle.abort();
  }

  async demander(d: unknown): Promise<AskResult<Ask>> {
    if (this.courant) throw new AskOccupe('demande déjà en cours');
    validerDemande(d);
    const filtrer = (texte: string) =>
      nettoyer(texte, { hotesPrives: this.deps.hotesPrives ?? [] });
    const refus = (classe: string): AskResult<Ask> => ({
      ok: false,
      kind: 'refusee',
      message: classe,
      readAt: new Date().toISOString(),
    });
    const question = filtrer(d.question);
    if (!question.ok) return refus(question.classe);
    const sousQuestions = d.sousQuestions?.length ? d.sousQuestions : decouper(d.question);
    for (const { texte } of sousQuestions) {
      const resultat = filtrer(texte);
      if (!resultat.ok) return refus(resultat.classe);
    }

    const controle = new AbortController();
    this.courant = { depuis: new Date().toISOString(), controle };
    try {
      const data = await lancerAvis(
        {
          question: d.question,
          sousQuestions,
          avis: Array.from({ length: d.n }, (_, i) => lireModele(d.modeles[i % d.modeles.length])),
          budgetUsd: d.budgetUsd ?? BUDGET_ASK_USD,
          delaiMs: DELAI_AVIS_MS,
        },
        { ...this.deps, dossier: this.dossier, signal: controle.signal },
      );
      return resultatAvis(data);
    } catch {
      return {
        ok: false,
        kind: controle.signal.aborted ? 'annule' : 'unknown',
        readAt: new Date().toISOString(),
      };
    } finally {
      this.courant = null;
    }
  }

  async liste(): Promise<AskResult<Asks>> {
    const readAt = new Date().toISOString();
    try {
      const [locale, swairm] = await Promise.all([liste(this.dossier), liste(this.dossierSwairm)]);
      const demandes = new Map(locale.demandes.map((demande) => [demande.id, demande]));
      for (const demande of swairm.demandes) {
        if (!demandes.has(demande.id)) demandes.set(demande.id, demande);
      }
      return {
        ok: true,
        readAt,
        data: {
          format: locale.format,
          demandes: [...demandes.values()]
            .sort((a, b) => Date.parse(b.genere_a) - Date.parse(a.genere_a))
            .slice(0, 20),
          erreurs: [...locale.erreurs, ...swairm.erreurs],
        },
      };
    } catch {
      return { ok: false, kind: 'unknown', readAt };
    }
  }

  async relire(id: string): Promise<AskResult<Ask>> {
    if (!ID_ASK.test(id)) throw new RangeError('identifiant invalide');
    const readAt = new Date().toISOString();
    for (const dossier of [this.dossier, this.dossierSwairm]) {
      try {
        return { ok: true, data: await relire(join(dossier, `${id}.json`)), readAt };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
          return { ok: false, kind: 'format', readAt };
      }
    }
    return { ok: false, kind: 'absent', readAt };
  }
}

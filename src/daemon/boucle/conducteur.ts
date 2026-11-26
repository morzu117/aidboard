import { homedir, tmpdir } from 'node:os';
import {
  avertissements,
  comparerEmpreintes,
  constatsEmpreinteHome,
  empreinteEnvironnement,
  releverDiff,
  type EmpreinteEnvironnement,
} from './controles.js';
import type { ActionBoucle, EvenementBoucle, Tentative } from './etat.js';
import { lancerGate, type ResultatGate } from './gate.js';
import { gitBoucle } from './git.js';
import { messageEtape, type ContexteMessage } from './messages.js';
import { lireReglagesBoucle, type ReglagesBoucle, type RoleEtape } from './reglages.js';
import { lireRevue, type AttenduRevue } from './revue.js';

interface ContexteConduite {
  depot: string;
  slug: string;
  teteDepart: string;
  sessionId?: string;
  reglages: ReglagesBoucle;
  message: ContexteMessage;
  revue?: AttenduRevue & { namespace: string };
  gate?: {
    go: string;
    reglagesGeles?: boolean;
    signal?: AbortSignal;
    tete: string;
    acceptation?: Parameters<typeof lancerGate>[0]['acceptation'];
  };
}

interface Acteur {
  genre: ReglagesBoucle['genres'][RoleEtape];
  modele: string;
  sessionId: string;
}

interface LecturesArtefact {
  lirePage(slug: string): Promise<string | undefined>;
  lireMessagesCommits(depot: string, teteDepart: string): Promise<string[]>;
}

interface DependancesConduite extends LecturesArtefact {
  lancer(options: { depot: string; role: RoleEtape; genre: Acteur['genre'] }): Promise<Acteur>;
  ecrire(sessionId: string, texte: string): Promise<void>;
  arreter(sessionId: string): Promise<void>;
  consignerActeur(acteur: Acteur & { role: RoleEtape }): Promise<void>;
  escalader(raison: string, details?: string[]): Promise<void>;
  lancerGate?: typeof lancerGate;
  gate?: {
    consignerEmpreinte(empreinte: EmpreinteEnvironnement): Promise<void>;
    lireEmpreinte(): Promise<EmpreinteEnvironnement | undefined>;
    verifierDepot?(): Promise<string[]>;
    consignerResultat(
      resultat: ResultatGate,
      alertes: Awaited<ReturnType<typeof avertissements>>,
    ): Promise<void>;
  };
}

async function controlerGate(contexte: ContexteConduite, deps: DependancesConduite): Promise<void> {
  if (!contexte.gate || !deps.gate) return deps.escalader('cannot_evaluate');
  const { depot } = contexte;
  const { go, tete, acceptation } = contexte.gate;

  let constat;
  try {
    const changementsDepot = (await deps.gate.verifierDepot?.()) ?? [];
    if (changementsDepot.length) return deps.escalader('scope', changementsDepot);
    const { entrees, alertes } = await releverDiff(depot, go, tete);
    if (entrees.length) {
      return deps.escalader(
        'scope',
        entrees.map(({ fichier, raison }) => `${fichier} : ${raison}`),
      );
    }
    const avantDev = await deps.gate.lireEmpreinte();
    if (!avantDev) return deps.escalader('cannot_evaluate');
    const avantGate = await empreinteEnvironnement(homedir());
    const changementsDev = comparerEmpreintes(avantDev, avantGate);
    if (changementsDev.length) return deps.escalader('scope', changementsDev);

    const reglages = contexte.gate.reglagesGeles
      ? contexte.reglages
      : await lireReglagesBoucle(depot, go);
    const avecAcceptation = reglages.phases.includes('acceptation');
    if (!reglages.gate || (avecAcceptation && !acceptation)) {
      return deps.escalader('cannot_evaluate');
    }
    const resultat = await (deps.lancerGate ?? lancerGate)({
      depot,
      tete,
      commande: reglages.gate,
      delaiMs: reglages.delais.gate * 60_000,
      acceptation: avecAcceptation ? acceptation : undefined,
      ...(contexte.gate.signal && { signal: contexte.gate.signal }),
    });
    const apresGate = await empreinteEnvironnement(homedir());
    constat = {
      resultat,
      alertes,
      apresGate,
      changementsGate: [
        ...comparerEmpreintes(avantGate, apresGate),
        ...((await deps.gate.verifierDepot?.()) ?? []),
      ],
    };
  } catch {
    return deps.escalader('cannot_evaluate');
  }
  if (constat.changementsGate.length) {
    await deps.escalader('scope', constat.changementsGate);
    return deps.gate.consignerResultat(
      { ...constat.resultat, issue: 'cannot_evaluate' },
      constat.alertes,
    );
  }
  await deps.gate.consignerEmpreinte(constat.apresGate);
  return deps.gate.consignerResultat(constat.resultat, constat.alertes);
}

export async function executer(
  action: ActionBoucle,
  contexte: ContexteConduite,
  deps: DependancesConduite,
): Promise<void> {
  switch (action.type) {
    case 'lancer_etape': {
      const role = action.etape === 'revue' ? 'review' : action.etape;
      const texte = messageEtape(role, { ...contexte.message, revue: contexte.revue });
      if (role === 'dev' && deps.gate) {
        const empreinte = await empreinteEnvironnement(homedir());
        const constats = constatsEmpreinteHome(empreinte);
        if (constats.length) return deps.escalader('scope', constats);
        await deps.gate.consignerEmpreinte(empreinte);
      }
      const acteur = await deps.lancer({
        depot: contexte.depot,
        role,
        genre: contexte.reglages.genres[role],
      });
      await deps.consignerActeur({ ...acteur, role });
      return deps.ecrire(acteur.sessionId, texte);
    }
    case 'escalader':
      return deps.escalader(action.raison);
    case 'relancer_etape':
      if (!contexte.sessionId) throw new Error('Session de l’étape introuvable');
      return deps.ecrire(
        contexte.sessionId,
        'L’artefact attendu manque. Produis-le avant de terminer.',
      );
    case 'arreter_etape':
      if (action.etape === 'gate') throw new Error('L’arrêt du gate relève du contrôle du gate');
      if (contexte.sessionId) await deps.arreter(contexte.sessionId);
      return;
    case 'lancer_gate':
      return controlerGate(contexte, deps);
  }
}

async function porteTrailerAcceptation(message: string): Promise<boolean> {
  const trailers = await gitBoucle(tmpdir(), ['interpret-trailers', '--parse'], message);
  return /^Acceptation:[ \t]*\S/im.test(trailers);
}

export async function artefactPresent(
  etape: Tentative['type'],
  contexte: ContexteConduite,
  deps: LecturesArtefact,
): Promise<boolean> {
  switch (etape) {
    case 'plan':
      return Boolean((await deps.lirePage(`aid/plan/${contexte.slug}`))?.trim());
    case 'acceptation': {
      const messages = await deps.lireMessagesCommits(contexte.depot, contexte.teteDepart);
      for (const message of messages) {
        if (await porteTrailerAcceptation(message)) return true;
      }
      return false;
    }
    case 'dev': {
      const messages = await deps.lireMessagesCommits(contexte.depot, contexte.teteDepart);
      return (
        messages.length > 0 &&
        Boolean((await deps.lirePage(`aid/dev-handoff/${contexte.slug}`))?.trim())
      );
    }
    case 'revue':
    case 'gate':
    case 'triage':
      return false;
  }
}

export async function terminerRevue(
  contexte: Pick<ContexteConduite, 'slug' | 'revue'>,
  deps: Pick<LecturesArtefact, 'lirePage'>,
): Promise<[EvenementBoucle] | [EvenementBoucle, EvenementBoucle]> {
  const { revue, slug } = contexte;
  if (!revue) return [{ type: 'artefact_manquant' }];

  // Cet adaptateur reçoit la réponse finale de l'appelant.
  const texteFinal = await deps.lirePage(`${revue.namespace}/review/${slug}`);
  if (texteFinal === undefined) return [{ type: 'artefact_manquant' }];

  const resultat = lireRevue(texteFinal, revue);
  if (!resultat.ok) return [{ type: 'artefact_manquant' }];
  return [
    { type: 'revue_terminee', tete: revue.tete },
    { type: 'triage_termine', categories: resultat.categories },
  ];
}

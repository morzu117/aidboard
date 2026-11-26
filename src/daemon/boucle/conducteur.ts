import { execFile } from 'node:child_process';
import type { ActionBoucle, Tentative } from './etat.js';
import { messageEtape, type ContexteMessage } from './messages.js';
import type { ReglagesBoucle, RoleEtape } from './reglages.js';

interface ContexteConduite {
  depot: string;
  slug: string;
  teteDepart: string;
  sessionId?: string;
  reglages: ReglagesBoucle;
  message: ContexteMessage;
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
  escalader(raison: string): Promise<void>;
}

export async function executer(
  action: ActionBoucle,
  contexte: ContexteConduite,
  deps: DependancesConduite,
): Promise<void> {
  switch (action.type) {
    case 'lancer_etape': {
      const role = action.etape === 'revue' ? 'review' : action.etape;
      const texte = messageEtape(role, contexte.message);
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
      throw new Error('Le lancement du gate relève du contrôle du gate');
  }
}

function porteTrailerAcceptation(message: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const processus = execFile('git', ['interpret-trailers', '--parse'], (erreur, stdout) => {
      if (erreur) reject(erreur);
      else resolve(/^Acceptation:[ \t]*\S/im.test(stdout));
    });
    processus.stdin?.on('error', reject);
    processus.stdin?.end(message);
  });
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
    case 'gate':
    case 'revue':
      return false;
  }
}

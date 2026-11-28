import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { parse } from 'yaml';
import { lireChemins, lireLanceurs } from '../../cli/commands/acceptation.js';
import { verifierAcceptation } from '../../acceptation/verifier.js';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';
import type { MemoryPage } from '../../shared/memory.js';
import type { MemoryService } from '../memory/service.js';
import { artefactPresent, executer } from './conducteur.js';
import {
  comparerEmpreintes,
  constatsEmpreinteHome,
  empreinteEnvironnement,
  entreesGelees,
  gitSujet,
  empreinteDepot,
  empreinteMetadonnees,
  type EmpreinteEnvironnement,
} from './controles.js';
import * as depotBoucle from './depot.js';
import { transition, type EtatBoucle, type EvenementBoucle } from './etat.js';
import { lancerGate, type ResultatGate } from './gate.js';
import { lireReglagesBoucle, type ReglagesBoucle } from './reglages.js';
import {
  contexteConfigGitGlobale,
  gitBoucle,
  lireBaseDistante,
  lireConfigGitGlobale,
} from './git.js';
import { heureDepartGroupe, memeGroupe, type ConsignerGroupe } from './groupes.js';
import { lireRevue } from './revue.js';

type DependancesConducteur = Parameters<typeof executer>[2];
type Agents = Pick<DependancesConducteur, 'ecrire' | 'arreter'> & {
  disponible?(genre: 'claude' | 'codex'): boolean;
  lancer(
    options: Parameters<DependancesConducteur['lancer']>[0] & {
      sujetId: string;
      consignerGroupe: ConsignerGroupe;
    },
  ): ReturnType<DependancesConducteur['lancer']>;
};
type EvenementAgent =
  | { type: 'turn_end'; texteFinal?: string | null }
  | { type: 'exit' }
  | { type: 'needs_input'; question: string }
  | { type: 'session'; sessionId: string; modele?: string };
interface Sujet {
  id: string;
  slug: string;
  worktree: string;
  state: string;
  base: string;
}
interface EtatService extends EtatBoucle {
  go?: string;
  reglages?: ReglagesBoucle;
  optionsAcceptation?: NonNullable<Parameters<typeof lancerGate>[0]['acceptation']>;
  revisionAttendue?: number;
  empreinteGo?: EmpreinteEnvironnement;
  metadonneesGit?: EmpreinteEnvironnement;
  plan?: string;
  namespace?: string;
  interventions?: number;
  escalade?: { raison: string; question?: string };
  phaseSuspendue?: EtatBoucle['phase'];
  empreinte?: EmpreinteEnvironnement;
  resultatGate?: ResultatGate;
  constats?: string[];
  tests?: { tete: string; commits: string[]; fichiers: string[]; points: string[] };
  findings?: string;
}
type Boucle = NonNullable<ReturnType<typeof depotBoucle.lire>> & { etat: EtatService };
const terminal = (phase: EtatBoucle['phase']) => phase === 'arretee' || phase === 'livraison_prete';
function empreintePlan(page?: MemoryPage) {
  const contenu =
    page && !page.closed ? [page.revision, page.title, page.frontmatter, page.body] : null;
  return createHash('sha256').update(JSON.stringify(contenu)).digest('hex');
}
function textePublic(texte: string) {
  const home = homedir();
  return home.length > 1 ? texte.replaceAll(home, '~') : texte;
}

export const TAILLE_MAX_REPONSE_BOUCLE = 256 * 1024;

type CauseInterruptionGate = 'arreter' | 'tic' | 'plan' | 'fermer';

export class ServiceBoucle {
  private readonly verrous = new Map<string, Promise<unknown>>();
  private readonly configGitGlobale = lireConfigGitGlobale();
  private readonly maintenant: () => number;
  private fermeture?: Promise<void>;
  private readonly gates = new Map<
    string,
    { controle: AbortController; cause?: 'arreter' | 'tic' | 'plan' | 'fermer' }
  >();

  constructor(
    private readonly deps: {
      db: Db;
      memory: MemoryService;
      agents: Agents;
      maintenant?: () => number;
      lancerGate?: typeof lancerGate;
      isolationGate?: (
        sujetId: string,
        agentId: string,
      ) => Parameters<typeof lancerGate>[0]['isolation'];
    },
  ) {
    this.maintenant = deps.maintenant ?? Date.now;
  }

  private avecVerrou<T>(sujetId: string, action: () => Promise<T>): Promise<T> {
    const suite = (this.verrous.get(sujetId) ?? Promise.resolve())
      .catch(() => {})
      .then(() => contexteConfigGitGlobale.run(this.configGitGlobale, action));
    this.verrous.set(sujetId, suite);
    return suite.finally(() => {
      if (this.verrous.get(sujetId) === suite) this.verrous.delete(sujetId);
    });
  }

  private sujet(id: string): Sujet {
    const sujet = this.deps.db
      .prepare('SELECT id, slug, worktree, state, base FROM topics WHERE id = ?')
      .get(id) as Sujet | undefined;
    if (!sujet) throw new AidHttpError(404, 'Sujet inconnu');
    return sujet;
  }

  private chercher(sujetId: string): Boucle | undefined {
    return depotBoucle.lireDerniere(this.deps.db, sujetId);
  }

  private exiger(sujetId: string, phase?: EtatBoucle['phase']): Boucle {
    const boucle = this.chercher(sujetId);
    if (
      this.fermeture ||
      !boucle ||
      terminal(boucle.etat.phase) ||
      (phase && boucle.etat.phase !== phase)
    )
      throw new AidHttpError(409, 'Commande indisponible pour cette boucle');
    return boucle;
  }

  private sauver(boucle: Boucle) {
    depotBoucle.enregistrer(this.deps.db, boucle);
  }

  private pageMemoire(etat: EtatService, sujet: Sujet, type: string) {
    return this.deps.memory.get(`${etat.namespace ?? 'aid'}/${type}/${sujet.slug}`);
  }

  private page(etat: EtatService, sujet: Sujet, type: string) {
    const page = this.pageMemoire(etat, sujet, type);
    return page && !page.closed ? page.body : undefined;
  }

  private async git(sujet: Sujet, ...args: string[]) {
    const resultat = await gitSujet(sujet.worktree, args);
    if (!resultat.ok) throw new AidHttpError(409, 'Impossible de lire le dépôt du sujet');
    return resultat.stdout;
  }

  private async manifeste(sujet: Sujet, tete: string) {
    return (parse(await this.git(sujet, 'show', '--end-of-options', `${tete}:agent.yml`)) ??
      {}) as {
      project?: { namespace?: string };
      acceptation?: { chemins?: unknown; lancer?: unknown };
    };
  }

  lire(sujetId: string) {
    const sujet = this.sujet(sujetId);
    const etat = this.chercher(sujetId)?.etat;
    const tempsParEtapeMs: Record<string, number> = {};
    const historique = [];
    for (const etape of etat?.etapes ?? []) {
      if (etape.issue === null || etape.fin === undefined) continue;
      historique.push(etape);
      tempsParEtapeMs[etape.type] = (tempsParEtapeMs[etape.type] ?? 0) + etape.fin - etape.debut;
    }
    const courante = etat?.etapes.at(-1);
    const plan = etat?.phase === 'attente_go' ? this.page(etat, sujet, 'plan') : etat?.plan;
    const escalade = etat?.escalade;
    return {
      phase: etat?.phase ?? null,
      etapeCourante: courante?.issue === null && courante.type === etat?.phase ? courante : null,
      historique,
      plan: plan === undefined ? null : textePublic(plan),
      escalade: escalade
        ? {
            raison: escalade.raison,
            constats: (etat?.constats ?? []).map(textePublic),
            ...(escalade.question && { question: textePublic(escalade.question) }),
          }
        : null,
      mesures: {
        tempsParEtapeMs,
        interventionsHumaines: etat?.interventions ?? 0,
        redevs: etat?.redevs ?? 0,
      },
    };
  }

  private async reglages(sujet: Sujet, tete: string) {
    const disponible = this.deps.agents.disponible;
    const reglages = await lireReglagesBoucle(
      sujet.worktree,
      tete,
      disponible?.('codex') ? 'codex' : undefined,
    );
    for (const genre of new Set(Object.values(reglages.genres))) {
      if (disponible && !disponible(genre))
        throw new AidHttpError(422, `${genre} introuvable dans le PATH du daemon`);
    }
    return reglages;
  }

  private verifierAbsenceSession(sujetId: string) {
    if (
      this.deps.db
        .prepare(
          `SELECT 1 FROM agents a JOIN runs r ON r.id = a.run_id
      WHERE r.topic_id = ? AND a.status IN ('starting', 'working', 'needs_input', 'idle')`,
        )
        .get(sujetId)
    )
      throw new AidHttpError(409, 'Une session est déjà active sur ce sujet');
  }

  lancer(sujetId: string) {
    return this.avecVerrou(sujetId, async () => {
      const sujet = this.sujet(sujetId);
      const precedente = this.chercher(sujetId);
      if (
        this.fermeture ||
        sujet.state !== 'active' ||
        (precedente && !terminal(precedente.etat.phase))
      )
        throw new AidHttpError(409, 'Le sujet ne peut pas démarrer une boucle');
      this.verifierAbsenceSession(sujetId);
      const metadonneesGit = await empreinteMetadonnees(sujet.worktree);
      const tete = await this.git(sujet, 'rev-parse', 'HEAD');
      const distante = await gitSujet(sujet.worktree, [
        'rev-parse',
        '--verify',
        `refs/remotes/origin/${sujet.base}`,
      ]);
      if (distante.ok) {
        const connue = await lireBaseDistante(sujet.worktree, sujet.base).catch(() => {
          throw new AidHttpError(409, 'Impossible de lire la base distante');
        });
        const [teteBase] = connue.split('\t');
        if (!teteBase || !/^[a-f0-9]{40}$/.test(teteBase))
          throw new AidHttpError(409, 'La tête de la base est introuvable');
        const aJour = await gitSujet(sujet.worktree, [
          'merge-base',
          '--is-ancestor',
          teteBase,
          tete,
        ]);
        if (!aJour.ok)
          throw new AidHttpError(409, 'La branche du sujet doit contenir la base courante');
      }
      const reglages = await this.reglages(sujet, tete);
      const manifeste = await this.manifeste(sujet, tete);
      const debut = this.maintenant();
      const boucle: Boucle = {
        id: randomUUID(),
        sujetId,
        etat: {
          phase: 'plan',
          reglages,
          acceptation: reglages.phases.includes('acceptation'),
          redevCap: reglages.redevCap,
          redevs: 0,
          tete,
          empreintePlan: null,
          metadonneesGit,
          gate: null,
          revue: null,
          namespace: manifeste.project?.namespace ?? 'aid',
          etapes: [
            {
              type: 'plan',
              tentative: 1,
              agentId: null,
              debut,
              echeance: debut + reglages.delais.plan * 60_000,
              issue: null,
              teteDepart: tete,
            },
          ],
        },
      };
      this.verifierAbsenceSession(sujetId);
      depotBoucle.creer(this.deps.db, boucle);
      await this.conduire(boucle, sujet, { type: 'lancer_etape', etape: 'plan' });
    });
  }

  go(sujetId: string) {
    return this.avecVerrou(sujetId, async () => {
      const boucle = this.exiger(sujetId, 'attente_go');
      const sujet = this.sujet(sujetId);
      const page = this.pageMemoire(boucle.etat, sujet, 'plan');
      if (!page?.body.trim() || page.closed) throw new AidHttpError(409, 'Le plan est absent');
      const changementsGit = await this.verifierMetadonnees(boucle, sujet);
      if (changementsGit.length) {
        await this.escalader(boucle, 'scope', changementsGit);
        throw new AidHttpError(409, 'Les réglages git ont changé avant le GO');
      }
      const tete = await this.git(sujet, 'rev-parse', 'HEAD');
      if (tete !== (boucle.etat.go ?? boucle.etat.etapes[0]?.teteDepart ?? boucle.etat.tete)) {
        await this.escalader(boucle, 'scope', ['La tête a changé avant le GO']);
        throw new AidHttpError(409, 'La tête a changé avant le GO');
      }
      const metadonneesGit =
        boucle.etat.metadonneesGit ?? (await empreinteMetadonnees(sujet.worktree));
      const empreinteGo = await empreinteDepot(sujet.worktree, tete);
      const reglages = await this.reglages(sujet, tete);
      const manifeste = reglages.phases.includes('acceptation')
        ? await this.manifeste(sujet, tete)
        : undefined;
      Object.assign(boucle.etat, {
        go: tete,
        empreinteGo,
        metadonneesGit,
        reglages,
        optionsAcceptation: manifeste
          ? {
              base: tete,
              chemins: lireChemins(manifeste.acceptation?.chemins),
              lancer: lireLanceurs(manifeste.acceptation?.lancer),
            }
          : undefined,
        tete,
        plan: page.body,
        empreintePlan: empreintePlan(page),
        acceptation: reglages.phases.includes('acceptation'),
        redevCap: reglages.redevCap,
        interventions: (boucle.etat.interventions ?? 0) + 1,
        escalade: undefined,
      });
      await this.appliquer(boucle, sujet, { type: 'go' });
    });
  }

  repondre(sujetId: string, reponse: string) {
    return this.avecVerrou(sujetId, async () => {
      const boucle = this.exiger(sujetId, 'escalade');
      const etape = boucle.etat.etapes.at(-1);
      if (!reponse.trim() || !etape?.agentId || !boucle.etat.phaseSuspendue)
        throw new AidHttpError(409, 'Aucune question en attente');
      await this.deps.agents.ecrire(etape.agentId, reponse);
      boucle.etat.phase = boucle.etat.phaseSuspendue;
      delete boucle.etat.phaseSuspendue;
      delete boucle.etat.escalade;
      boucle.etat.interventions = (boucle.etat.interventions ?? 0) + 1;
      this.sauver(boucle);
    });
  }

  arreter(sujetId: string) {
    this.interrompreGate(sujetId, 'arreter');
    return this.avecVerrou(sujetId, async () => {
      const boucle = this.exiger(sujetId);
      boucle.etat.interventions = (boucle.etat.interventions ?? 0) + 1;
      boucle.etat.phase = boucle.etat.phaseSuspendue ?? boucle.etat.phase;
      delete boucle.etat.phaseSuspendue;
      delete boucle.etat.escalade;
      await this.appliquer(boucle, this.sujet(sujetId), { type: 'arreter' });
    });
  }

  private async appliquer(boucle: Boucle, sujet: Sujet, evenement: EvenementBoucle) {
    const avant = boucle.etat;
    const precedente = avant.etapes.at(-1);
    const ancienAgent = precedente?.agentId ?? undefined;
    if (
      evenement.type === 'arreter' &&
      ancienAgent &&
      precedente?.issue === null &&
      precedente.type === avant.phase
    ) {
      await this.deps.agents.arreter(ancienAgent);
    }
    const { etat, actions } = transition(avant, evenement, this.maintenant());
    if (etat === avant) return;
    boucle.etat = etat;
    this.sauver(boucle);
    for (const action of actions) {
      if (evenement.type === 'arreter' && action.type === 'arreter_etape') continue;
      await this.conduire(boucle, sujet, action, ancienAgent);
    }
  }

  private async escalader(boucle: Boucle, raison: string, constats?: string[]) {
    const etape = boucle.etat.etapes.at(-1);
    const agentActif = etape?.issue === null ? etape.agentId : null;
    if (etape?.issue === null) {
      etape.issue = 'cannot_evaluate';
      etape.fin = this.maintenant();
      etape.teteArrivee = boucle.etat.tete;
    }
    boucle.etat.phase = 'escalade';
    boucle.etat.escalade = { raison };
    boucle.etat.constats = constats;
    this.sauver(boucle);
    if (agentActif) await this.deps.agents.arreter(agentActif);
  }

  private async contexte(boucle: Boucle, sujet: Sujet) {
    const { etat } = boucle;
    const etape = etat.etapes.at(-1)!;
    const go = etat.go ?? etat.tete;
    const reglages = etat.reglages ?? (await lireReglagesBoucle(sujet.worktree, go));
    const revue =
      etape.type === 'revue'
        ? {
            namespace: etat.namespace ?? 'aid',
            tete: etat.tete,
            points: etat.tests?.points ?? [],
            fichiers: (
              await this.git(
                sujet,
                'diff',
                '--no-ext-diff',
                '--no-renames',
                '--name-only',
                '-z',
                go,
                etat.tete,
                '--',
              )
            )
              .split('\0')
              .filter(Boolean),
          }
        : undefined;
    return {
      depot: sujet.worktree,
      slug: sujet.slug,
      namespace: etat.namespace,
      teteDepart: etape.teteDepart ?? etat.tete,
      sessionId: etape.agentId ?? undefined,
      reglages,
      revue,
      message: {
        plan: etat.plan ?? '',
        empreintePlan: etat.empreintePlan ?? '',
        sujet: { namespace: etat.namespace ?? 'aid', slug: sujet.slug },
        commitTests: etat.tests?.commits.join(', '),
        findings: etat.findings,
        rapportGate: etat.resultatGate?.journal,
        diff: revue
          ? await this.git(sujet, 'diff', '--no-ext-diff', '--no-textconv', go, etat.tete, '--')
          : undefined,
      },
      gate: {
        go,
        tete: etat.tete,
        reglagesGeles: true,
        signal: this.gates.get(sujet.id)?.controle.signal,
        acceptation: etat.optionsAcceptation,
        consignerGroupe: (pid: number) => this.consignerGroupe(boucle, pid),
      },
    };
  }

  private lectures(boucle: Boucle, sujet: Sujet, garderPage = false) {
    return {
      lirePage: async (slug: string) => {
        const page = this.pageMemoire(boucle.etat, sujet, slug.split('/').at(-2)!);
        if (page && !page.closed && (garderPage || page.revision !== boucle.etat.revisionAttendue))
          return page.body;
      },
      lireMessagesCommits: async (_depot: string, depart: string) =>
        (await this.git(sujet, 'log', '--format=%B%x00', `${depart}..HEAD`))
          .split('\0')
          .filter((message) => message.trim()),
    };
  }

  private async conduire(
    boucle: Boucle,
    sujet: Sujet,
    action: Parameters<typeof executer>[0],
    ancienAgent?: string,
  ) {
    if (this.fermeture && action.type !== 'arreter_etape') return;
    try {
      if (action.type === 'arreter_etape') {
        if (ancienAgent) await this.deps.agents.arreter(ancienAgent);
        return;
      }
      if (action.type === 'escalader') {
        if (action.raison === 'ambiguity' && ancienAgent)
          await this.deps.agents.arreter(ancienAgent);
        await this.escalader(boucle, action.raison);
        return;
      }
      if (action.type === 'lancer_gate') {
        this.gates.set(sujet.id, { controle: new AbortController() });
      }
      const contexte = await this.contexte(boucle, sujet);
      const etape = boucle.etat.etapes.at(-1)!;
      if (action.type === 'lancer_etape' || action.type === 'lancer_gate') {
        const type = action.type === 'lancer_gate' ? 'gate' : action.etape;
        etape.echeance = etape.debut + contexte.reglages.delais[type] * 60_000;
        if (action.type === 'lancer_etape') {
          const page = action.etape === 'dev' ? 'dev-handoff' : 'plan';
          if (action.etape !== 'revue')
            boucle.etat.revisionAttendue = this.pageMemoire(boucle.etat, sujet, page)?.revision;
          if (action.etape === 'plan' || action.etape === 'acceptation') {
            const empreinte = await empreinteEnvironnement(homedir(), undefined, {
              worktree: sujet.worktree,
            });
            const constats = constatsEmpreinteHome(empreinte);
            if (constats.length) return await this.escalader(boucle, 'scope', constats);
            boucle.etat.empreinte = empreinte;
          }
        }
        this.sauver(boucle);
      }

      await executer(action, contexte, {
        ...this.lectures(boucle, sujet),
        lancer: (options) =>
          this.deps.agents.lancer({
            ...options,
            sujetId: sujet.id,
            consignerGroupe: contexte.gate.consignerGroupe,
          }),
        ecrire: (session, texte) => this.deps.agents.ecrire(session, texte),
        arreter: (session) => this.deps.agents.arreter(session),
        consignerActeur: async (acteur) => {
          if (
            boucle.etat.etapes.some(
              (autre) => autre !== etape && autre.agentId === acteur.sessionId,
            )
          )
            throw new Error('Session déjà utilisée par une autre étape');
          etape.agentId = acteur.sessionId;
          etape.acteur = acteur;
          this.sauver(boucle);
        },
        escalader: (raison, constats) => this.escalader(boucle, raison, constats),
        lancerGate: this.deps.lancerGate,
        gate: {
          isolation: () => {
            const dev = boucle.etat.etapes.findLast(({ type }) => type === 'dev');
            return this.deps.isolationGate?.(sujet.id, dev?.agentId ?? boucle.id);
          },
          lireEmpreinte: async () => boucle.etat.empreinte,
          verifierDepot: () => this.verifierDepot(boucle, sujet),
          consignerEmpreinte: async (empreinte) => {
            boucle.etat.empreinte = empreinte;
            this.sauver(boucle);
          },
          consignerResultat: async (resultat, alertes) => {
            boucle.etat.resultatGate = resultat;
            etape.preuve = { codeSortie: resultat.codeSortie ?? undefined };
            if (boucle.etat.phase !== 'escalade')
              boucle.etat.constats = alertes.map(({ fichier, raison }) => `${fichier} : ${raison}`);
            this.sauver(boucle);
          },
        },
      });
      if (action.type === 'lancer_gate' && boucle.etat.phase === 'gate') {
        const cause = this.gates.get(sujet.id)?.cause;
        this.gates.delete(sujet.id);
        if (cause === 'arreter' || cause === 'fermer') return;
        if (await this.planChange(boucle, sujet)) return;
        if (cause === 'tic') {
          await this.appliquer(boucle, sujet, { type: 'tic' });
          return;
        }
        const tete = await this.git(sujet, 'rev-parse', 'HEAD');
        if (tete !== boucle.etat.tete) {
          await this.appliquer(boucle, sujet, { type: 'tete_modifiee', tete });
          return;
        }
        const resultat = boucle.etat.resultatGate!;
        await this.appliquer(boucle, sujet, {
          type: 'gate_termine',
          tete: resultat.tete,
          issue: resultat.issue,
        });
      }
    } catch {
      await this.escalader(boucle, 'cannot_evaluate');
    } finally {
      if (action.type === 'lancer_gate') this.gates.delete(sujet.id);
    }
  }

  private async verifierMetadonnees(boucle: Boucle, sujet: Sujet) {
    const { metadonneesGit } = boucle.etat;
    return metadonneesGit
      ? comparerEmpreintes(metadonneesGit, await empreinteMetadonnees(sujet.worktree))
      : [];
  }

  private async verifierDepot(boucle: Boucle, sujet: Sujet) {
    const changements = await this.verifierMetadonnees(boucle, sujet);
    const { go, empreinteGo } = boucle.etat;
    if (changements.length || !go || !empreinteGo) return changements;
    return comparerEmpreintes(empreinteGo, await empreinteDepot(sujet.worktree, go));
  }

  private async planChange(boucle: Boucle, sujet: Sujet) {
    if (!boucle.etat.go || !boucle.etat.empreintePlan) return false;
    const empreinte = empreintePlan(this.pageMemoire(boucle.etat, sujet, 'plan'));
    if (empreinte === boucle.etat.empreintePlan) return false;
    boucle.etat.phase = boucle.etat.phaseSuspendue ?? boucle.etat.phase;
    delete boucle.etat.phaseSuspendue;
    delete boucle.etat.escalade;
    await this.appliquer(boucle, sujet, { type: 'plan_modifie', empreinte });
    return true;
  }

  private sujetsActifs(): string[] {
    return (
      this.deps.db
        .prepare("SELECT sujet_id FROM boucles WHERE phase NOT IN ('arretee', 'livraison_prete')")
        .all() as { sujet_id: string }[]
    ).map(({ sujet_id }) => sujet_id);
  }

  async traiterEvenementAgent(sessionId: string, evenement: EvenementAgent) {
    if (this.fermeture) return;
    const ligne = this.deps.db
      .prepare(
        `SELECT b.sujet_id FROM boucles b JOIN boucle_etapes e ON e.boucle_id = b.id
      WHERE json_extract(e.donnees, '$.agentId') = ? AND json_extract(e.donnees, '$.issue') IS NULL`,
      )
      .get(sessionId) as { sujet_id: string } | undefined;
    if (!ligne) return;
    await this.avecVerrou(ligne.sujet_id, async () => {
      const boucle = this.chercher(ligne.sujet_id);
      const etape = boucle?.etat.etapes.at(-1);
      if (!boucle || etape?.agentId !== sessionId || etape.issue !== null) return;
      const sujet = this.sujet(boucle.sujetId);
      try {
        if (await this.planChange(boucle, sujet)) return;
        if (evenement.type === 'session') {
          if (
            boucle.etat.etapes.some(
              (autre) => autre !== etape && autre.acteur?.sessionId === evenement.sessionId,
            )
          ) {
            await this.escalader(boucle, 'cannot_evaluate');
            return;
          }
          if (etape.acteur) {
            etape.acteur.sessionId = evenement.sessionId;
            if (evenement.modele) etape.acteur.modele = evenement.modele;
          }
          this.sauver(boucle);
        } else if (evenement.type === 'exit') {
          await this.escalader(boucle, 'cannot_evaluate');
        } else if (evenement.type === 'needs_input') {
          if (boucle.etat.phase === 'escalade') return;
          boucle.etat.phaseSuspendue = boucle.etat.phase;
          boucle.etat.phase = 'escalade';
          boucle.etat.escalade = { raison: 'needs_input', question: evenement.question };
          delete boucle.etat.constats;
          this.sauver(boucle);
        } else if (boucle.etat.phase !== 'escalade') {
          await this.terminer(boucle, sujet, etape, evenement.texteFinal);
        }
      } catch {
        await this.escalader(boucle, 'cannot_evaluate');
      }
    });
  }

  private async enregistrerReponse(
    boucle: Boucle,
    sujet: Sujet,
    type: 'plan' | 'revue',
    texte: string,
  ) {
    const role = type === 'plan' ? 'plan' : 'review';
    const precedente = this.pageMemoire(boucle.etat, sujet, role);
    return this.deps.memory.put(
      `${boucle.etat.namespace ?? 'aid'}/${role}/${sujet.slug}`,
      texte,
      precedente ? { kind: 'replace', expectedRevision: precedente.revision } : { kind: 'create' },
      { author: role, topicId: sujet.id },
    );
  }

  private async terminer(
    boucle: Boucle,
    sujet: Sujet,
    etape: EtatBoucle['etapes'][number],
    texteFinal?: string | null,
  ) {
    const lectureSeule = etape.type === 'plan' || etape.type === 'revue';
    const refus =
      lectureSeule &&
      (texteFinal === null || Buffer.byteLength(texteFinal ?? '') > TAILLE_MAX_REPONSE_BOUCLE);
    if (etape.type === 'revue' && (refus || !texteFinal?.trim())) {
      await this.appliquer(boucle, sujet, { type: 'artefact_manquant' });
      return;
    }
    const contexte = await this.contexte(boucle, sujet);
    const revue = contexte.revue && texteFinal ? lireRevue(texteFinal, contexte.revue) : undefined;
    const garderPage = etape.type === 'plan' && !refus && !texteFinal?.trim();
    if (etape.type === 'plan' && !refus && texteFinal?.trim())
      await this.enregistrerReponse(boucle, sujet, 'plan', texteFinal);
    const lectures = this.lectures(boucle, sujet, garderPage);
    const artefact =
      etape.type === 'revue'
        ? revue?.ok === true
        : !refus && (await artefactPresent(etape.type, contexte, lectures));
    if (artefact && etape.agentId) await this.deps.agents.arreter(etape.agentId);
    if (await this.planChange(boucle, sujet)) return;
    const tete = await this.git(sujet, 'rev-parse', 'HEAD');
    const { go, empreinte, tests } = boucle.etat;
    const changementsDepot = await this.verifierDepot(boucle, sujet);
    if (changementsDepot.length) {
      await this.escalader(boucle, 'scope', changementsDepot);
      return;
    }
    let testsModifies = false;
    if (etape.type === 'dev' && tests) {
      const touches = (
        await this.git(sujet, 'diff', '--name-only', '-z', tests.tete, tete, '--')
      ).split('\0');
      const chemins = contexte.gate.acceptation?.chemins ?? [];
      testsModifies = touches.some(
        (fichier) =>
          tests.fichiers.includes(fichier) ||
          chemins.some((chemin) => fichier.startsWith(chemin.replace(/\/+$/, '') + '/')),
      );
    }
    // Le relevé d’entrée du gate couvre aussi la sortie d’un dev qui lui passe la main.
    const versGate = etape.type === 'dev' && artefact && !testsModifies;
    if (!versGate) {
      const changements = empreinte
        ? comparerEmpreintes(
            empreinte,
            await empreinteEnvironnement(homedir(), undefined, { worktree: sujet.worktree }),
          )
        : [];
      const interdits = await entreesGelees(sujet.worktree, go ?? contexte.teteDepart, tete);
      if (changements.length || interdits.length) {
        await this.escalader(boucle, 'scope', [
          ...changements,
          ...interdits.map(({ fichier, raison }) => `${fichier} : ${raison}`),
        ]);
        return;
      }
    }
    if (etape.type === 'revue' && tete !== boucle.etat.tete) {
      await this.appliquer(boucle, sujet, { type: 'tete_modifiee', tete });
      return;
    }
    if (testsModifies) {
      boucle.etat.tete = tete;
      await this.appliquer(boucle, sujet, { type: 'tests_modifies' });
      return;
    }
    if (!artefact) {
      await this.appliquer(boucle, sujet, { type: 'artefact_manquant' });
      return;
    }
    if (await this.git(sujet, 'status', '--porcelain', '--untracked-files=all')) {
      await this.escalader(boucle, 'scope');
      return;
    }
    switch (etape.type) {
      case 'plan': {
        const page = this.pageMemoire(boucle.etat, sujet, 'plan');
        boucle.etat.plan = page?.body;
        await this.appliquer(boucle, sujet, {
          type: 'plan_termine',
          empreinte: empreintePlan(page),
        });
        break;
      }
      case 'acceptation': {
        const options = contexte.gate.acceptation!;
        const rapport = await verifierAcceptation({
          depot: sujet.worktree,
          base: options.base,
          chemins: options.chemins,
          lireGit: gitBoucle,
        });
        if (!rapport.ok || !Object.keys(rapport.points).length) {
          await this.escalader(boucle, 'scope');
          return;
        }
        boucle.etat.tests = {
          tete,
          commits: [...new Set(Object.values(rapport.points).flatMap(({ commits }) => commits))],
          points: Object.keys(rapport.points),
          fichiers: [...new Set(Object.values(rapport.points).flatMap(({ fichiers }) => fichiers))],
        };
        await this.appliquer(boucle, sujet, { type: 'etape_terminee', etape: etape.type, tete });
        break;
      }
      case 'dev':
        await this.appliquer(boucle, sujet, { type: 'etape_terminee', etape: etape.type, tete });
        break;
      case 'revue': {
        if (!revue?.ok || !texteFinal) return;
        await this.enregistrerReponse(boucle, sujet, 'revue', texteFinal);
        const issue = [
          ...Object.values(revue.verdicts.fichiers),
          ...Object.values(revue.verdicts.points),
        ].includes('fail')
          ? 'fail'
          : 'pass';
        boucle.etat.findings = JSON.stringify(revue.findings);
        await this.appliquer(boucle, sujet, { type: 'revue_terminee', tete, issue });
        await this.appliquer(boucle, sujet, {
          type: 'triage_termine',
          categories: revue.categories,
        });
        break;
      }
    }
  }

  private interrompreGate(sujetId: string, cause: CauseInterruptionGate) {
    const gate = this.gates.get(sujetId);
    if (gate && !gate.cause) {
      gate.cause = cause;
      gate.controle.abort();
    }
  }

  async tic() {
    if (this.fermeture) return;
    for (const id of this.gates.keys()) {
      const boucle = this.chercher(id);
      if (!boucle) continue;
      const etape = boucle.etat.etapes.at(-1);
      const plan = this.pageMemoire(boucle.etat, this.sujet(id), 'plan');
      if (empreintePlan(plan) !== boucle.etat.empreintePlan) {
        this.interrompreGate(id, 'plan');
      } else if (etape?.echeance != null && this.maintenant() >= etape.echeance) {
        this.interrompreGate(id, 'tic');
      }
    }
    await Promise.all(
      this.sujetsActifs()
        .filter((id) => !this.verrous.has(id))
        .map((id) =>
          this.avecVerrou(id, async () => {
            const boucle = this.chercher(id);
            if (!boucle || terminal(boucle.etat.phase) || boucle.etat.phase === 'attente_go')
              return;
            const sujet = this.sujet(id);
            if (await this.planChange(boucle, sujet)) return;
            const echeance = boucle.etat.etapes.at(-1)?.echeance;
            if (boucle.etat.phaseSuspendue && echeance != null && this.maintenant() >= echeance) {
              boucle.etat.phase = boucle.etat.phaseSuspendue;
              delete boucle.etat.phaseSuspendue;
              delete boucle.etat.escalade;
            }
            await this.appliquer(boucle, sujet, { type: 'tic' });
          }),
        ),
    );
  }

  private consignerGroupe(boucle: Boucle, pid: number) {
    const heureDepart = heureDepartGroupe(pid);
    if (!heureDepart) return;
    const groupe = { pid, heureDepart };
    boucle.etat.groupes = [...(boucle.etat.groupes ?? []).filter(memeGroupe), groupe];
    this.sauver(boucle);
    return () => {
      boucle.etat.groupes = boucle.etat.groupes?.filter((entree) => entree !== groupe);
      this.sauver(boucle);
    };
  }

  private nettoyerReprise(boucle: Boucle) {
    for (const groupe of boucle.etat.groupes ?? []) {
      if (!memeGroupe(groupe)) continue;
      try {
        process.kill(-groupe.pid, 'SIGKILL');
      } catch (erreur) {
        if ((erreur as NodeJS.ErrnoException).code !== 'ESRCH') throw erreur;
      }
    }
    delete boucle.etat.groupes;
  }

  async reprendre() {
    const echecs = new Set<string>();
    for (const boucle of depotBoucle.lireAvecGroupes(this.deps.db)) {
      try {
        this.nettoyerReprise(boucle);
        this.sauver(boucle);
      } catch {
        echecs.add(boucle.id);
      }
    }
    const escalader = (boucle: Boucle) =>
      this.escalader(
        boucle,
        'cannot_evaluate',
        echecs.has(boucle.id)
          ? ['Le nettoyage des groupes de la boucle à la reprise a échoué']
          : undefined,
      );
    for (const boucle of depotBoucle.reprendre(this.deps.db, this.maintenant())) {
      await escalader(boucle);
    }
    for (const id of this.sujetsActifs()) {
      const boucle = this.chercher(id);
      if (!boucle?.etat.phaseSuspendue) continue;
      delete boucle.etat.phaseSuspendue;
      await escalader(boucle);
    }
  }

  fermer(): Promise<void> {
    return (this.fermeture ??= this.fermerInterne());
  }

  private async fermerInterne() {
    for (const id of this.gates.keys()) this.interrompreGate(id, 'fermer');
    await Promise.allSettled(this.verrous.values());
    await Promise.allSettled(
      this.sujetsActifs().map(async (id) => {
        const etape = this.chercher(id)?.etat.etapes.at(-1);
        if (etape?.issue === null && etape.agentId) await this.deps.agents.arreter(etape.agentId);
      }),
    );
  }
}

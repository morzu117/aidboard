import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as attendre } from 'node:timers/promises';
import { produirePreuves } from '../../acceptation/preuve.js';
import { verifierAcceptation } from '../../acceptation/verifier.js';
import { gitSujet, processusDansWorktree } from './controles.js';

interface OptionsGate {
  signal?: AbortSignal;
  depot: string;
  tete: string;
  commande: string;
  delaiMs: number;
  graceMs?: number;
  listerProcessus?: (depot: string) => Promise<number[]>;
  delaiAttenteMs?: number;
  journalMaxOctets?: number;
  acceptation?: Omit<Parameters<typeof produirePreuves>[0], 'depot'> & {
    verifier?: typeof verifierAcceptation;
    produire?: typeof produirePreuves;
  };
}

export interface ResultatGate {
  issue: 'pass' | 'fail' | 'cannot_evaluate';
  tete: string;
  codeSortie: number | null;
  dureeMs: number;
  journal: string;
  fichiersAcceptation?: string[];
}

async function attendreWorktree(
  depot: string,
  lister: (depot: string) => Promise<number[]>,
  delai: number,
): Promise<boolean> {
  const controle = new AbortController();
  const echeance = performance.now() + delai;
  async function sonder() {
    while (!controle.signal.aborted) {
      const pids = await lister(depot);
      if (performance.now() >= echeance || controle.signal.aborted) return false;
      if (!pids.length) return true;
      await attendre(50, undefined, { signal: controle.signal });
    }
    return false;
  }

  try {
    return await Promise.race([sonder(), attendre(delai, false, { signal: controle.signal })]);
  } finally {
    controle.abort();
  }
}

async function lireTete(depot: string): Promise<string | undefined> {
  const resultat = await gitSujet(depot, ['rev-parse', '--verify', '--end-of-options', 'HEAD']);
  return resultat.ok ? resultat.stdout : undefined;
}

const variablesGate = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TERM',
  'TZ',
  'CI',
]);

function environnementGate(temporaire: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([nom]) => variablesGate.has(nom) || nom.startsWith('LC_'),
      ),
    ),
    TMPDIR: temporaire,
  };
}

function executerCommande(
  depot: string,
  commande: string,
  env: NodeJS.ProcessEnv,
  delai: number,
  grace: number,
  maximum: number,
  signal?: AbortSignal,
): Promise<{ codeSortie: number | null; journal: string }> {
  return new Promise((rendre) => {
    const enfant = spawn('/bin/sh', ['-c', commande], {
      cwd: depot,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let restant = maximum;
    let octetsJournal = 0;
    let journal = '';
    let expire = false;
    let sorti = false;
    let terminee = false;
    let tuer: NodeJS.Timeout | undefined;

    for (const flux of [enfant.stdout, enfant.stderr]) {
      const decodeur = new StringDecoder('utf8');
      flux.on('data', (octets: Buffer) => {
        if (restant <= 0) return;
        const texte = decodeur.write(octets.subarray(0, restant));
        restant -= octets.length;
        const taille = Buffer.byteLength(texte);
        if (octetsJournal + taille <= maximum) {
          journal += texte;
          octetsJournal += taille;
          return;
        }
        // Les octets UTF-8 invalides peuvent être remplacés par un caractère plus long.
        for (const caractere of texte) {
          const tailleCaractere = Buffer.byteLength(caractere);
          if (octetsJournal + tailleCaractere > maximum) {
            restant = 0;
            break;
          }
          journal += caractere;
          octetsJournal += tailleCaractere;
        }
      });
    }

    function signaler(signal: NodeJS.Signals) {
      if (!enfant.pid) return;
      try {
        process.kill(-enfant.pid, signal);
      } catch {
        // Le groupe a pu disparaître avant l'envoi du signal.
      }
    }

    function finir(codeSortie: number | null) {
      if (terminee) return;
      terminee = true;
      clearTimeout(echeance);
      clearTimeout(tuer);
      signal?.removeEventListener('abort', arreter);
      rendre({ codeSortie, journal });
    }

    function forcerArret() {
      signaler('SIGKILL');
      enfant.stdout.destroy();
      enfant.stderr.destroy();
      finir(null);
    }

    function arreter() {
      if (expire || terminee) return;
      expire = true;
      signaler('SIGTERM');
      if (sorti) forcerArret();
      else tuer = setTimeout(forcerArret, grace);
    }
    const echeance = setTimeout(arreter, delai);
    signal?.addEventListener('abort', arreter, { once: true });
    if (signal?.aborted) arreter();

    enfant.on('error', () => finir(null));
    enfant.on('exit', () => {
      sorti = true;
      if (expire && !terminee) forcerArret();
    });
    enfant.on('close', (code) => finir(expire ? null : code));
  });
}

export async function lancerGate({
  signal,
  depot,
  tete,
  commande,
  delaiMs,
  graceMs = 5_000,
  listerProcessus = processusDansWorktree,
  delaiAttenteMs = 5_000,
  journalMaxOctets = 64 * 1024,
  acceptation,
}: OptionsGate): Promise<ResultatGate> {
  const debut = performance.now();
  let codeSortie: number | null = null;
  let journal = '';
  let fichiersAcceptation: string[] | undefined;
  function resultat(issue: ResultatGate['issue']): ResultatGate {
    return {
      issue,
      tete,
      codeSortie,
      journal,
      dureeMs: performance.now() - debut,
      ...(fichiersAcceptation === undefined ? {} : { fichiersAcceptation }),
    };
  }

  async function evaluer(env: NodeJS.ProcessEnv): Promise<ResultatGate> {
    if (signal?.aborted || (await lireTete(depot)) !== tete) return resultat('cannot_evaluate');

    ({ codeSortie, journal } = await executerCommande(
      depot,
      commande,
      env,
      delaiMs,
      graceMs,
      journalMaxOctets,
      signal,
    ));
    if (codeSortie === null || (await lireTete(depot)) !== tete) return resultat('cannot_evaluate');
    if (codeSortie !== 0) return resultat('fail');
    if (!acceptation) return resultat('pass');

    const {
      base,
      chemins,
      lancer,
      verifier = verifierAcceptation,
      produire = produirePreuves,
    } = acceptation;
    const verification = await verifier({ depot, base, chemins });
    if ((await lireTete(depot)) !== tete) return resultat('cannot_evaluate');
    fichiersAcceptation = [
      ...new Set(Object.values(verification.points).flatMap(({ fichiers }) => fichiers)),
    ];
    if (!verification.ok) return resultat('fail');

    const preuves = await produire({ depot, base, chemins, lancer }, delaiMs, env, signal);
    if (
      (await lireTete(depot)) !== tete ||
      !preuves.length ||
      preuves.some(({ preuve }) => preuve.head !== tete)
    ) {
      return resultat('cannot_evaluate');
    }
    if (preuves.some(({ preuve, fautes }) => preuve.outcome === 'fail' || fautes.length > 0)) {
      return resultat('fail');
    }
    return resultat(
      preuves.some(({ preuve }) => preuve.outcome === 'cannot_evaluate')
        ? 'cannot_evaluate'
        : 'pass',
    );
  }

  try {
    if (
      !/^[a-f0-9]{40}$/.test(tete) ||
      !commande.trim() ||
      !Number.isSafeInteger(journalMaxOctets) ||
      journalMaxOctets < 0 ||
      ![delaiMs, delaiAttenteMs, graceMs].every((delai) => delai > 0 && delai <= 2 ** 31 - 1)
    ) {
      return resultat('cannot_evaluate');
    }
    if (!(await attendreWorktree(depot, listerProcessus, delaiAttenteMs))) {
      return resultat('cannot_evaluate');
    }
    const temporaire = await mkdtemp(join(tmpdir(), 'aid-gate-'));
    try {
      return await evaluer(environnementGate(temporaire));
    } finally {
      await rm(temporaire, { recursive: true, force: true });
    }
  } catch {
    return resultat('cannot_evaluate');
  }
}

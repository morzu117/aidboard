import { resolveOnPath } from '../../daemon/pty/spawn.js';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Value } from '@sinclair/typebox/value';
import { parseDocument } from 'yaml';
import { ManifesteOutils, type OutilDeclare } from '../../shared/outils.js';
import { extraireVersion, lirePlageVersion } from '../../shared/plage-version.js';

interface ResultatOutil {
  nom: string;
  requis: boolean;
  attendu?: string;
  trouve?: string;
  etat: 'ok' | 'absent' | 'hors-plage' | 'illisible';
  detail?: string;
  indication?: string;
}

async function lireFichierFacultatif(fichier: string): Promise<string | undefined> {
  try {
    return await readFile(fichier, 'utf8');
  } catch (erreur) {
    if ((erreur as NodeJS.ErrnoException).code !== 'ENOENT') throw erreur;
  }
}

async function lireOutils(
  root: string,
): Promise<{ outils: [string, OutilDeclare][]; capacites?: unknown }> {
  const texte = await lireFichierFacultatif(join(root, 'agent.yml'));
  if (texte === undefined) return { outils: [['git', {}]] };
  const document = parseDocument(texte);
  if (document.errors.length) throw document.errors[0];
  if (document.contents === null) return { outils: [['git', {}]] };
  const manifeste: unknown = document.toJS();
  if (!Value.Check(ManifesteOutils, manifeste)) throw new Error('structure du manifeste invalide');
  const declarations = manifeste.outils;
  if (declarations === undefined) return { outils: [['git', {}]] };

  // Les clés numériques d'un objet JS sont réordonnées, contrairement aux clés d'une Map.
  const sections: Map<unknown, unknown> = document.toJS({ mapAsMap: true });
  const ordre = sections.get('outils') as Map<unknown, unknown>;
  const outils: [string, OutilDeclare][] = Array.from(ordre.keys(), (cle) => {
    const nom = String(cle);
    const outil = declarations[nom];
    if (!outil) throw new Error(`déclaration invalide : outils.${nom}`);
    return [nom, outil];
  });
  if (!Object.hasOwn(declarations, 'git')) outils.push(['git', { requis: true }]);
  return { outils, capacites: (manifeste as { capabilities?: unknown }).capabilities };
}

async function outilsMise(root: string): Promise<Set<string>> {
  const texte = await lireFichierFacultatif(join(root, 'mise.toml')).catch(() => undefined);
  const outils = new Set<string>();
  let dansOutils = false;
  for (const ligne of texte?.split(/\r?\n/) ?? []) {
    const contenu = ligne.trim();
    if (contenu.startsWith('[')) dansOutils = /^\[\s*tools\s*\]\s*(?:#.*)?$/.test(contenu);
    if (!dansOutils) continue;
    const cle = /^(?:"([a-z0-9._-]+)"|'([a-z0-9._-]+)'|([a-z0-9_-]+))\s*=/.exec(contenu);
    const nom = cle && (cle[1] ?? cle[2] ?? cle[3]);
    if (nom) outils.add(nom);
  }
  return outils;
}

function verifierOutil(
  root: string,
  nom: string,
  outil: OutilDeclare,
  conforme: (version: string) => boolean,
  mise: Set<string>,
  timeout: number,
): Promise<ResultatOutil> {
  const [commande = nom, ...args] = outil.verifier ?? [nom, '--version'];
  const base = { nom, requis: outil.requis ?? true, attendu: outil.version };
  return new Promise((resolve) => {
    execFile(
      commande,
      args,
      { cwd: root, timeout, killSignal: 'SIGKILL' },
      (erreur, stdout, stderr) => {
        const delai = erreur?.killed && erreur.signal === 'SIGKILL';
        if (delai || erreur?.code === 'ENOENT') {
          resolve({
            ...base,
            etat: 'absent',
            detail: delai ? 'délai dépassé' : undefined,
            indication: mise.has(nom) ? 'lancer `mise install`' : undefined,
          });
          return;
        }
        const trouve = extraireVersion(stdout, stderr);
        resolve({
          ...base,
          trouve,
          etat: trouve === undefined ? 'illisible' : conforme(trouve) ? 'ok' : 'hors-plage',
        });
      },
    );
  });
}

function verifierBoucle(outil: OutilDeclare, capacites: unknown): ResultatOutil {
  const { dev_agent, review_agent } = (capacites ?? {}) as {
    dev_agent?: string;
    review_agent?: string;
  };
  const chercher = (nom: string) => resolveOnPath(nom, process.env.PATH ?? '');
  const binaires = new Set([
    (dev_agent ?? 'claude').split('-')[0]!,
    (review_agent ?? (chercher('codex') ? 'codex' : 'claude')).split('-')[0]!,
  ]);
  const absents = [...binaires].filter(
    (nom) => !['claude', 'codex'].includes(nom) || !chercher(nom),
  );
  return {
    nom: 'boucle',
    requis: outil.requis ?? true,
    etat: absents.length ? 'absent' : 'ok',
    detail: absents.length ? `Introuvable dans le PATH : ${absents.join(', ')}` : undefined,
  };
}

function bloquant(outil: ResultatOutil): boolean {
  return outil.requis && (outil.etat === 'absent' || outil.etat === 'hors-plage');
}

function ligneOutil(outil: ResultatOutil): string {
  const symbole = outil.etat === 'ok' ? '✓' : bloquant(outil) ? '✗' : '!';
  const attendu = outil.attendu === undefined ? '' : ` (attendu ${outil.attendu})`;
  const etat = outil.etat === 'ok' ? '' : ` — ${outil.etat}`;
  const details = [outil.detail, outil.indication].filter(Boolean).map((info) => ` — ${info}`);
  return `${symbole} ${outil.nom}${outil.trouve ? ` ${outil.trouve}` : ''}${attendu}${etat}${details.join('')}`;
}

export async function runEnv(args: string[], timeout = 5000): Promise<number> {
  try {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        root: { type: 'string' },
        json: { type: 'boolean' },
      },
    });
    if (args[0] !== 'check') throw new Error('usage : aid env check [--root <dir>] [--json]');
    const root = resolve(values.root ?? '.');
    const { outils: profil, capacites } = await lireOutils(root);
    const verifications = profil.map(([nom, outil]) => {
      if (outil.verifier?.[0] === '') throw new Error(`agent.yml : outils.${nom}.verifier vide`);
      try {
        const conforme = outil.version === undefined ? () => true : lirePlageVersion(outil.version);
        return { nom, outil, conforme };
      } catch (erreur) {
        throw new Error(`agent.yml : outils.${nom}.version : ${(erreur as Error).message}`);
      }
    });
    const actifs = verifications.filter(
      ({ nom, outil }) => nom !== 'git' || outil.requis !== false,
    );
    const mise = await outilsMise(root);
    const personnalises = actifs.filter(({ outil }) => outil.verifier).map(({ nom }) => nom);
    if (!values.json && personnalises.length) {
      console.log(`commandes du manifeste : ${personnalises.join(', ')}`);
    }
    const outils = await Promise.all(
      actifs.map(({ nom, outil, conforme }) =>
        nom === 'boucle' && outil.verifier === undefined
          ? verifierBoucle(outil, capacites)
          : verifierOutil(root, nom, outil, conforme, mise, timeout),
      ),
    );
    const ok = !outils.some(bloquant);
    if (values.json) console.log(JSON.stringify({ root, ok, outils }));
    else for (const outil of outils) console.log(ligneOutil(outil));
    return ok ? 0 : 7;
  } catch (erreur) {
    console.error(`aid env : ${(erreur as Error).message}`);
    return 2;
  }
}

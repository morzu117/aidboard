import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Db } from '../db.js';
import { GIT_ENV } from '../git/exec.js';
import { gitLivraison } from '../git/inspect.js';
import { fichierSensible, filtrerDiff } from './filtreCode.js';

const MAX_OCTETS = 200 * 1024;
const MAX_LIGNES = 2000;

/** Lecture bornée, sans shell ni exécution des pilotes diff du dépôt. */
function lireDiff(worktree: string, base: string, tete: string, chemin: string) {
  return new Promise<{ etat: 'ok' | 'coupe'; lignes: string[] }>((resolve, reject) => {
    // Les attributs du worktree peuvent choisir un pilote, mais --no-textconv et
    // --no-ext-diff interdisent son exécution. Les attributs globaux sont ignorés.
    const enfant = spawn(
      'git',
      [
        '--literal-pathspecs',
        '-c',
        'core.attributesFile=/dev/null',
        '-c',
        'diff.external=',
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--no-renames',
        base,
        tete,
        '--',
        chemin,
      ],
      { cwd: worktree, env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let sortie = Buffer.alloc(0);
    let coupe = false;
    enfant.stdout.on('data', (bloc: Buffer) => {
      if (coupe) return;
      const taille = sortie.length + bloc.length;
      sortie = Buffer.concat([sortie, bloc.subarray(0, MAX_OCTETS + 1 - sortie.length)]);
      let lignes = 0;
      let fin = sortie.length;
      for (let i = 0; i < sortie.length; i++) {
        if (sortie[i] === 10 && ++lignes === MAX_LIGNES && i + 1 < sortie.length) {
          fin = i + 1;
          coupe = true;
          break;
        }
      }
      if (taille > MAX_OCTETS) coupe = true;
      sortie = sortie.subarray(0, Math.min(fin, MAX_OCTETS));
      if (coupe) {
        enfant.stdout.destroy();
        enfant.kill();
      }
    });
    enfant.on('error', () => reject(new Error('Diff indisponible')));
    enfant.on('close', (code) => {
      if (code !== 0 && !coupe) return reject(new Error('Diff indisponible'));
      const lignes = sortie.toString('utf8').split('\n');
      if (lignes.at(-1) === '') lignes.pop();
      resolve({ etat: coupe ? 'coupe' : 'ok', lignes: lignes.slice(0, MAX_LIGNES) });
    });
  });
}

export async function diffPourAppareil(db: Db, topicId: string, index: number, tete: string) {
  const sujet = db
    .prepare('SELECT worktree, base, branch FROM topics WHERE id = ?')
    .get(topicId) as { worktree: string; base: string; branch: string } | undefined;
  if (!sujet || !sujet.branch || !sujet.worktree || !existsSync(sujet.worktree))
    return { statut: 404, corps: { raison: 'fichier' } };
  // Même calcul, même ordre que livraisonPourAppareil ; aucun nom fourni par l'appareil.
  const livraison = await gitLivraison(sujet.worktree, sujet.base);
  if (tete.toLowerCase() !== livraison.head) return { statut: 409, corps: { raison: 'perimee' } };
  const fichier = livraison.files[index];
  if (!fichier || !livraison.mergeBase) return { statut: 404, corps: { raison: 'fichier' } };
  // --no-renames donne deux entrées ; un statut à deux chemins est aussi refusé
  // dès que l'un d'eux est sensible (séparateur du name-status git).
  if (fichier.path.split('\t').some(fichierSensible))
    return { statut: 200, corps: { etat: 'sensible' } };
  if (fichier.additions === null || fichier.deletions === null)
    return { statut: 200, corps: { etat: 'binaire' } };
  const diff = await lireDiff(sujet.worktree, livraison.mergeBase, livraison.head!, fichier.path);
  if (diff.lignes.some((ligne) => /^Binary files .* differ$/.test(ligne)))
    return { statut: 200, corps: { etat: 'binaire' } };
  return { statut: 200, corps: { etat: diff.etat, lignes: filtrerDiff(diff.lignes) } };
}

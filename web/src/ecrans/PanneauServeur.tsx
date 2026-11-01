import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  GitCommitDetail,
  GitLogCommit,
  ServerGitLog,
  ServerGitRepo,
  ServerGitStatus,
} from '../../../src/shared/git.js';
import type {
  ServerFilePreview,
  ServerFsEntry,
  ServerFsListing,
} from '../../../src/shared/model.js';
import { AidApiError } from '../data/api.js';
import {
  age,
  ecrireGit,
  lireCommit,
  lireDossier,
  lireEtatGit,
  lireFichier,
  lireJournalGit,
  sousChemin,
  type EcritureGit,
  type OngletPanneau,
  type PorteeGit,
} from '../data/panneauServeur.js';
import { useAidClient } from '../data/useAidState.js';
import { depuis } from '../ui/depuis.js';
import { layoutGraph } from '../ui/gitGraph.js';
import { CommitGraphe } from './OngletGit.js';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Voie 0 du graphe : la branche principale du dépôt du serveur, quel que soit son nom courant. */
const BRANCHES_PRINCIPALES = ['origin/main', 'main', 'origin/master', 'master'];

/** F.4 (§11.3.1) : ce que l'écran Discussion transmet à chaque onglet. */
interface Suivi {
  /** Change à chaque fin de groupe d'outils de l'agent. */
  actualisation: number;
  /** Dernières données gardées, âge en ambre, ↻ et écritures désactivés. */
  injoignable: boolean;
}

/** Les déclencheurs rapprochés (retour du serveur puis lien rétabli, rafale de groupes) ne font qu'une relecture. */
const ACTUALISATION_MS = 300;

/** Relit à chaque fin de groupe d'outils et au retour du serveur ; rien tant qu'il est injoignable, jamais en continu. */
function useActualisation(relire: () => void, { actualisation, injoignable }: Suivi): void {
  const relireRef = useRef(relire);
  useEffect(() => {
    relireRef.current = relire;
  });
  const vuRef = useRef({ actualisation, injoignable });
  useEffect(() => {
    const vu = vuRef.current;
    vuRef.current = { actualisation, injoignable };
    if (injoignable) return;
    if (vu.actualisation === actualisation && !vu.injoignable) return;
    const t = setTimeout(() => relireRef.current(), ACTUALISATION_MS);
    return () => clearTimeout(t);
  }, [actualisation, injoignable]);
}

/** L'âge affiché suit l'horloge sans relire le serveur. */
function useMaintenant(periodeMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), periodeMs);
    return () => clearInterval(t);
  }, [periodeMs]);
  return now;
}

function BarreChemin({
  serveur,
  dossier,
  readAt,
  chargement,
  onActualiser,
  injoignable = false,
}: {
  serveur: string;
  dossier: string;
  readAt: string | null;
  chargement: boolean;
  onActualiser: () => void;
  injoignable?: boolean;
}) {
  const now = useMaintenant();
  return (
    <div className="panneau-serveur-barre" data-node="discussion.panneau.barre">
      <span
        className="panneau-serveur-chemin"
        data-node="discussion.panneau.chemin"
        title={`${serveur}:${dossier}`}
      >
        {serveur}:{dossier}
      </span>
      <span
        className="panneau-serveur-age"
        data-node="discussion.panneau.age"
        data-ancien={injoignable || undefined}
        title={injoignable ? 'Serveur injoignable : dernières données lues' : undefined}
      >
        {readAt ? age(readAt, now) : chargement ? 'lecture…' : ''}
      </span>
      <button
        className="bouton bouton--fantome"
        data-node="discussion.panneau.actualiser"
        type="button"
        aria-label="Actualiser"
        title="Actualiser"
        onClick={onActualiser}
        disabled={chargement || injoignable}
      >
        ↻
      </button>
    </div>
  );
}

/** Une ligne de l'arbre (§11.3.1) : 30 px, 20 px par niveau ; chevron d'un dossier, `·` d'un fichier. */
export function FileTreeRow({
  entry,
  depth,
  open,
  onClick,
}: {
  entry: ServerFsEntry;
  depth: number;
  open: boolean;
  onClick: () => void;
}) {
  const dossier = entry.kind === 'dir';
  // masqué : jamais ouvert ni déplié (D78) ; « autre » (socket, périphérique…) : rien à montrer
  const inerte = entry.hidden || entry.kind === 'other';
  const classes = [
    'ligne-arbre',
    entry.heavy ? 'ligne-arbre--lourd' : '',
    entry.hidden ? 'ligne-arbre--masque' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={classes}
      style={{ paddingLeft: `calc(var(--sp-2) + ${depth * 20}px)` }}
      aria-expanded={dossier && !inerte ? open : undefined}
      aria-disabled={inerte || undefined}
      data-node="discussion.panneau.fichier"
      data-nom={entry.name}
      data-niveau={depth + 1}
      title={
        entry.hidden
          ? `${entry.name} : fichier sensible, contenu jamais lu`
          : entry.heavy
            ? `${entry.name} : dossier lourd, non déplié par défaut`
            : entry.symlink
              ? `${entry.name} (lien symbolique)`
              : entry.name
      }
      onClick={inerte ? undefined : onClick}
    >
      <span className="chevron" aria-hidden="true">
        {dossier ? (open ? '▾' : '▸') : '·'}
      </span>
      <span className="ligne-arbre-nom">
        {entry.name}
        {entry.symlink && <span className="ligne-arbre-lien"> ↗</span>}
      </span>
      {entry.hidden ? (
        <span className="ligne-arbre-badge ligne-arbre-badge--masque">masqué</span>
      ) : entry.git ? (
        <span
          className={`ligne-arbre-badge ligne-arbre-badge--${entry.git === 'M' ? 'modifie' : 'non-suivi'}`}
        >
          {entry.git}
        </span>
      ) : null}
    </button>
  );
}

/** Absent : pas encore lu. Une relecture (↻) garde l'ancienne lecture affichée jusqu'à la réponse. */
type Lecture = { listing: ServerFsListing } | { erreur: string };

function OngletFichiersServeur({
  serverId,
  serveur,
  racine,
  suivi = { actualisation: 0, injoignable: false },
}: {
  serverId: string;
  serveur: string;
  racine: string;
  suivi?: Suivi;
}) {
  const client = useAidClient();
  const [dossiers, setDossiers] = useState<Record<string, Lecture>>({});
  const [ouverts, setOuverts] = useState<Set<string>>(new Set());
  const [apercu, setApercu] = useState<{
    path: string;
    preview: ServerFilePreview | null;
    erreur: string | null;
  } | null>(null);
  const apercuRetourRef = useRef<HTMLButtonElement>(null);
  const apercuOuvert = apercu?.path ?? null;
  useEffect(() => {
    if (apercuOuvert) apercuRetourRef.current?.focus();
  }, [apercuOuvert]);

  // relectures d'un même dossier qui se croisent : seule la dernière partie fait foi
  const lecturesRef = useRef(new Map<string, number>());
  const charger = useCallback(
    (path: string) => {
      const n = (lecturesRef.current.get(path) ?? 0) + 1;
      lecturesRef.current.set(path, n);
      const derniere = () => lecturesRef.current.get(path) === n;
      lireDossier(client, serverId, path).then(
        (listing) => derniere() && setDossiers((d) => ({ ...d, [path]: { listing } })),
        (err: unknown) =>
          derniere() && setDossiers((d) => ({ ...d, [path]: { erreur: message(err) } })),
      );
    },
    [client, serverId],
  );

  useEffect(() => charger(racine), [charger, racine]);

  // ↻ : le dossier racine et chaque dossier déplié, jamais l'arbre entier
  const actualiser = () => {
    const visible = (path: string): boolean => {
      const parent = path.slice(0, path.lastIndexOf('/'));
      return (
        parent === racine ||
        parent.length <= racine.length ||
        (ouverts.has(parent) && visible(parent))
      );
    };
    for (const path of [racine, ...[...ouverts].filter(visible)]) charger(path);
  };

  const basculer = (path: string) => {
    const ouvrir = !ouverts.has(path);
    setOuverts((o) => {
      const n = new Set(o);
      if (ouvrir) n.add(path);
      else n.delete(path);
      return n;
    });
    const lu = dossiers[path];
    if (ouvrir && (!lu || 'erreur' in lu)) charger(path);
  };

  const ouvrirFichier = (path: string) => {
    setApercu({ path, preview: null, erreur: null });
    lireFichier(client, serverId, path).then(
      (preview) => setApercu((a) => (a?.path === path ? { path, preview, erreur: null } : a)),
      (err: unknown) =>
        setApercu((a) => (a?.path === path ? { path, preview: null, erreur: message(err) } : a)),
    );
  };

  const racineLue = dossiers[racine];
  const readAt = racineLue && 'listing' in racineLue ? racineLue.listing.readAt : null;

  const lignes = (path: string, depth: number): React.ReactNode => {
    const lu = dossiers[path];
    if (!lu)
      return (
        <p className="vide-arbre" style={{ paddingLeft: `${depth * 20 + 8}px` }}>
          Lecture…
        </p>
      );
    if ('erreur' in lu)
      return (
        <p
          className="message-erreur"
          role="alert"
          data-node="discussion.panneau.fichiers.erreur"
          style={{ paddingLeft: `${depth * 20 + 8}px` }}
        >
          {lu.erreur}
        </p>
      );
    return (
      <>
        {lu.listing.entries.length === 0 && (
          <p className="vide-arbre" style={{ paddingLeft: `${depth * 20 + 8}px` }}>
            Dossier vide.
          </p>
        )}
        {lu.listing.entries.map((e) => {
          const p = sousChemin(path, e.name);
          const open = ouverts.has(p);
          return (
            <div key={e.name}>
              <FileTreeRow
                entry={e}
                depth={depth}
                open={open}
                onClick={() => (e.kind === 'dir' ? basculer(p) : ouvrirFichier(p))}
              />
              {open && e.kind === 'dir' && lignes(p, depth + 1)}
            </div>
          );
        })}
        {lu.listing.truncated && (
          <p className="texte-discret" style={{ paddingLeft: `${depth * 20 + 8}px` }}>
            Liste tronquée : dossier trop grand pour être lu en entier.
          </p>
        )}
      </>
    );
  };

  // l'arbre aussi quand un aperçu est ouvert : l'agent a pu créer ou supprimer des fichiers ; l'aperçu reste affiché
  useActualisation(() => {
    actualiser();
    const path = apercu?.path;
    if (path)
      lireFichier(client, serverId, path).then(
        (preview) => setApercu((a) => (a?.path === path ? { path, preview, erreur: null } : a)),
        (err: unknown) =>
          setApercu((a) => (a?.path === path ? { path, preview: null, erreur: message(err) } : a)),
      );
  }, suivi);

  return (
    <>
      <BarreChemin
        serveur={serveur}
        dossier={apercu?.path ?? racine}
        injoignable={suivi.injoignable}
        readAt={apercu ? (apercu.preview?.readAt ?? null) : readAt}
        chargement={!racineLue}
        onActualiser={() => (apercu ? ouvrirFichier(apercu.path) : actualiser())}
      />
      {apercu ? (
        <div className="panneau-serveur-contenu" data-node="discussion.panneau.apercu">
          <div className="detail-entete">
            <button
              ref={apercuRetourRef}
              className="bouton"
              data-node="discussion.panneau.apercu.retour"
              type="button"
              onClick={() => setApercu(null)}
            >
              ← Retour
            </button>
          </div>
          {apercu.erreur ? (
            <p className="message-erreur" role="alert">
              {apercu.erreur}
            </p>
          ) : !apercu.preview ? (
            <div className="squelette">
              <span className="sq sq--grand-bloc" />
            </div>
          ) : apercu.preview.binary ? (
            <p className="texte-discret" data-node="discussion.panneau.apercu.binaire">
              Fichier binaire : non affiché.
            </p>
          ) : (
            <>
              {apercu.preview.truncated && (
                <p className="texte-discret" data-node="discussion.panneau.apercu.tronque">
                  Aperçu tronqué ({apercu.preview.size} octets au total).
                </p>
              )}
              <pre className="panneau-serveur-source" data-node="discussion.panneau.apercu.contenu">
                {apercu.preview.content}
              </pre>
            </>
          )}
        </div>
      ) : (
        <div
          className="panneau-serveur-contenu arbre"
          role="group"
          aria-label="Fichiers du serveur"
          data-node="discussion.panneau.arbre"
        >
          {lignes(racine, 0)}
        </div>
      )}
      <div className="panneau-pied legende" data-node="discussion.panneau.fichiers.legende">
        <span className="legende-element">
          <span className="ligne-arbre-badge ligne-arbre-badge--modifie">M</span> modifié
        </span>
        <span className="legende-element">
          <span className="ligne-arbre-badge ligne-arbre-badge--non-suivi">?</span> non suivi
        </span>
        <span className="legende-element">
          <span className="ligne-arbre-badge ligne-arbre-badge--masque">masqué</span> contenu jamais
          lu
        </span>
      </div>
    </>
  );
}

function positionTexte(repo: ServerGitRepo): string {
  if (!repo.origin) return 'pas de remote origin';
  if (!repo.aheadBehind) return 'position inconnue';
  const { ahead, behind } = repo.aheadBehind;
  const cible = repo.upstream ?? 'origin';
  if (repo.upstream === null) return `jamais poussée · ${ahead} à pousser`;
  if (ahead === 0 && behind === 0) return `à jour avec ${cible}`;
  return [ahead > 0 ? `↑ ${ahead} d’avance` : '', behind > 0 ? `↓ ${behind} de retard` : '']
    .filter(Boolean)
    .join(' · ')
    .concat(` sur ${cible}`);
}

const CONFIRMATIONS: Record<'push' | 'sync', { titre: string; commande: (b: string) => string }> = {
  push: { titre: 'Pousser', commande: (b) => `git push origin HEAD:refs/heads/${b}` },
  sync: {
    titre: 'Synchroniser',
    commande: (b) =>
      `git fetch origin && git rebase origin/${b} && git push origin HEAD:refs/heads/${b}`,
  },
};

function OngletGitServeur({
  serverId,
  serveur,
  racine,
  suivi = { actualisation: 0, injoignable: false },
}: {
  serverId: string;
  serveur: string;
  racine: string;
  suivi?: Suivi;
}) {
  const client = useAidClient();
  const [chemin, setChemin] = useState(racine);
  const [scope, setScope] = useState<PorteeGit>('all');
  const [journal, setJournal] = useState<ServerGitLog | null>(null);
  const [horsDepot, setHorsDepot] = useState<ServerGitStatus | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [enCours, setEnCours] = useState<EcritureGit | null>(null);
  const [actionErreur, setActionErreur] = useState<string | null>(null);
  const [aConfirmer, setAConfirmer] = useState<{ op: 'push' | 'sync'; repo: ServerGitRepo } | null>(
    null,
  );
  const [selection, setSelection] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [detailErreur, setDetailErreur] = useState<string | null>(null);
  const lectureRef = useRef(0);
  const selectionRef = useRef<string | null>(null);
  const annulerRef = useRef<HTMLButtonElement>(null);
  const detailRetourRef = useRef<HTMLButtonElement>(null);
  const carteOuverte = aConfirmer?.op ?? null;
  useEffect(() => {
    if (carteOuverte) annulerRef.current?.focus();
  }, [carteOuverte]);
  useEffect(() => {
    if (selection) detailRetourRef.current?.focus();
  }, [selection]);

  const lire = useCallback(() => {
    const n = ++lectureRef.current;
    lireJournalGit(client, serverId, chemin, scope)
      .then((j) => {
        if (n !== lectureRef.current) return;
        setJournal(j);
        setHorsDepot(null);
        setErreur(null);
        // HEAD a bougé depuis l'ouverture de la carte : elle décrivait un autre commit
        setAConfirmer((a) => (a && a.repo.head === j.repo.head ? a : null));
      })
      .catch(async (err: unknown) => {
        if (n !== lectureRef.current) return;
        // dossier non Git : l'état liste les dépôts détectés dans les dossiers autorisés
        if (err instanceof AidApiError && err.status === 409) {
          try {
            const st = await lireEtatGit(client, serverId, chemin);
            if (n !== lectureRef.current) return;
            if (st.repo === null) {
              setHorsDepot(st);
              setJournal(null);
              setErreur(null);
              return;
            }
          } catch {
            // l'erreur du journal reste la plus parlante
          }
        }
        if (n === lectureRef.current) setErreur(message(err));
      });
  }, [client, serverId, chemin, scope]);

  useEffect(() => lire(), [lire]);
  useActualisation(lire, suivi);
  const { injoignable } = suivi;

  const ecrire = async (op: EcritureGit, repo: ServerGitRepo | null) => {
    setAConfirmer(null);
    setActionErreur(null);
    setEnCours(op);
    try {
      await ecrireGit(
        client,
        serverId,
        op,
        op === 'fetch' ? { path: chemin } : { path: chemin, confirm: true, head: repo?.head ?? '' },
      );
    } catch (err) {
      setActionErreur(message(err));
    } finally {
      setEnCours(null);
      lire();
    }
  };

  // autre dépôt : rien de l'ancien (détail, carte, erreur d'action) ne reste affiché
  const changerDepot = (path: string) => {
    selectionRef.current = null;
    setSelection(null);
    setDetail(null);
    setDetailErreur(null);
    setAConfirmer(null);
    setActionErreur(null);
    setJournal(null);
    setHorsDepot(null);
    setErreur(null);
    setChemin(path);
  };

  const selectionner = (hash: string) => {
    setSelection(hash);
    setDetail(null);
    setDetailErreur(null);
    selectionRef.current = hash;
    lireCommit(client, serverId, chemin, hash).then(
      (d) => {
        if (selectionRef.current === hash) setDetail(d);
      },
      (err: unknown) => {
        if (selectionRef.current === hash) setDetailErreur(message(err));
      },
    );
  };

  // `git log` décore `HEAD -> <branche>` : le graphe attend `HEAD` seul pour placer le nœud courant et la ligne WIP
  const commits = useMemo(
    () =>
      (journal?.commits ?? []).map((c) => ({
        ...c,
        refs: c.refs.flatMap((r) => (r.startsWith('HEAD -> ') ? ['HEAD', r.slice(8)] : [r])),
      })),
    [journal],
  );
  const rows = useMemo(
    () =>
      journal
        ? layoutGraph(commits, {
            baseRefs: BRANCHES_PRINCIPALES,
            dirty: journal.dirty,
            rowHeight: 46,
            nodeY: 23,
          })
        : [],
    [journal, commits],
  );
  const parHash = useMemo(
    () => new Map<string, GitLogCommit>(commits.map((c) => [c.hash, c])),
    [commits],
  );

  const chargement = !journal && !horsDepot && !erreur;
  const barre = (
    <BarreChemin
      serveur={serveur}
      dossier={journal?.repo.root ?? chemin}
      injoignable={injoignable}
      readAt={journal?.readAt ?? horsDepot?.readAt ?? null}
      chargement={chargement}
      onActualiser={lire}
    />
  );

  if (erreur)
    return (
      <>
        {barre}
        <div className="panneau-serveur-contenu">
          <p className="message-erreur" role="alert" data-node="discussion.panneau.git.erreur">
            {erreur}
          </p>
          {chemin !== racine && (
            <button
              className="bouton"
              data-node="discussion.panneau.git.racine"
              type="button"
              onClick={() => changerDepot(racine)}
            >
              ← Dossier de la discussion
            </button>
          )}
        </div>
      </>
    );

  if (horsDepot)
    return (
      <>
        {barre}
        <div className="panneau-serveur-contenu" data-node="discussion.panneau.git.hors-depot">
          <p className="vide-message">Ce dossier n’est pas un dépôt Git.</p>
          {horsDepot.repos.length > 0 ? (
            <>
              <p className="texte-discret">Dépôts trouvés dans les dossiers autorisés :</p>
              <div className="panneau-serveur-depots" role="group" aria-label="Dépôts détectés">
                {horsDepot.repos.map((r) => (
                  <button
                    key={r}
                    className="bouton panneau-serveur-depot"
                    data-node="discussion.panneau.git.depot"
                    type="button"
                    onClick={() => changerDepot(r)}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="texte-discret">Aucun dépôt trouvé dans les dossiers autorisés.</p>
          )}
        </div>
      </>
    );

  if (!journal)
    return (
      <>
        {barre}
        <div className="squelette" data-node="discussion.panneau.git.chargement">
          <span className="sq sq--grand-bloc" />
        </div>
      </>
    );

  const repo = journal.repo;
  const ahead = repo.aheadBehind?.ahead ?? 0;
  const occupe = enCours !== null;
  // le daemon refuse aussi chacun de ces cas ; désactivé ici pour ne pas proposer une carte vouée au refus
  const poussable =
    !occupe && !injoignable && ahead > 0 && !!repo.branch && !!repo.head && repo.operation === null;
  const situation = (
    <section className="situation" data-node="discussion.panneau.git.situation">
      <div className="situation-texte">
        <div className="stats">
          <span className="stat panneau-serveur-branche" data-node="discussion.panneau.git.branche">
            {repo.branch ?? 'HEAD détachée'}
          </span>
          <span className="stat" data-node="discussion.panneau.git.modifies">
            {repo.changes === null
              ? 'modifiés : inconnu'
              : `${repo.changes} modifié${repo.changes > 1 ? 's' : ''}`}
          </span>
          <span className="stat" data-node="discussion.panneau.git.position">
            {positionTexte(repo)}
          </span>
          {repo.operation && (
            <span className="stat stat--retard" data-node="discussion.panneau.git.operation">
              {repo.operation} en cours
            </span>
          )}
        </div>
        {actionErreur && (
          <p
            className="message-erreur"
            role="alert"
            data-node="discussion.panneau.git.action-erreur"
          >
            {actionErreur}
          </p>
        )}
      </div>
      <div className="actions">
        <button
          className="bouton bouton--contour"
          data-node="discussion.panneau.git.synchroniser"
          type="button"
          disabled={!poussable || repo.upstream === null}
          onClick={() => setAConfirmer({ op: 'sync', repo })}
        >
          {enCours === 'sync' ? 'Synchronisation…' : 'Synchroniser'}
        </button>
        <button
          className="bouton bouton--primaire"
          data-node="discussion.panneau.git.pousser"
          type="button"
          disabled={!poussable}
          onClick={() => setAConfirmer({ op: 'push', repo })}
        >
          {enCours === 'push'
            ? 'Poussée…'
            : `Pousser${ahead > 0 ? ` ${ahead} commit${ahead > 1 ? 's' : ''}` : ''}`}
        </button>
        <button
          className="bouton"
          data-node="discussion.panneau.git.fetch"
          type="button"
          disabled={occupe || injoignable || !repo.origin}
          onClick={() => void ecrire('fetch', repo)}
        >
          {enCours === 'fetch' ? 'Fetch…' : 'Fetch'}
        </button>
      </div>
      {aConfirmer && (
        <div
          className="confirm-carte"
          data-node="discussion.panneau.git.confirmation"
          role="group"
          aria-label="Confirmation requise"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setAConfirmer(null);
          }}
        >
          <p className="confirm-titre">
            <span className="confirm-point" aria-hidden="true" />
            Confirmation requise · {serveur}
          </p>
          <pre className="confirm-commande">
            {CONFIRMATIONS[aConfirmer.op].commande(aConfirmer.repo.branch ?? '')}
          </pre>
          <p className="texte-discret" data-node="discussion.panneau.git.confirmation.effet">
            {aConfirmer.op === 'push'
              ? `Modifie le dépôt distant : ${ahead} commit${ahead > 1 ? 's' : ''} jusqu’à ${aConfirmer.repo.head?.slice(0, 7)}.`
              : `Réécrit les ${ahead > 1 ? `${ahead} commits locaux` : 'commit local'} sur ${aConfirmer.repo.upstream} (nouveaux hashs), puis les pousse. Refusé si ${aConfirmer.repo.head?.slice(0, 7)} n’est plus la tête de la branche.`}
          </p>
          <div className="confirm-options">
            <button
              className="bouton bouton--primaire confirm-option"
              data-node="discussion.panneau.git.confirmation.valider"
              type="button"
              disabled={injoignable}
              onClick={() => void ecrire(aConfirmer.op, aConfirmer.repo)}
            >
              {CONFIRMATIONS[aConfirmer.op].titre}
            </button>
            <button
              ref={annulerRef}
              className="bouton confirm-option"
              data-node="discussion.panneau.git.confirmation.annuler"
              type="button"
              onClick={() => setAConfirmer(null)}
            >
              Annuler
            </button>
          </div>
        </div>
      )}
    </section>
  );

  if (selection)
    return (
      <>
        {barre}
        {situation}
        <div
          className="panneau-serveur-contenu"
          data-node="discussion.panneau.git.detail"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setSelection(null);
          }}
        >
          <div className="detail-entete">
            <button
              ref={detailRetourRef}
              className="bouton"
              data-node="discussion.panneau.git.detail.retour"
              type="button"
              onClick={() => setSelection(null)}
            >
              ← Retour
            </button>
          </div>
          {detailErreur ? (
            <p className="message-erreur" role="alert">
              {detailErreur}
            </p>
          ) : !detail ? (
            <div className="squelette">
              <span className="sq sq--grand-bloc" />
            </div>
          ) : (
            <div className="detail" data-node="discussion.panneau.git.detail.corps">
              <div className="refs">
                {detail.refs.map((r) => (
                  <span key={r} className="etiquette etiquette--ref">
                    {r}
                  </span>
                ))}
              </div>
              <h3 className="detail-titre" data-node="discussion.panneau.git.detail.message">
                {detail.message}
              </h3>
              {detail.body && <p className="texte-discret">{detail.body}</p>}
              <dl className="infos">
                <dt>Auteur</dt>
                <dd>{detail.author}</dd>
                <dt>Date</dt>
                <dd>{new Date(detail.date).toLocaleString('fr-FR')}</dd>
                <dt>Hash</dt>
                <dd className="chiffres">{detail.hash.slice(0, 12)}</dd>
                <dt>Dans la branche</dt>
                <dd>{detail.inHead ? 'oui' : 'non'}</dd>
              </dl>
              <div className="separation">
                <div className="separation-titre">
                  <span>Fichiers</span>
                  <span className="chiffres">
                    {detail.files.length} fichier{detail.files.length > 1 ? 's' : ''}
                  </span>
                </div>
                <div className="fichiers">
                  {detail.files.map((f) => (
                    <div
                      key={f.path}
                      className="fichier"
                      data-node="discussion.panneau.git.detail.fichier"
                    >
                      <span className={`fichier-etat fichier-etat--${f.status.toLowerCase()}`}>
                        {f.status}
                      </span>
                      <span className="fichier-chemin">{f.path}</span>
                      <span className="ajouts">{f.additions != null ? `+${f.additions}` : ''}</span>
                      <span className="suppressions">
                        {f.deletions != null ? `−${f.deletions}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </>
    );

  return (
    <>
      {barre}
      {situation}
      <div className="outils outils-git">
        <div className="git-portees" role="group" aria-label="Branches affichées">
          {(
            [
              ['all', 'Toutes'],
              ['branch', 'Branche seule'],
            ] as const
          ).map(([valeur, label]) => (
            <button
              key={valeur}
              className={`portee${scope === valeur ? ' est-actif' : ''}`}
              data-node={`discussion.panneau.git.portee-${valeur}`}
              type="button"
              aria-pressed={scope === valeur}
              onClick={() => setScope(valeur)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="vide-message" data-node="discussion.panneau.git.vide">
          Aucun commit dans ce dépôt.
        </p>
      ) : (
        <div className="commits panneau-serveur-contenu" role="group" aria-label="Commits">
          {rows.map((row) => {
            const c = row.wip ? null : (parHash.get(row.hash) ?? null);
            return (
              <button
                key={row.hash || 'wip'}
                className={`commit${row.absent ? ' commit--absent' : ''}`}
                data-node={`discussion.panneau.git.commit-${row.hash || 'wip'}`}
                type="button"
                onClick={row.wip ? undefined : () => selectionner(row.hash)}
                disabled={row.wip}
              >
                <CommitGraphe row={row} />
                <span className="commit-corps">
                  <span className="commit-ligne1">
                    {row.wip ? (
                      <span className="message message--wip">Modifications non commitées</span>
                    ) : (
                      <>
                        {c?.refs.map((r) => (
                          <span key={r} className="etiquette etiquette--ref">
                            {r}
                          </span>
                        ))}
                        <span className="message">{c?.message}</span>
                      </>
                    )}
                  </span>
                  <span className="commit-ligne2">
                    <span className="commit-meta">
                      {row.wip ? 'maintenant' : `${c?.author} · ${c ? depuis(c.date) : ''}`}
                    </span>
                    {!row.wip && <span className="commit-hash">{row.hash.slice(0, 7)}</span>}
                  </span>
                </span>
              </button>
            );
          })}
          {journal.truncated && (
            <p className="texte-discret">Historique plus long : seuls les plus récents sont lus.</p>
          )}
        </div>
      )}
      <div className="panneau-pied legende" data-node="discussion.panneau.git.legende">
        <span className="legende-element">
          <span className="point point--voie-0" /> branche principale
        </span>
        <span className="legende-element">
          <span className="point point--voie-1" /> branche courante
        </span>
        <span className="legende-element">
          <span className="point point--voie-2" /> autres branches
        </span>
        <span className="legende-element">Atténués : absents de la branche courante</span>
      </div>
    </>
  );
}

const ONGLETS: Array<{ id: OngletPanneau; label: string }> = [
  { id: 'files', label: 'Fichiers' },
  { id: 'git', label: 'Git' },
];

/**
 * Chantier 17 (F.3, §11.3.1) : panneau Fichiers / Git de l'écran Discussion, 360 px, à droite du fil. Lecture
 * seule hors fetch / pousser / synchroniser ; tout passe par le daemon, dans les dossiers autorisés du serveur.
 */
export function PanneauServeur({
  serverId,
  serveur,
  racine,
  onglet,
  onOnglet,
  onFermer,
  actualisation = 0,
  injoignable = false,
}: {
  serverId: string;
  serveur: string;
  /** Dossier de départ : le répertoire de la discussion. */
  racine: string;
  onglet: OngletPanneau;
  onOnglet: (o: OngletPanneau) => void;
  onFermer: () => void;
  /** F.4 : incrémenté à chaque fin de groupe d'outils de l'agent. */
  actualisation?: number;
  injoignable?: boolean;
}) {
  const suivi = useMemo(() => ({ actualisation, injoignable }), [actualisation, injoignable]);
  return (
    <aside
      className="panneau-serveur panneau-contexte"
      data-node="discussion.panneau"
      aria-label="Panneau du serveur"
    >
      <div className="panneau-serveur-entete">
        <div className="panneau-serveur-onglets" role="group" aria-label="Onglets du panneau">
          {ONGLETS.map((o) => (
            <button
              key={o.id}
              className={`onglet${onglet === o.id ? ' est-actif' : ''}`}
              data-node={`discussion.panneau.onglet-${o.id}`}
              type="button"
              aria-pressed={onglet === o.id}
              onClick={() => onOnglet(o.id)}
            >
              {o.label}
            </button>
          ))}
        </div>
        <button
          className="bouton bouton--fantome"
          data-node="discussion.panneau.fermer"
          type="button"
          aria-label="Fermer le panneau"
          onClick={onFermer}
        >
          ×
        </button>
      </div>
      {onglet === 'files' ? (
        <OngletFichiersServeur
          key={`${serverId}:${racine}`}
          serverId={serverId}
          serveur={serveur}
          racine={racine}
          suivi={suivi}
        />
      ) : (
        <OngletGitServeur
          key={`${serverId}:${racine}`}
          serverId={serverId}
          serveur={serveur}
          racine={racine}
          suivi={suivi}
        />
      )}
    </aside>
  );
}

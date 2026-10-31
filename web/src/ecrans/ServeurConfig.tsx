import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { PermissionMode } from '../../../src/shared/agentSettings.js';
import type {
  Server,
  ServerMode,
  ServerStatus,
  ServerTest,
  ServerTestStep,
} from '../../../src/shared/model.js';
import { statutInconnu, useServeurs } from '../data/serveurs.js';
import { useAid, useAidClient } from '../data/useAidState.js';
import { Dialogue } from '../dialogues/Dialogue.js';
import { Layout } from '../ui/Layout.js';
import { ETAT_SERVEUR, IconeServeur } from '../ui/Serveur.js';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Palette des groupes de la barre gauche (même ordre que `Nav.tsx` et `routes/nav.ts`). */
const COULEURS: readonly { nom: string; valeur: string }[] = [
  { nom: 'Menthe', valeur: '#5de0a1' },
  { nom: 'Violet', valeur: '#a78bfa' },
  { nom: 'Orange', valeur: '#f59e6b' },
  { nom: 'Bleu', valeur: '#6ea8ff' },
  { nom: 'Rose', valeur: '#f07ab0' },
  { nom: 'Ambre', valeur: '#f2b84b' },
  { nom: 'Turquoise', valeur: '#4fd1d9' },
  { nom: 'Gris', valeur: '#8d94a0' },
];

/** Ordre de la maquette ServerConfig. */
const MODES: readonly { id: ServerMode; label: string }[] = [
  { id: 'command', label: 'Commande locale' },
  { id: 'ssh_host', label: 'Hôte SSH' },
  { id: 'ssh_alias', label: 'Alias SSH' },
];

/** Valeurs réelles du daemon (`SERVER_PERMISSION_MODES`), libellés du sélecteur de mode du composer. */
const PERMISSIONS: readonly { id: PermissionMode; label: string }[] = [
  { id: 'default', label: 'Demander avant d’exécuter' },
  { id: 'acceptEdits', label: 'Modifications de fichiers automatiques' },
  { id: 'auto', label: 'Automatique' },
  { id: 'plan', label: 'Plan (lecture seule)' },
];

const AGENTS_CONNUS = ['claude', 'codex', 'cursor'] as const;

interface Brouillon {
  name: string;
  groupName: string;
  color: string;
  mode: ServerMode;
  /** §11.2 : changer de mode garde la saisie de chacun en mémoire pour le retour */
  targets: Record<ServerMode, string>;
  port: string;
  user: string;
  identityFile: string;
  jump: string;
  loadProfile: boolean;
  workdir: string;
  shell: string;
  keepSession: boolean;
  permissionMode: PermissionMode;
  confirmDestructive: boolean;
  allowedDirs: string[];
}

const NEUF: Brouillon = {
  name: '',
  groupName: 'Serveurs',
  color: COULEURS[0]!.valeur,
  mode: 'ssh_alias',
  targets: { ssh_alias: '', ssh_host: '', command: '' },
  port: '',
  user: '',
  identityFile: '',
  jump: '',
  loadProfile: true,
  workdir: '~',
  shell: 'bash',
  keepSession: true,
  permissionMode: 'default',
  confirmDestructive: true,
  allowedDirs: ['~'],
};

function depuisServeur(s: Server): Brouillon {
  return {
    name: s.name,
    groupName: s.groupName,
    color: s.color,
    mode: s.mode,
    targets: { ...NEUF.targets, [s.mode]: s.target },
    port: s.sshOptions?.port != null ? String(s.sshOptions.port) : '',
    user: s.sshOptions?.user ?? '',
    identityFile: s.sshOptions?.identityFile ?? '',
    jump: s.sshOptions?.jump ?? '',
    loadProfile: s.loadProfile,
    workdir: s.workdir,
    shell: s.shell,
    keepSession: s.keepSession,
    permissionMode: s.permissionMode,
    confirmDestructive: s.confirmDestructive,
    allowedDirs: [...s.allowedDirs],
  };
}

const vide = (v: string) => (v.trim() === '' ? null : v.trim());

/** Ce qui part au daemon : seule la cible du mode choisi, options ssh seulement en Hôte SSH. */
function corps(b: Brouillon) {
  return {
    name: b.name.trim(),
    groupName: b.groupName.trim() || 'Serveurs',
    color: b.color,
    mode: b.mode,
    target: b.targets[b.mode].trim(),
    sshOptions:
      b.mode === 'ssh_host'
        ? {
            port: b.port.trim() === '' ? null : Number(b.port),
            user: vide(b.user),
            identityFile: vide(b.identityFile),
            jump: vide(b.jump),
          }
        : null,
    loadProfile: b.loadProfile,
    workdir: b.workdir.trim(),
    shell: b.shell.trim(),
    keepSession: b.keepSession,
    permissionMode: b.permissionMode,
    confirmDestructive: b.confirmDestructive,
    allowedDirs: b.allowedDirs,
  };
}

/** Contrôles qu'on peut faire sans le daemon ; le reste (jeux de caractères, unicité) revient en 400. */
function invalide(b: Brouillon): string | null {
  if (!b.name.trim()) return 'Le nom affiché est obligatoire.';
  if (!b.targets[b.mode].trim())
    return b.mode === 'command'
      ? 'La commande de connexion est obligatoire.'
      : b.mode === 'ssh_host'
        ? 'L’hôte est obligatoire.'
        : 'L’alias est obligatoire.';
  if (b.mode === 'ssh_host' && b.port.trim() !== '') {
    const p = /^\d{1,5}$/.test(b.port.trim()) ? Number(b.port) : NaN;
    if (!(p >= 1 && p <= 65535)) return 'Le port doit être entre 1 et 65535.';
  }
  if (!b.workdir.trim()) return 'Le répertoire de travail est obligatoire.';
  if (!b.shell.trim()) return 'Le shell distant est obligatoire.';
  return null;
}

/** Ce qui compare deux brouillons : le corps envoyé, plus la saisie brute du port (« abc » n'est pas « »). */
const signature = (b: Brouillon) => JSON.stringify([corps(b), b.mode === 'ssh_host' ? b.port : '']);

/** Le plus récent de deux comptes rendus d'un même serveur ; à départ égal, celui qui est fini. */
function plusRecent(a: ServerTest | null, b: ServerTest | null): ServerTest | null {
  if (!a || !b) return a ?? b;
  if (a.startedAt !== b.startedAt) return a.startedAt > b.startedAt ? a : b;
  return a.finishedAt ? a : b;
}

/** Lu par un lecteur d'écran à la place du symbole (review S.5). */
const ETAT_ETAPE: Record<ServerTestStep['state'], string> = {
  pending: 'en attente',
  running: 'en cours',
  ok: 'réussi',
  failed: 'échoué',
  skipped: 'sauté',
};

const SYMBOLE: Record<ServerTestStep['state'], string> = {
  pending: '·',
  running: '…',
  ok: '✓',
  failed: '✗',
  skipped: '–',
};

function Etapes({ test }: { test: ServerTest }) {
  return (
    <>
      <ol className="serveur-test-etapes" data-node="serveur-config.test.etapes">
        {test.steps.map((e) => (
          <li
            key={e.id}
            className={`serveur-test-etape serveur-test-etape--${e.state}`}
            data-node={`serveur-config.test.${e.id}`}
            data-etat={e.state}
          >
            <span className="serveur-test-symbole" aria-hidden="true">
              {SYMBOLE[e.state]}
            </span>
            <span className="serveur-test-libelle">
              {e.label}
              <span className="visuellement-cache"> : {ETAT_ETAPE[e.state]}</span>
              {e.detail && <span className="serveur-test-detail"> · {e.detail}</span>}
            </span>
          </li>
        ))}
      </ol>
      {test.finishedAt && (
        <p
          className={`serveur-test-conclusion${test.ok ? ' serveur-test-conclusion--ok' : ''}`}
          data-node="serveur-config.test.conclusion"
        >
          {test.ok ? 'Connecté' : (test.error ?? 'Échec du test')}
        </p>
      )}
      {test.raw && (
        <details className="serveur-test-brut">
          <summary>Sortie brute</summary>
          <pre data-node="serveur-config.test.brut">{test.raw}</pre>
        </details>
      )}
    </>
  );
}

function Formulaire({
  server,
  avis,
  onEnregistre,
}: {
  server: Server | null;
  /** message survivant au remontage qui suit un enregistrement (lancement du test en échec) */
  avis: string | null;
  onEnregistre: (serverId: string, avis: string | null) => void;
}) {
  const { call } = useAid();
  const client = useAidClient();
  const { statuses, tests, store } = useServeurs();
  const navigate = useNavigate();
  const initial = server ? depuisServeur(server) : NEUF;
  const [b, setB] = useState<Brouillon>(initial);
  const [dossier, setDossier] = useState('');
  const [erreur, setErreur] = useState<string | null>(avis);
  const [enCours, setEnCours] = useState(false);
  const [lancement, setLancement] = useState(false);
  // garde synchrone : deux clics dans le même rendu ne partent pas deux fois (review S.5)
  const occupe = useRef(false);
  const [quitter, setQuitter] = useState(false);
  const [suppression, setSuppression] = useState(false);
  const [testLu, setTestLu] = useState<ServerTest | null>(null);
  const id = server?.id ?? null;

  // dernier test connu du daemon (avant l'ouverture de l'interface) ; 404 = jamais testé
  useEffect(() => {
    if (!id) return;
    let actif = true;
    client
      .request<ServerTest>('GET', `/api/servers/${id}/test`)
      .then((t) => actif && setTestLu(t))
      .catch(() => {});
    return () => {
      actif = false;
    };
  }, [client, id]);

  // un dossier tapé mais pas encore ajouté compte : il part à l'enregistrement (review S.5)
  const enAttente = dossier.trim();
  const final =
    enAttente && !b.allowedDirs.includes(enAttente)
      ? { ...b, allowedDirs: [...b.allowedDirs, enAttente] }
      : b;
  const modifie = signature(final) !== signature(initial);
  const probleme = invalide(final);
  const test = plusRecent(id ? (tests[id] ?? null) : null, testLu);
  const testEnCours = lancement || (test !== null && test.finishedAt === null);

  // un test vu « en cours » se relit toutes les 3 s : sa fin n'est pas perdue si la socket a coupé
  useEffect(() => {
    if (!id || !test || test.finishedAt !== null) return;
    const t = setInterval(() => {
      client
        .request<ServerTest>('GET', `/api/servers/${id}/test`)
        .then(setTestLu)
        .catch(() => {});
    }, 3_000);
    return () => clearInterval(t);
  }, [client, id, test]);

  const status: ServerStatus = id ? (statuses[id] ?? statutInconnu(id)) : statutInconnu('');
  const maj = (patch: Partial<Brouillon>) => {
    setErreur(null);
    setB((cur) => ({ ...cur, ...patch }));
  };
  const cible = (v: string) => {
    setErreur(null);
    setB((cur) => ({ ...cur, targets: { ...cur.targets, [cur.mode]: v } }));
  };

  /** Lance le test ; rend le message d'échec plutôt que de l'afficher (le formulaire peut être remonté). */
  const tester = async (serverId: string): Promise<string | null> => {
    setLancement(true);
    try {
      setTestLu(await call<ServerTest>('POST', `/api/servers/${serverId}/test`));
      return null;
    } catch (err) {
      return `Test de connexion non lancé : ${message(err)}`;
    } finally {
      setLancement(false);
    }
  };

  const enregistrer = async () => {
    if (probleme || !modifie || occupe.current) return;
    occupe.current = true;
    setErreur(null);
    setEnCours(true);
    let s: Server;
    try {
      s = id
        ? await call<Server>('PATCH', `/api/servers/${id}`, corps(final))
        : await call<Server>('POST', '/api/servers', corps(final));
    } catch (err) {
      setErreur(message(err));
      setEnCours(false);
      occupe.current = false;
      return;
    }
    // enregistré : la suite peut échouer sans rien défaire (pas de doublon à la création, review S.5)
    await store.recharger().catch(() => {});
    // §11.2 : le test est lancé automatiquement à l'enregistrement
    onEnregistre(s.id, await tester(s.id));
  };

  const lancerTest = async () => {
    if (!id || occupe.current) return;
    occupe.current = true;
    const echec = await tester(id);
    occupe.current = false;
    if (echec) setErreur(echec);
  };

  const annuler = () => (modifie ? setQuitter(true) : navigate('/serveurs'));

  const supprimer = async () => {
    if (!id || occupe.current) return;
    occupe.current = true;
    setEnCours(true);
    try {
      await call('DELETE', `/api/servers/${id}`);
      // quitter d'abord : retiré du store, le serveur rendrait « introuvable » un instant
      navigate('/serveurs');
      store.retirer(id);
    } catch (err) {
      setErreur(message(err));
      setSuppression(false);
    } finally {
      occupe.current = false;
      setEnCours(false);
    }
  };

  const revoquer = async (ruleId: string) => {
    if (!id) return;
    try {
      await call('DELETE', `/api/servers/${id}/rules/${ruleId}`);
      await store.recharger();
    } catch (err) {
      setErreur(message(err));
    }
  };

  const ajouterDossier = () => {
    const d = dossier.trim();
    if (!d) return;
    if (!b.allowedDirs.includes(d)) maj({ allowedDirs: [...b.allowedDirs, d] });
    setDossier('');
  };

  const titre = server ? `Configurer ${server.name}` : 'Ajouter un serveur';
  const detectes = server?.detectedAgents ?? null;

  return (
    <main className="serveur-config" data-node="serveur-config">
      <div className="serveur-config-entete" data-node="serveur-config.entete">
        <div className="serveur-config-titres">
          <nav className="texte-faible" aria-label="Fil d’Ariane">
            <Link
              to="/serveurs"
              onClick={(e) => {
                if (!modifie) return;
                e.preventDefault();
                setQuitter(true);
              }}
            >
              Serveurs
            </Link>{' '}
            / <span aria-current="page">{server?.name ?? 'nouveau'}</span>
          </nav>
          <h1 className="titre-ecran" data-node="serveur-config.titre">
            {titre}
          </h1>
        </div>
        <button
          className="bouton"
          data-node="serveur-config.annuler"
          type="button"
          onClick={annuler}
        >
          Annuler
        </button>
        <button
          className="bouton bouton--primaire"
          data-node="serveur-config.enregistrer"
          type="submit"
          form="serveur-config-formulaire"
          disabled={!modifie || probleme !== null || enCours}
          aria-describedby={modifie && probleme ? 'serveur-config-probleme' : undefined}
        >
          Enregistrer
        </button>
        {/* dans l'en-tête fixe : visibles quel que soit le défilement (review S.5) */}
        {erreur && (
          <p className="message-erreur" role="alert" data-node="serveur-config.erreur">
            {erreur}
          </p>
        )}
        {!erreur && modifie && probleme && (
          <p
            className="serveur-config-probleme"
            id="serveur-config-probleme"
            aria-live="polite"
            data-node="serveur-config.erreur"
          >
            {probleme}
          </p>
        )}
      </div>
      <div className="serveur-config-corps">
        <form
          id="serveur-config-formulaire"
          className="serveur-config-formulaire"
          aria-label={titre}
          onSubmit={(e) => {
            e.preventDefault();
            void enregistrer();
          }}
        >
          <section className="serveur-bloc" aria-labelledby="bloc-identite">
            <h2 className="titre-zone" id="bloc-identite">
              Identité
            </h2>
            <div className="serveur-champs">
              <label className="serveur-champ">
                Nom affiché
                <input
                  className="champ"
                  data-node="serveur-config.nom"
                  value={b.name}
                  aria-required="true"
                  onChange={(e) => maj({ name: e.target.value })}
                />
              </label>
              <label className="serveur-champ">
                Groupe dans la barre gauche
                <input
                  className="champ"
                  data-node="serveur-config.groupe"
                  value={b.groupName}
                  onChange={(e) => maj({ groupName: e.target.value })}
                />
              </label>
            </div>
            <div className="serveur-couleurs" role="group" aria-label="Couleur">
              <span className="serveur-champ-titre">Couleur</span>
              {COULEURS.map((c) => (
                <button
                  key={c.valeur}
                  type="button"
                  aria-pressed={b.color === c.valeur}
                  aria-label={c.nom}
                  className="serveur-couleur"
                  style={{ background: c.valeur }}
                  onClick={() => maj({ color: c.valeur })}
                />
              ))}
            </div>
          </section>

          <section className="serveur-bloc" aria-labelledby="bloc-connexion">
            <h2 className="titre-zone" id="bloc-connexion">
              Connexion
            </h2>
            <div className="serveur-segments" role="group" aria-label="Mode de connexion">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="serveur-segment"
                  data-node={`serveur-config.mode-${m.id}`}
                  aria-pressed={b.mode === m.id}
                  onClick={() => maj({ mode: m.id })}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {b.mode === 'command' && (
              <>
                <label className="serveur-champ">
                  Commande de connexion
                  <input
                    className="champ serveur-mono"
                    data-node="serveur-config.cible"
                    value={b.targets.command}
                    placeholder="ssh vps"
                    onChange={(e) => cible(e.target.value)}
                  />
                </label>
                <p className="texte-discret">
                  Le daemon local exécute cette commande sur ton ordinateur ; elle doit ouvrir un
                  shell sur le serveur et accepter la commande distante en argument. A-I-D ne stocke
                  ni mot de passe ni clé privée : n’écris aucun secret dans cette commande.
                </p>
                <label className="case">
                  <input
                    type="checkbox"
                    checked={b.loadProfile}
                    onChange={(e) => maj({ loadProfile: e.target.checked })}
                  />
                  <span>
                    Charger mon profil shell avant de lancer la commande
                    <span className="serveur-aide">
                      Nécessaire si la commande est un alias ou une fonction de ton profil.
                    </span>
                  </span>
                </label>
              </>
            )}
            {b.mode === 'ssh_host' && (
              <>
                <div className="serveur-champs">
                  <label className="serveur-champ">
                    Hôte
                    <input
                      className="champ serveur-mono"
                      data-node="serveur-config.cible"
                      value={b.targets.ssh_host}
                      placeholder="vps.exemple.fr"
                      onChange={(e) => cible(e.target.value)}
                    />
                  </label>
                  <label className="serveur-champ serveur-champ--court">
                    Port
                    <input
                      className="champ serveur-mono"
                      data-node="serveur-config.port"
                      inputMode="numeric"
                      value={b.port}
                      placeholder="22"
                      onChange={(e) => maj({ port: e.target.value })}
                    />
                  </label>
                </div>
                <div className="serveur-champs">
                  <label className="serveur-champ">
                    Utilisateur
                    <input
                      className="champ serveur-mono"
                      value={b.user}
                      onChange={(e) => maj({ user: e.target.value })}
                    />
                  </label>
                  <label className="serveur-champ">
                    Clé (chemin local)
                    <input
                      className="champ serveur-mono"
                      value={b.identityFile}
                      placeholder="~/.ssh/id_ed25519"
                      onChange={(e) => maj({ identityFile: e.target.value })}
                    />
                  </label>
                  <label className="serveur-champ">
                    Rebond
                    <input
                      className="champ serveur-mono"
                      value={b.jump}
                      placeholder="bastion"
                      onChange={(e) => maj({ jump: e.target.value })}
                    />
                  </label>
                </div>
                <p className="texte-discret">
                  Connexion par <code>ssh</code> sans mot de passe : la clé doit être chargée dans
                  ton agent ssh ou ton trousseau. A-I-D n’en garde que le chemin.
                </p>
              </>
            )}
            {b.mode === 'ssh_alias' && (
              <>
                <label className="serveur-champ">
                  Alias SSH
                  <input
                    className="champ serveur-mono"
                    data-node="serveur-config.cible"
                    value={b.targets.ssh_alias}
                    placeholder="vps"
                    onChange={(e) => cible(e.target.value)}
                  />
                </label>
                <p className="texte-discret">
                  Un <code>Host</code> de ton <code>~/.ssh/config</code> : hôte, utilisateur, port
                  et clé viennent de là.
                </p>
              </>
            )}
          </section>

          <section className="serveur-bloc" aria-labelledby="bloc-environnement">
            <h2 className="titre-zone" id="bloc-environnement">
              Environnement distant
            </h2>
            <div className="serveur-champs">
              <label className="serveur-champ">
                Répertoire de travail
                <input
                  className="champ serveur-mono"
                  data-node="serveur-config.repertoire"
                  value={b.workdir}
                  onChange={(e) => maj({ workdir: e.target.value })}
                />
              </label>
              <label className="serveur-champ">
                Shell distant
                <input
                  className="champ serveur-mono"
                  value={b.shell}
                  onChange={(e) => maj({ shell: e.target.value })}
                />
              </label>
            </div>
            <label className="case">
              <input
                type="checkbox"
                data-node="serveur-config.session"
                checked={b.keepSession}
                onChange={(e) => maj({ keepSession: e.target.checked })}
              />
              <span>
                Garder la session vivante sur le serveur
                <span className="serveur-aide">
                  La discussion et les commandes en cours survivent à une coupure, à un refresh ou à
                  la fermeture de l’application, et reprennent à la reconnexion (tmux requis).
                </span>
              </span>
            </label>
            <div className="serveur-agents" data-node="serveur-config.agents">
              <span className="serveur-champ-titre">Agents sur le serveur</span>
              {AGENTS_CONNUS.map((a) => {
                const ok = detectes?.includes(a) ?? false;
                return (
                  <div key={a} className="serveur-agent" data-node={`serveur-config.agent-${a}`}>
                    <span aria-hidden="true">{ok ? '✓' : '–'}</span>
                    <span className="serveur-mono">{a}</span>
                    <span className="texte-faible">
                      {detectes === null ? 'non testé' : ok ? 'détecté' : 'non détecté'}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="serveur-bloc" aria-labelledby="bloc-permissions">
            <h2 className="titre-zone" id="bloc-permissions">
              Permissions
            </h2>
            <label className="serveur-champ">
              Mode d’exécution par défaut
              <select
                className="champ"
                data-node="serveur-config.permission"
                value={b.permissionMode}
                onChange={(e) => maj({ permissionMode: e.target.value as PermissionMode })}
              >
                {PERMISSIONS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="case">
              <input
                type="checkbox"
                checked={b.confirmDestructive}
                onChange={(e) => maj({ confirmDestructive: e.target.checked })}
              />
              <span>
                Toujours confirmer les commandes sudo et destructives
                <span className="serveur-aide">
                  Même en mode automatique. Une carte de confirmation s’affiche dans la discussion.
                </span>
              </span>
            </label>
            <div className="serveur-dossiers" data-node="serveur-config.dossiers">
              <span className="serveur-champ-titre">Dossiers autorisés</span>
              {b.allowedDirs.map((d) => (
                <span key={d} className="pastille pastille--code serveur-mono">
                  {d}
                  <button
                    type="button"
                    className="serveur-dossier-retirer"
                    aria-label={`Retirer ${d}`}
                    onClick={() => maj({ allowedDirs: b.allowedDirs.filter((x) => x !== d) })}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                className="champ serveur-mono serveur-dossier-champ"
                data-node="serveur-config.dossier"
                aria-label="Dossier à autoriser"
                placeholder="/srv"
                value={dossier}
                onChange={(e) => setDossier(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    ajouterDossier();
                  }
                }}
              />
              <button
                type="button"
                className="bouton bouton--fantome"
                data-node="serveur-config.dossier-ajouter"
                onClick={ajouterDossier}
              >
                + Ajouter
              </button>
            </div>
            {server && server.rules.length > 0 && (
              <div className="serveur-regles" data-node="serveur-config.regles">
                <span className="serveur-champ-titre">Toujours autorisé sur ce serveur</span>
                {server.rules.map((r) => (
                  <div key={r.id} className="serveur-regle">
                    <code>{r.pattern}</code>
                    <span className="texte-discret" data-node="serveur-config.regle.dossier">
                      dans {r.cwd}
                    </span>
                    <button
                      type="button"
                      className="bouton bouton--fantome"
                      aria-label={`Révoquer ${r.pattern}`}
                      onClick={() => void revoquer(r.id)}
                    >
                      Révoquer
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {server && (
            <section className="serveur-bloc serveur-bloc--danger" data-node="serveur-config.zone">
              <div>
                <h2 className="serveur-danger-titre">Supprimer ce serveur</h2>
                <p className="texte-discret">
                  Retire le serveur d’A-I-D. Les fichiers distants ne sont pas touchés.
                </p>
              </div>
              <button
                type="button"
                className="bouton bouton--danger"
                data-node="serveur-config.supprimer"
                onClick={() => setSuppression(true)}
              >
                Supprimer
              </button>
            </section>
          )}
        </form>

        <aside className="serveur-config-colonne">
          <section className="serveur-bloc" data-node="serveur-config.test">
            <div className="serveur-test-entete">
              <h2 className="serveur-test-titre">Test de connexion</h2>
              <button
                type="button"
                className="bouton"
                data-node="serveur-config.tester"
                disabled={!id || testEnCours}
                onClick={() => void lancerTest()}
              >
                Tester
              </button>
            </div>
            {!id && (
              <p className="texte-discret">Le test est lancé à l’enregistrement du serveur.</p>
            )}
            {id && modifie && (
              <p className="texte-faible" data-node="serveur-config.test.non-enregistre">
                Le test porte sur la configuration enregistrée.
              </p>
            )}
            {id && !test && (
              <p className="texte-discret" data-node="serveur-config.test.jamais">
                Jamais testé.
              </p>
            )}
            <div aria-live="polite">{test && <Etapes test={test} />}</div>
          </section>
          <section className="serveur-bloc" data-node="serveur-config.apercu">
            <h2 className="titre-zone">Aperçu dans la barre gauche</h2>
            <div className="serveur-apercu-groupe">
              <span
                className="serveur-apercu-carre"
                style={{ background: b.color }}
                aria-hidden="true"
              />
              <span data-node="serveur-config.apercu.groupe">{b.groupName || 'Serveurs'}</span>
            </div>
            <div className="serveur-apercu-ligne">
              <IconeServeur state={status.state} taille={15} />
              <span className="serveur-apercu-nom" data-node="serveur-config.apercu.nom">
                {b.name || 'Nouveau serveur'}
              </span>
              <span className="texte-faible">
                {status.latencyMs !== null ? `${status.latencyMs} ms` : ETAT_SERVEUR[status.state]}
              </span>
            </div>
            <p className="texte-faible">
              L’icône devient grise quand le serveur est injoignable et ambre pendant une
              reconnexion.
            </p>
          </section>
        </aside>
      </div>
      {quitter && (
        <Dialogue titre="Abandonner les modifications ?" onClose={() => setQuitter(false)}>
          <p className="texte-discret">Les changements non enregistrés seront perdus.</p>
          <div className="dialogue-actions">
            <button className="bouton" type="button" onClick={() => setQuitter(false)}>
              Continuer la saisie
            </button>
            <button
              className="bouton bouton--danger"
              data-node="serveur-config.quitter.confirmer"
              type="button"
              onClick={() => navigate('/serveurs')}
            >
              Abandonner
            </button>
          </div>
        </Dialogue>
      )}
      {suppression && server && (
        <Dialogue titre={`Supprimer ${server.name} ?`} onClose={() => setSuppression(false)}>
          <p className="texte-discret">
            A-I-D oublie ce serveur et ses discussions ; les agents qui y tournent sont arrêtés. Ses
            fichiers restent en place.
          </p>
          <div className="dialogue-actions">
            <button
              className="bouton"
              type="button"
              disabled={enCours}
              onClick={() => setSuppression(false)}
            >
              Annuler
            </button>
            <button
              className="bouton bouton--danger"
              data-node="serveur-config.supprimer.confirmer"
              type="button"
              disabled={enCours}
              onClick={() => void supprimer()}
            >
              Supprimer
            </button>
          </div>
        </Dialogue>
      )}
    </main>
  );
}

function Contenu() {
  const { id } = useParams<{ id: string }>();
  const { servers, erreur } = useServeurs();
  const navigate = useNavigate();
  // remonté après chaque enregistrement réussi, et seulement là : un `updatedAt` changé ailleurs (autre
  // onglet) ne jette pas le brouillon en cours (review S.5). `nouveau` et `:id` rendent le même
  // élément : ce compteur survit au passage de la création à la configuration.
  const [retour, setRetour] = useState<{ version: number; avis: string | null }>({
    version: 0,
    avis: null,
  });
  const enregistre = (serverId: string, avis: string | null) => {
    if (!id) navigate(`/serveurs/${serverId}/configuration`, { replace: true });
    setRetour((r) => ({ version: r.version + 1, avis }));
  };
  if (!id) return <Formulaire key="nouveau" server={null} avis={null} onEnregistre={enregistre} />;
  if (servers === null)
    return (
      <main className="page">
        {erreur ? (
          <p className="message-erreur" role="alert">
            {erreur}
          </p>
        ) : (
          <p className="texte-discret">Chargement…</p>
        )}
      </main>
    );
  const server = servers.find((s) => s.id === id);
  if (!server)
    return (
      <main className="page">
        <p className="message-erreur" role="alert" data-node="serveur-config.introuvable">
          Serveur introuvable : il a peut-être été supprimé.
        </p>
      </main>
    );
  return (
    <Formulaire
      key={`${server.id}:${retour.version}`}
      server={server}
      avis={retour.avis}
      onEnregistre={enregistre}
    />
  );
}

export function ServeurConfig() {
  return (
    <Layout screen="serveurs">
      <Contenu />
    </Layout>
  );
}

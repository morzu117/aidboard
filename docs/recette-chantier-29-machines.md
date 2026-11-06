# Recette de l'écran Machines (chantier 29)

Grille du point 29.7 du plan `docs/chantiers/29-machines.md`. Deux niveaux :

- **couverture automatique** : ce que `npm run gate` et `npm run gate:e2e` vérifient déjà. Ce sont
  les tests du daemon, les tests de l'écran et `e2e/machines.spec.ts`. Ce spec tourne sur un daemon
  à part, en `stream`, devant les faux claude et codex (`test/fixtures/bin-stream`), avec un
  `CODEX_HOME` temporaire et aucune clé d'API dans son environnement. Jamais le vrai claude ni le
  vrai codex, aucun réseau, aucun serveur.
- **recette réelle** : sur le vrai cockpit de Julien, sous Node 22 puis sous Node 24, avec un
  serveur distant. Aucune case de cette partie ne peut être cochée depuis une session automatisée.

Rappels qui valent pour toute la recette :

- le daemon de travail (port 4870) fait tourner des agents. La recette se fait sur une instance à
  part, lancée depuis le worktree de la branche. Rien n'est lancé, redémarré ni réinstallé sur le
  daemon de travail sans l'accord de Julien ;
- Diagnostiquer un serveur est réel : il joue le test de connexion, puis une commande distante
  (`--version` des agents trouvés et la mémoire). Il ne lance aucun agent ni aucune session tmux ;
- l'écran ne lit jamais un secret : il teste la présence d'une variable et l'existence d'un
  fichier. Aucune valeur de clé ne doit apparaître à l'écran, dans les réponses ni dans les journaux.

## Couverture automatique (état à la PR)

| Point | Vérifié par |
|---|---|
| Table des capacités, confrontée à REMOTE_CONTROL, aux images du pilote et aux options (D153) | `test/capacites.test.ts` |
| Cases des cartes et matrice : marques, états, cursor, filtre (D157, D158) | `test/web/machines-vue.test.ts` |
| Mémoire disponible : vm_stat, /proc/meminfo, sortie de la commande distante (D156) | `test/machines-memoire.test.ts` |
| Diagnostic du Mac (D154) ; diagnostic d'un serveur par le faux ssh : complet, sans version, test en échec, jamais diagnostiqué, 404, suppression en cascade (D155) ; fournisseurs par la route (D159) | `test/machines-routes.test.ts`, `test/machines-diagnostic.test.ts` |
| Fournisseurs et alertes : sans clé, clé retirée, clé transmise, OPENAI_API_KEY, auth.json, CODEX_HOME ; une valeur synthétique ne sort jamais (D159) | `test/machines-fournisseurs.test.ts` |
| L'écran : barre, Ton cockpit, cartes du Mac et d'un serveur, Diagnostiquer, blocage, navigations, matrice et filtres, fournisseurs, alerte et marche à suivre (D151 à D160) | `test/web/machines.test.tsx`, `test/web/serveurs.test.tsx` |
| Le trombone du composer lit la table : présent sur le Mac, absent sur un fil distant (D153) | `test/web/conversation.test.tsx`, `test/web/discussion.test.tsx` |
| De bout en bout : l'entrée Machines, Ton cockpit, la carte du Mac (versions synthétiques, mémoire, Diagnostiquer), la matrice du Mac, Anthropic par l'abonnement, l'alerte des identifiants de codex sans leur valeur | `e2e/machines.spec.ts` |

Non couvert en e2e :
- un serveur (Diagnostiquer, versions, mémoire, matrice du serveur) : pas de serveur SSH en e2e. Il
  est couvert par les tests du daemon, par le faux ssh, et par ceux de l'écran ;
- une clé d'API dans l'environnement : l'e2e retire toutes les clés connues. Elle est couverte par
  les tests des fournisseurs.

## Prérequis sur le Mac

- [ ] L'instance de recette tourne sur la branche `feat/29-machines` (head : _à noter_), sous
  Node 22 (`node --version` : _à noter_)
- [ ] claude et codex installés et authentifiés
- [ ] Un serveur distant configuré et joignable, avec claude installé

## Recette réelle

- [ ] 29.7.1 La barre du haut dit « Machines » à la place de « Serveurs » ; elle est active sur
  `/machines` et sur l'écran Serveurs, qui reste accessible par le bloc VPS de la barre gauche.
  - Constat : _à remplir_
- [ ] 29.7.2 Ton cockpit : « Mode host inactif », le Mac seul, aucun bouton d'appareil.
  - Constat : _à remplir_
- [ ] 29.7.3 La carte du Mac : les vraies versions de claude et de codex, « session persistante »
  (transport `stream`), la mémoire libre proche de celle du Moniteur d'activité (mémoire
  disponible, pas « libre » seule), le nombre de sessions actives juste.
  - Constat : _à remplir_
- [ ] 29.7.4 La carte du serveur : l'état et la latence, « Jamais diagnostiqué » sur un serveur neuf.
  Diagnostiquer : « Diagnostic… », puis les agents avec leur version, la reprise (tmux) et la
  mémoire du serveur. Rien n'est lancé sur le serveur (pas de session tmux nouvelle, pas d'agent).
  - Constat : _à remplir_
- [ ] 29.7.5 Un serveur coupé (réseau ou cible fausse) : Diagnostiquer dit l'étape en échec et sa
  raison sur la carte.
  - Constat : _à remplir_
- [ ] 29.7.6 La matrice : claude et codex sur le Mac et sur le serveur ; images – sur le serveur,
  contrôle distant – pour codex, consommation – partout. Le filtre par machine.
  - Constat : _à remplir_
- [ ] 29.7.7 Les fournisseurs : Anthropic par l'abonnement, repli payant désactivé ; OpenAI par le
  CLI codex ; Ollama si la recherche de la mémoire l'utilise.
  - Constat : _à remplir_
- [ ] 29.7.8 L'alerte de secret : lancer l'instance de recette avec une clé factice exportée
  (`ANTHROPIC_API_KEY=factice-0000`). L'alerte nomme la variable, jamais la valeur ; « Comment la
  déplacer » déplie la marche à suivre. Si `~/.codex/auth.json` existe, l'alerte des identifiants de
  codex, et sa marche à suivre (`cli_auth_credentials_store = "keyring"`, à confirmer sur la
  version de codex installée).
  - Constat : _à remplir_
- [ ] 29.7.9 Les mêmes points 29.7.3, 29.7.4 et 29.7.6 sous Node 24 (`node --version` : _à noter_).
  - Constat : _à remplir_

## À valider par Julien

- [ ] « Machines » remplace « Serveurs » dans la barre du haut ; l'écran Serveurs reste, sous la même
  entrée active.
- [ ] Le Mac est diagnostiqué à chaque ouverture de l'écran (`--version` et mémoire, 3 s au plus) ;
  un serveur seulement sur Diagnostiquer.
- [ ] Les versions et la mémoire d'un serveur sont gardées en base (`server_diagnostics`) ; son
  dernier test ne l'est pas (perdu au redémarrage du daemon, comme aujourd'hui).
- [ ] La matrice montre toujours claude et codex sur chaque machine, « Agent non détecté » quand ils
  manquent ; cursor seulement là où il a été trouvé.
- [ ] codex n'est pas interrogé sur son compte (`account/read`) : l'accès d'OpenAI reste « codex CLI
  · identifiants gérés par le CLI », sauf clé d'API dans l'environnement.

## Ce qui n'est pas couvert

- Mode host, appareils, QR, révocation, Couper tous les accès (31).
- Les profils de travail, les fournisseurs qu'aucun agent d'A-I-D n'utilise, l'affichage de la
  consommation.
- Déplacer une clé vers le trousseau à la place de l'utilisateur.

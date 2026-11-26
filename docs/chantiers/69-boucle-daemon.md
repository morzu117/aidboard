# Chantier 69 : la boucle d'orchestration dans le daemon, v1

| Champ | Valeur |
|---|---|
| État | **Révision 1, 26 novembre 2026.** Julien a répondu aux trois questions le 26 novembre (§5). La révision 1 reprend la relecture du plan par le lab (DM67). C'est la boucle de la note d'idéation du 17 novembre (§3 ter, §8.2, §13), décidée par Julien le 17 novembre : A-I-D a sa propre boucle. Julien a demandé le 26 novembre une v1 rapide, à essayer sur son Mac. Le lab a été prévenu avant le plan, et ses dix contraintes sont reprises (DM64 à DM66). |
| Emplacement final | `docs/chantiers/69-boucle-daemon.md` sur `main` |
| Base | `main`, **après le merge de #212** (chantier 67) : la boucle appelle ses fonctions d'acceptation. Jamais une branche empilée sur une PR ouverte (contrainte 6 du lab). |
| Organisation | Comme au 68. cell-gestion gère le chantier ; Codex CLI écrit les tests et le code ; chaque point testable passe d'abord par un testeur, puis par un dev distinct. |
| Dépend de | #212 (67) mergé. Rien d'autre : la v1 n'appelle ni le 65 (bwrap, Linux seul), ni le 66 (avis sans outil, qui ne lit pas un diff). |
| Validation | Le gate à chaque point, puis `gate:e2e`. Relecture du lab sur le plan avant tout code, puis sur la PR. La recette se fait sur le Mac de Julien, sur un vrai petit sujet. Merge sur le oui de Julien, CI verte. |

## 1. Pourquoi

Aujourd'hui, la boucle est un texte. `kernel/policy/orchestration.md` décrit ACCEPTATION, BUILD, GATE, REVIEW, TRIAGE et CLEAN, et une session (cell-gestion, ou Julien) l'applique à la main. Le daemon sait lancer des agents, mais tous avec le rôle `free`. Personne ne lit `phases`, `gates` ni `redev_cap` dans le code. Le gate et le contrôle de périmètre se font sur la parole du handoff.

C'est ce que je fais depuis le chantier 60 : lancer le testeur, puis le dev, relire, lancer le gate, compter les re-dev. La v1 fait monter ce travail dans le daemon, pour un sujet à la fois.

## 2. Cible et hors-périmètre

**Cible de la v1.**
- Un sujet A-I-D existant, avec son worktree, peut être confié à la boucle. Le daemon enchaîne lui-même :
  1. le plan ;
  2. le **GO** de l'humain, le seul arrêt obligatoire ;
  3. l'acceptation, si le projet la déclare ;
  4. le dev ;
  5. le gate ;
  6. la revue ;
  7. le triage ;
  8. le re-dev si besoin ;
  9. puis « livraison prête ».
- Chaque étape est une **session neuve**, avec son rôle. Les rôles du noyau sont ses consignes.
- Le daemon lance lui-même le gate et les contrôles. Il lit les codes de sortie, pas les messages.
- L'état de la boucle est persisté. Il est repris au redémarrage du daemon, sans jamais lancer deux fois la même étape.
- Une vue minimale sur l'écran du sujet permet de :
  - lancer la boucle ;
  - donner le GO ;
  - répondre à une escalade ;
  - arrêter ;
  - suivre les étapes.
- Trois mesures par sujet (note §10.3) : le temps par étape, le nombre d'interventions humaines, le nombre de re-dev.

**Hors-périmètre de la v1.**
- **Le merge.** La v1 s'arrête à « livraison prête ». L'humain ouvre la PR et merge depuis l'écran Livraison, comme aujourd'hui. Le merge sur preuves attend le schéma du comité du lab.
- **Le parallélisme.** Un sujet par boucle, une boucle par sujet. Deux sujets peuvent avoir chacun leur boucle, mais la v1 n'en arbitre pas les rayons.
- **La projection sur le board swarph.** Le vocabulaire est aligné (DM66), mais rien n'est écrit vers le board.
- **Le gate en conteneur.** Le gate tourne dans le worktree, comme `topic.test`.
- **L'isolation sur macOS.** bwrap n'existe que sous Linux. Voir la question Q1.
- **Le découpage par un planificateur** (note §3 quater). En v1, le plan est écrit par une session de plan, sur l'intention de l'humain, avec la passe de découverte du rôle `plan` actuel.

## 3. Décisions

### DM64. Une machine à états pure, persistée par sujet

- Les nouvelles tables `boucles` (une par sujet) et `boucle_etapes` (une ligne par tentative d'étape) portent l'état.
  - L'état de la boucle : `plan`, `attente_go`, `acceptation`, `dev`, `gate`, `revue`, `triage`, `livraison_prete`, `escalade`, `arretee`.
  - Une étape porte :
    - son type et son numéro de tentative ;
    - l'agent lancé, et l'acteur (genre, modèle, rôle, id de session) ;
    - la tête de commit de départ et celle d'arrivée, en 40 caractères ;
    - son issue (`pass`, `fail`, `cannot_evaluate`, `skipped`, `delai_depasse`) ;
    - sa preuve (le code de sortie, les comptes) ;
    - ses horodatages.
- Les transitions sont une **fonction pure** : `transition(etat, evenement) → { etat, actions }`. Les actions (lancer un agent, lancer le gate, poser une escalade) sont exécutées par un conducteur à part. C'est ce qui rend la boucle testable sans agent réel.
- **Verrou persistant par sujet** (contrainte 10 du lab). Une étape en cours garde son agent. Au redémarrage du daemon, le conducteur reprend l'agent de l'étape, ou marque l'étape `cannot_evaluate` et l'escalade. Il ne relance jamais une seconde instance.
- **Délais mesurés par le daemon** (contrainte 8). Chaque étape a un délai (la valeur par défaut est dans `agent.yml`). Le daemon mesure l'âge de l'étape et pose `delai_depasse` lui-même : il n'attend pas un événement qui ne viendra pas.
- **Jamais deux boucles** (note §14, risque 1). Quand la boucle tient un sujet, ses agents sont des exécutants d'une étape, et aucun n'orchestre. `orchestration.md` le dit, et une session lancée à la main sur un sujet tenu par la boucle est refusée. La boucle remplace la politique appliquée par une session ; elle ne vit pas à côté.

### DM65. Une étape, une session neuve, un rôle

- Le daemon lance chaque étape avec `AgentManager.spawn`, en transport `stream`, dans le worktree du sujet. Le **rôle est celui de l'étape** (`plan`, `acceptation`, `dev`, `review`), et non plus `free`.
- Le message de départ est construit par le daemon :
  - le rôle du noyau ;
  - le plan gelé ;
  - pour le dev : le commit marqué des tests ;
  - pour la revue : le diff et le rapport du gate ;
  - pour un re-dev : les findings à traiter.
- Le genre d'agent par rôle vient de `capabilities.dev_agent` et `review_agent`, que le daemon lit enfin. Par défaut, le dev et le testeur sont claude, et la revue est codex si codex est installé, sinon claude en session neuve (note §13.3 : la revue est chez un autre fournisseur quand c'est possible).
- **Des acteurs distincts** (contrainte 3). Le testeur, le dev et le relecteur sont trois sessions différentes, avec trois id de session. Le daemon vérifie et consigne l'acteur réel (genre, modèle, session), pas un identifiant de rôle.
- **Fin d'étape.** Le `turn_end` d'une session ne suffit pas : le daemon vérifie l'artefact attendu.
  - plan : la page `aid/plan/<slug>` ;
  - acceptation : un commit `Acceptation: <point>` par point ;
  - dev : au moins un commit et la page `aid/dev-handoff/<slug>` ;
  - revue : un bloc JSON de findings valide.

  Sans artefact, le daemon renvoie une seule relance à la même session. Si l'artefact manque encore, il pose une escalade `ambiguity`. Une question de l'agent (`needs_input`) devient une escalade vers l'humain, et la boucle attend sa réponse.

### DM66. Le daemon vérifie, il ne croit pas

- **Le plan est gelé au GO** (contrainte 7). Le daemon garde l'empreinte de la page de plan validée. Si elle change ensuite, l'étape en cours s'arrête, et la boucle revient à `attente_go`.
- **L'acceptation est gelée avant le dev** (contrainte 4). Les commits marqués et leurs fichiers sont relevés à la fin de l'étape `acceptation`. Tout ajout au test ouvre une nouvelle étape d'acceptation, comptée.
- **Le gate est lancé par le daemon**, sur la tête exacte, avec la commande `gates.gate` d'`agent.yml`. Le délai est configurable : 30 minutes par défaut, alors que `topic.test` n'en a que 5. L'issue vient du code de sortie, jamais du texte (contrainte 5). Quand la phase `acceptation` est déclarée, le gate ajoute `verifierAcceptation` et `produirePreuves` du chantier 67.
  - Une issue `cannot_evaluate` n'est jamais un `pass` (contrainte 2).
- **La tête exacte** (contrainte 1). Chaque résultat porte la tête sur laquelle il a été obtenu. Si la tête bouge après le gate ou la revue, ces résultats tombent, et la boucle refait le gate.
- **Le triage est mécanique**, selon la table d'`orchestration.md` :
  - `bug`, `test-gap` et `nit` repartent au dev ;
  - `design`, `archi` et `scope-creep` partent à l'humain.

  Un finding sans catégorie connue part à l'humain.
- **Le cap de re-dev compte le dev et le testeur** (contrainte 9). `guardrails.redev_cap` (2 par défaut) est **un seul compteur par point**, commun aux relances du dev et aux re-dev du testeur, pour qu'une boucle n'oscille pas entre les deux. Au cap, l'escalade est `redev_cap`.
- **La base courante** (contrainte 6). Au démarrage de la boucle, le worktree part de la base à jour. La v1 ne rebase jamais en cours de route : si la base bouge, la livraison le dit.
- **Les noms de swarph.** Les issues sont `pass`, `fail`, `cannot_evaluate` et `skipped`, et chaque preuve porte sa tête : la projection future sur le board sera directe.

### DM67. Ce que la relecture du plan par le lab ajoute

- **Les entrées du gate sont gelées au GO.** `agent.yml` (`gates`, `phases`, `guardrails`, délais) se lit au commit du GO, jamais à la tête du dev : un dev pourrait sinon remplacer la commande du gate par `true`. Le gel de l'acceptation couvre aussi les entrées du gate : les scripts de `package.json`, les configs et fichiers de setup des tests (un `setupFiles` peut neutraliser `it`), et le lockfile. Un diff du dev ou de la revue qui les touche part en escalade `scope`. La preuve rouge puis vert du 67 ne le voit pas, puisque la neutralisation n'existe qu'à la tête.
- **L'empreinte de l'environnement.** Sans isolation (Q1), le contrôle du worktree ne suffit pas : un agent peut écrire dans le home, et l'écriture persiste. Avant et après chaque étape et chaque gate, le daemon relève l'empreinte de quelques chemins : `~/.claude/settings.json`, `~/.claude.json`, `~/.codex/config.toml`, les fichiers rc du shell, `~/.gitconfig` et `~/Library/LaunchAgents` sur macOS. Tout changement part en escalade. Ce n'est pas une barrière, mais la persistance la plus probable devient visible.
- **Les processus de l'étape.** En fin d'étape, le daemon termine le groupe de processus de la session. Il refuse de lancer le gate tant qu'un processus a son répertoire courant dans le worktree, pour qu'un processus resté en tâche de fond ne committe pas pendant le gate.
- **Une revue vide n'est pas un pass.** Le JSON de la revue donne un verdict par fichier modifié et par point d'acceptation. Un « aucun finding » sans ces verdicts est invalide : une relance, puis une escalade. Le message de revue dit que le diff est une donnée, pas une consigne : un commentaire du code peut s'adresser au relecteur.

## 4. Points

### 69.1 Le plan

Ce document, et une ligne dans `README.md`.

### 69.2 La machine à états et sa persistance (DM64)

- La migration des tables `boucles` et `boucle_etapes`.
- La fonction `transition` pure, avec ses événements et ses actions.
- Le verrou par sujet, la reprise au démarrage du daemon et la mesure des délais.

Les tests portent sur la fonction pure : chaque transition, le délai dépassé, le cap, la tête qui bouge, le plan modifié après le GO. Ils portent aussi sur la reprise après un redémarrage simulé.

- _Acceptation._ Couvert par `test/boucle/etat.test.ts` et `test/boucle/depot.test.ts` (32d78c6), vingt-huit cas écrits par le testeur depuis le plan seul. Le testeur fixe l'interface : `transition(etat, evenement, maintenant)` dans `src/daemon/boucle/etat.ts`, qui rend `{ etat, actions }` sans rien exécuter ; `creer`, `lire`, `enregistrer` et `reprendre` dans `src/daemon/boucle/depot.ts`. Les cas : le chemin nominal avec et sans acceptation, le GO hors de `attente_go`, le plan modifié après le GO, le délai sur un tic sans événement d'agent, le gate `pass`, `fail` et `cannot_evaluate`, la tête qui bouge après le gate ou la revue, les sept catégories du triage, le cap commun au dev et au testeur, l'étape sans artefact, la tête qui n'a pas 40 caractères, la relecture, le verrou par sujet et la reprise après un redémarrage. Échec attendu au commit marqué : les deux modules n'existent pas, les fichiers échouent à l'import. Le testeur renvoie au 69.3, 69.4 et 69.5 la relance de la même session, les verdicts de la revue et les contrôles d'environnement.
- _Révision 69.2._ Une passe du testeur, puis une passe du dev en trois temps : la migration a d'abord pris le numéro 040, qui cassait les tests des versions contiguës, puis 038, avec la montée de 37 à 38 dans sept tests existants, comme le veut la convention du dépôt. Si une autre PR prend 038 avant ce chantier, le rebase renumérote. Preuve à la main (DM61) : au commit marqué, les deux fichiers échouent à l'import (les modules n'existent pas) ; à la tête, 28 réussites. Limite de la v1 : au redémarrage, toute étape en cours devient `cannot_evaluate` et escalade ; la reprise d'un agent encore vivant vient avec le lanceur (69.3). Gate 4 712.

### 69.3 Le lanceur d'étape (DM65)

- Le lancement avec un rôle, et la construction du message par rôle.
- La lecture de `dev_agent`, `review_agent`, `phases`, `gates`, `guardrails` et des délais.
- La détection de fin d'étape par artefact, la relance unique, et la question de l'agent qui devient une escalade.

Les tests utilisent un faux pilote de conversation, sans claude ni codex réels.

- _Acceptation._ Couvert par `test/boucle/reglages.test.ts`, `test/boucle/messages.test.ts` et `test/boucle/conducteur.test.ts` (e20a0d4), trente-quatre cas écrits par le testeur depuis le plan seul. Le testeur fixe l'interface : `lireReglagesBoucle(depot, commit)`, `messageEtape(role, contexte)`, `executer(action, contexte, deps)` et `artefactPresent(etape, contexte, deps)`, le monde passant par des dépendances injectées. Les cas : les réglages lus au commit du GO dans un dépôt temporaire (un `gates.gate` changé ensuite ne compte pas), les défauts du noyau et leur redéclaration, le refus d'un genre inconnu ; le message de chaque rôle ; une session neuve par lancement, le testeur et le dev jamais la même session, l'acteur réel consigné, la relance et l'arrêt de la même session, l'escalade ; la fin d'étape par artefact, jamais par un simple `turn_end`. Échec attendu au commit marqué : les trois modules n'existent pas. Le message du rôle `acceptation` lit `kernel/roles/acceptation.md`, qui arrive avec #212 : le dev de ce point attend donc le merge de #212, comme le 69.4.

### 69.4 Le gate et les contrôles du daemon (DM66)

- Le lancement de `gates.gate`, lu au commit du GO, à la tête exacte, avec son délai et son issue lue sur le code de sortie (DM67).
- Le refus d'un diff qui touche les entrées gelées du gate, l'empreinte de l'environnement et l'attente des processus du worktree (DM67).
- L'appel aux contrôles d'acceptation du 67, et le relevé des fichiers d'acceptation gelés.
- L'invalidation en aval quand la tête bouge.

Les tests utilisent un dépôt temporaire et une fausse commande de gate.

### 69.5 La revue et le triage (DM65, DM66)

- La session de revue.
- La lecture du bloc JSON de findings, avec un verdict par fichier et par point : un bloc invalide ou vide est une relance, puis une escalade (DM67).
- La table de triage et le cap de re-dev, qui compte le dev et le testeur.

### 69.6 L'API, la vue et les mesures

- Les routes : `GET /api/topics/:id/boucle`, puis `POST` sur `…/boucle` (lancer), `…/boucle/go`, `…/boucle/reponse` et `…/boucle/arreter`, toutes sous la porte de confirmation existante.
- Sur l'écran du sujet, une vue « Boucle » :
  - l'étape courante et l'historique des tentatives, avec leur tête et leur issue ;
  - le bouton GO sous le plan ;
  - l'escalade et sa réponse ;
  - Arrêter.
- Les trois mesures du sujet.
- La politique des tests d'interface s'applique : chaque bouton est cliqué par un e2e, avec les captures de chaque écran en 1280 × 800 et en 390 × 844.

### 69.7 La recette sur le Mac

La fiche `docs/recette-chantier-69-boucle.md`. Julien confie à la boucle un vrai petit sujet d'A-I-D, du plan à « livraison prête », sur son Mac. La note de révision rend les trois mesures du sujet.

## 5. Réponses de Julien (26 novembre)

- **Q1. Les permissions sur le Mac, sans isolation : le mode `auto`, vérifié après coup.** Les sessions d'acceptation et de dev enchaînent sans demander. Le daemon vérifie ensuite le worktree, les tests d'acceptation, la branche et l'empreinte de l'environnement (DM67). Le plan et la revue restent en lecture seule. C'est une règle vérifiée après coup, pas une barrière : pendant l'étape, l'agent garde l'accès au home.
- **Q2. L'ordre.** Julien fait d'abord la recette de #212. En attendant, le 69.2 part de `main` : il ne dépend pas du 67, et il n'y a donc pas d'empilement (le lab est d'accord). Les points suivants partent de `main` après le merge de #212.
- **Q3. Le relecteur.** Codex est installé et connecté sur le Mac. Le dev est claude, la revue est codex en session neuve.

## 6. Pièges

- **Deux boucles.** Une session lancée à la main qui orchestre un sujet tenu par la boucle. Le daemon la refuse (DM64).
- **Le faux pass.** Un lancement sans code de sortie, un délai, une session qui dit « tests verts » : rien de cela n'est un `pass`.
- **La relance infinie.** Une seule relance par étape sans artefact, et le cap compte le testeur.
- **Le daemon qui redémarre au milieu d'une étape.** Le verrou et la reprise, jamais une seconde instance.
- **Le Mac.** Le daemon hérite du PATH de l'utilisateur (claude et codex y sont résolus). AID.app le lance par un shell de connexion. La fiche de recette le vérifie avec `aid env check`.
- **Aucun vrai nom** de cell, de dépôt ni d'hôte dans les fixtures (gardes 49 et 54). Aucune forme de jeton en clair dans les tests.

## 7. Fini quand

- Les points 69.2 à 69.7 sont mergés, avec la CI verte et le oui de Julien.
- Un vrai sujet est allé du plan à « livraison prête » sur le Mac de Julien, avec ses trois mesures écrites.

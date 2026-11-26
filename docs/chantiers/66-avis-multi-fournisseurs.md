# Chantier 66 : des avis de plusieurs fournisseurs, par leurs CLI d'abonnement

| Champ | Valeur |
|---|---|
| État | **Révision 0, 24 novembre 2026.** Sujet « routage des modèles » de la note d'idéation de Julien du 17 novembre (§3 quinquies). Arbitrage de Julien du 24 novembre : les autres fournisseurs passent par les CLI d'abonnement déjà installés (`claude`, `codex`, `vibe`), sans clé d'API ni agrégateur. |
| Emplacement final | `docs/chantiers/66-avis-multi-fournisseurs.md` sur `main` |
| Base | `main` |
| Organisation | Comme au 63 : cell-gestion gère le chantier, Codex CLI écrit le code et les tests, cell-gestion relit, lance le gate, commite et ouvre la PR. |
| Validation | Le gate est vert à chaque point, puis `gate:e2e`. Pas de recette manuelle : les flags sont vérifiés en CI (66.7). Le merge se fait sur le oui de Julien, CI verte. |

## 1. Pourquoi

La note veut trois choses :
- un routage agnostique, où les rôles ne nomment jamais un modèle, seulement un niveau d'effort ;
- la possibilité de faire **challenger** une décision structurante par plusieurs fournisseurs, « pour éviter le biais d'un provider » ;
- une remontée à l'humain en cas de désaccord fort.

Elle demande aussi de « vérifier si `swairm ask` est déjà agnostique ». **Il ne l'est pas.**
- `spawning_pool/ask_runner.py` n'appelle que `claude -p`, avec trois modèles en liste fermée : `sonnet`, `opus` et `haiku`.
- A-I-D le lance comme un binaire externe (`src/daemon/swairm/ask.ts`) et en relit le format `swairm-ask/1`.

Le §1 de la note veut par ailleurs éclater Swairm et en garder les morceaux utiles. Le lanceur d'avis en est un : environ 350 lignes.

## 2. Cible et hors-périmètre

**Cible.**
- Le lanceur d'avis vit dans aidboard, en TypeScript. Il interroge `claude`, `codex` et `vibe` par leur CLI, sans outil, dans un répertoire vide.
- Il rend le même format que `swairm ask`, et l'écran actuel le montre sans changement.
- Les niveaux d'effort (`leger`, `standard`, `fort`) et leur table vers un fournisseur et un modèle sont déclarés dans le noyau.
- Le rôle plan sait quand demander un challenge, et quoi faire d'un désaccord.

**Hors-périmètre.**
- Le choix du niveau étape par étape, et l'escalade sur échec. Ce sera la boucle dans le daemon : la table est prête pour elle.
- Les clés d'API, LiteLLM et OpenRouter, écartés par l'arbitrage.
- Le juge par modèle. La règle de majorité existe déjà (`accord`), et le désaccord remonte à l'humain.
- Le retrait de `swairm ask` de Swairm. Le dépôt Swairm n'est pas touché.

## 3. Décisions

### DM47. Les niveaux et la table, dans le noyau

`kernel/defaults.yml` gagne la section `routage` :

```yaml
routage:
  niveaux:
    leger:    { fournisseur: claude, modele: haiku }
    standard: { fournisseur: claude, modele: sonnet }
    fort:     { fournisseur: claude, modele: opus }
  challenge: [claude, codex, vibe]   # un avis par fournisseur
```

- Elle remplace `models.trivial`, `models.standard` et `models.complex`. Ceux-ci restent lus, avec un avertissement de `/sync`, jusqu'à la migration du noyau : un projet qui les surcharge garde sa valeur.
- Un projet surcharge la section dans son `agent.yml`, comme le reste. Le schéma du manifeste la décrit.
- Un modèle se nomme comme le CLI l'accepte : `--model` pour claude, `-m` pour codex, `--agent` ou `--model` pour vibe, selon ce que le job `contrat-cli` établit (66.7).

### DM48. `aid avis`, le lanceur dans le daemon

`src/daemon/avis/` porte `oracle/ask.py` et `spawning_pool/ask_runner.py` de Swairm, à leur révision courante.
- **Les mêmes contrats** :
  - le gabarit de prompt (version `1`), les sous-questions numérotées et les quatre verdicts ;
  - le format `swairm-ask/1`, champ pour champ ;
  - le calcul de l'`accord` ;
  - l'écriture des demandes dans un dossier (`<AID_HOME>/avis/`), et leur relecture.

  Le champ `modele_demande` prend la forme `<fournisseur>:<modele>`. L'écran affiche la chaîne telle quelle.
- **Un adaptateur par fournisseur**. Chaque appel se fait sans shell, dans un répertoire temporaire vide, avec les clés d'API retirées de l'environnement (`config.env.strip`). Le délai et le budget sont bornés :

  | Fournisseur | Appel |
  |---|---|
  | `claude` | l'argv D246 de Swairm : `-p`, `--tools ""`, `--setting-sources ""`, `--strict-mcp-config`, `--disable-slash-commands`, `--permission-mode dontAsk`, `--model`, `--max-budget-usd` et `--output-format json` |
  | `codex` | `codex exec --sandbox read-only --skip-git-repo-check -m <modele>`, plus `--output-last-message <fichier>`, puis la relecture du fichier ; le prompt passe sur stdin |
  | `vibe` | l'appel de `kernel/adapters/vibe.md` : `-p`, `--max-turns 1`, `--output json` et `--max-price`, sans outil (`--enabled-tools` vide) |

- Un fournisseur dont le CLI est absent du PATH donne un avis à l'état `echec`, avec le détail « CLI absent ». La demande continue avec les autres.
- **La route existante** `POST /api/swairm/ask` passe au lanceur interne. Elle ne lance plus le binaire `swairm`. La validation de la demande accepte `<fournisseur>:<modele>` en plus des trois noms historiques, qui valent `claude:<nom>`.
- **Le CLI** : `aid avis "<question>" [--sous-question …] [--niveau fort] [--challenge] [--json]`.
  - `--challenge` prend un avis par fournisseur de `routage.challenge`, au niveau `fort`.
  - Sans `--challenge`, on prend N avis du fournisseur du niveau.
  - La commande parle au daemon par la même route.

### DM49. Quand challenger, et que faire du résultat

- Le rôle plan lance `aid avis --challenge` **avant un `decide` d'architecture**, c'est-à-dire un choix qui engage la suite du projet : architecture, découpage ou choix de composant. Il ne le fait jamais à chaque étape.
- `unanime` ou `majorite` : la décision suit le verdict. Le `decide` garde l'identifiant de la demande dans ses sources.
- `partage` ou `insuffisant` : la décision **remonte à l'humain**. Le plan s'arrête sur une question, avec le tableau d'accord, et ne choisit pas lui-même.
- Le coût se voit : l'appel affiche le coût total quand les CLI le donnent, et « inconnu » sinon.

## 4. Points

### 66.1 Le plan

Ce document, et une ligne dans `docs/chantiers/README.md`.

### 66.2 Le lanceur et ses adaptateurs (DM48)

- `src/daemon/avis/` : le gabarit, les trois adaptateurs, l'accord et le dossier.
- Les tests utilisent de faux `claude`, `codex` et `vibe` dans un `PATH` temporaire :
  - un avis valide par fournisseur ;
  - un JSON précédé d'un avertissement ;
  - un verdict invalide ;
  - un délai dépassé ;
  - un budget atteint ;
  - un CLI absent ;
  - les clés d'API retirées de l'environnement du fils ;
  - le répertoire de travail vide.
- **Les vecteurs de Swairm.** `tests/test_swairm_ask.py` et `tests/test_ask_runner.py` sont repris en TypeScript pour le gabarit et l'accord, afin que le format reste identique.

- _Révision 66.2._ Fait, dans `src/daemon/avis/` :
  - `prompt.ts`, le gabarit v1 et le découpage. Seule la première ligne change : « A-I-D avis… » ;
  - `lecture.ts`, la lecture et l'accord ;
  - `fournisseurs.ts`, les trois adaptateurs. Les clés Anthropic, OpenAI et Mistral sont retirées de l'environnement, en plus de `env.strip` ;
  - `demande.ts`, 3 avis en parallèle au plus, avec une archive relue par le parseur existant.

  Écarts avec Swairm :
  - le modèle s'écrit `<fournisseur>:<modele>` ;
  - un CLI absent donne `brut: "CLI absent"` ;
  - vibe garde son modèle configuré (`modele_servi: null`), faute de sélecteur documenté.

  **Le filtre de la question** (`nettoyage.verifier` de Swairm) n'est pas porté ici. Il va dans la route, au point 66.3, avec `nettoyer` et `hotesPrives` d'A-I-D.

  31 tests. Gate 4 715.

### 66.3 La route, le CLI et la table (DM47, DM48)

- `POST /api/swairm/ask` passe au lanceur interne, et l'écran ne change pas.
- `aid avis`.
- `routage` dans `defaults.yml` et dans le schéma. La lecture garde `models.*` en repli.

- _Révision 66.3._ Fait :
  - `src/daemon/avis/service.ts` remplace `SwairmAsk`. Ce dernier est supprimé avec son test, et `/api/swairm/ask*` ne lance plus le binaire `swairm` ;
  - le filtre `nettoyer` passe sur la question et les sous-questions avant tout lancement. Un refus ne rend que la classe ; l'écran et le CLI ajoutent « question refusée » ;
  - la validation accepte les noms historiques et `<fournisseur>:<modele>`, où `defaut` laisse le CLI choisir ;
  - `routage` dans `defaults.yml` et le schéma, avec la table du code (`src/shared/routage.ts`) alignée par un test ;
  - `aid avis`, avec `--challenge` et les codes 0, 4, 3 et 2.

  Gate 4 721 : la garde des noms veut l'index à jour quand un fichier est supprimé.

### 66.4 Le noyau et la fiche (DM49)

- `kernel/roles/plan.md` : la règle du challenge.
- `kernel/commands/sync.md` : la migration de `models` vers `routage`.
- L'adaptateur `kernel/adapters/avis.md`, et le changelog.
- La fiche de recette, remplacée au 66.7 par le job `contrat-cli` et la marque « non vérifié ».

- _Révision 66.4 de DM47._ `models` reste la configuration des agents.
  `routage` sert aux avis et à la future boucle. Il est hérité de
  `defaults.yml` et un projet ne le surcharge que s'il s'en écarte.
  `/sync` ne migre pas `models`.

  Fait : la règle du challenge dans le rôle plan, avec les codes 0, 4, 3 et 2, et l'adaptateur `kernel/adapters/avis.md`. `sync.md` dit que `routage` est hérité. Le changelog est à jour, et la fiche a neuf contrôles. Aucun bloc rendu ne change : le rôle plan et les adaptateurs n'y sont pas. Gate 4 721.

### 66.5 Les e2e

L'e2e complet du point 66.4 a montré 5 échecs, tous dus au passage du binaire `swairm` au service interne :
- trois sont les modes de `swairm-ask.spec.ts` ;
- deux (`audit-essai.spec.ts` et `visuel-ecrans.spec.ts`) attendaient une demande archivée que fournissait le faux swairm.

- _Révision 66.5._ Fait :
  - un faux `claude` d'avis (`test/fixtures/fake-avis/`), dans le PATH du seul daemon de `swairm-ask.spec.ts` ;
  - le mode `refus` passe par le filtre : il vérifie qu'aucune archive n'est écrite ;
  - une demande archivée est déposée dans `<AID_HOME>/avis/` par `e2e/audit/environnement.ts` ;
  - le faux swairm garde `--version` et `cell`, et `test/fixtures/swairm/ask-aucun.json` est retiré.

  Un défaut d'écran est corrigé par cell-gestion : dans `TableauAvis.tsx`, la cellule d'accord ne revient plus à la ligne. Avec les en-têtes plus longs (`claude:sonnet — echec`), « insuffisant » se coupait, et la garde visuelle le refusait. Gate 4 721.

### 66.6 La revue du lab

Le lab a relu la PR au head 79470af, en lisant le code. Ce point corrige ce qu'il demande avant le merge, et les défauts bas qui coûtent peu. Les trous de `nettoyage.ts`, déjà présents avant ce chantier, vont dans un chantier à part.

- **L'environnement des CLI (haut).** Chaque fournisseur reçoit un environnement en liste blanche : `PATH`, `HOME`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `XDG_*`, et la variable de configuration propre à sa CLI (par exemple `CODEX_HOME`). Rien d'autre ne passe, ni jeton, ni URL de base, ni secret du daemon.
- **codex sans outil.** Décision de Julien du 25 novembre : codex reste fournisseur d'avis. Le lanceur ignore sa configuration utilisateur avec `--ignore-user-config`, passe `--disable` pour les fonctionnalités d'exécution, de navigation et d'accès aux services relevées par `codex features list`, et fixe `web_search="disabled"`. Le processus démarre dans un dossier temporaire vide avec `--sandbox read-only`. Limites : codex peut encore lire le disque en lecture seule si une question l'y pousse ; la question passe par `nettoyer`, l'environnement est en liste blanche, et la sortie n'est jamais exécutée. D'après la documentation de codex, la désactivation de `unified_exec` par l'utilisateur est ignorée : un outil d'exécution peut donc rester, dans le bac à sable en lecture seule. La liste des fonctionnalités suit codex 0.172.0 : une version qui n'en connaît pas une refuse de se lancer, et l'avis codex échoue au lieu de partir avec ses outils.
- **Les hôtes privés.** `nettoyer` reçoit une liste d'hôtes privés lue dans la configuration du daemon, et refuse par défaut les suffixes `.internal`, `.local`, `.lan`, `.corp`, `.home.arpa` et `.cluster.local`, en plus de `.ts.net`.
- **Une réponse vide n'est pas un avis.** Un avis sans aucun verdict valide est `invalide`, et `resultatAvis` ne le compte pas comme `ok`.
- **Le lancement qui ne se ferme pas.** Le lanceur se résout à la sortie du processus, avec un délai de grâce, même si un petit-enfant garde la sortie ouverte. Le service se libère toujours.
- **La question par stdin.** claude et vibe reçoivent la question par l'entrée standard quand leur CLI le permet, comme codex, et la question et ses sous-questions ont une taille plafonnée.
- **Les échecs nommés.** Sans `--json`, `aid avis` dit si la CLI manque, a dépassé le délai, ou a échoué. La sortie d'une CLI est bornée.
- **Hors de ce point.** Les options réelles de vibe sont vérifiées en CI au 66.7.
- _Révision 66.6._ Une passe Codex. Les constats 1 (sauf les outils de codex), 2, 4, 5, 6, 7 et le plafond du 8 sont corrigés, chacun avec un test rouge avant le correctif : dix-huit cas Vitest et un cas Playwright (l'hôte privé refusé par le daemon, sans lancement ni archive). Pour codex, l'aide documente `--ignore-user-config` (sans les serveurs MCP de l'utilisateur) et `--disable <feature>`, mais aucune option qui coupe tous ses outils d'un coup, comme `--tools ""` pour claude : `codex features list` en compte plusieurs dizaines. Décision remontée à Julien. Gate 4 739, e2e d'avis 5 sur 5.

- _Révision 66.6, suite._ Une passe Codex, après le choix de Julien de garder codex et de le durcir. L'argv de codex gagne `--ignore-user-config`, un `--disable` par fonctionnalité d'exécution, de navigation ou de service relevée dans `codex features list`, et `web_search="disabled"`. Le dossier de travail est vide, testé. Les limites sont écrites plus haut. Gate 4 737 hors les deux échecs connus du bac à sable Codex, e2e d'avis 5 sur 5.

### 66.7 Les flags des CLI vérifiés en CI, à la place de la recette

Julien ne fait plus de recette manuelle (26 novembre) : « les tests front, back et les tests e2e et scénarisés d'interface doivent le couvrir ». La fiche de la tour est remplacée par deux choses.

- **Un job de CI, `contrat-cli`.** Il installe des versions épinglées de `codex` et de `vibe`, sans compte ni secret, et lit leur aide (`--help` de chaque sous-commande utilisée). Un test lit l'argv que construit `fournisseurs.ts` pour chaque fournisseur, et vérifie que chaque option figure dans l'aide de la version épinglée. Une option absente fait échouer le job. Il en va de même d'une option dont l'aide dit qu'elle attend une valeur, quand l'argv n'en donne pas. Hors de ce job, le test est sauté. L'adaptateur s'aligne sur ce que le job établit.
- **vibe reste « non vérifié »** tant qu'aucun avis réel n'a abouti. Le daemon garde, par fournisseur, la date du premier avis réel qui rend une réponse lisible. L'écran d'avis et `aid avis` marquent « non vérifié » un fournisseur qui n'a pas de date, sans le bloquer. Un e2e montre la marque, puis son retrait après un avis réussi d'un faux binaire.

Ce que la CI ne vérifie pas, faute de compte : une vraie réponse de chaque fournisseur. La marque « non vérifié » rend cette limite visible.
- _Révision 66.7._ Une passe Codex, quatorze lignes existantes modifiées dans le chantier. Le contrat de codex est joué en local sur la vraie aide de la 0.172.0 ; celui de vibe est réservé à la CI, faute de vibe sur le serveur. Les captures du formulaire, avant et après, en 1280 × 800 et en 390 × 844, sont revues : la marque se lit et disparaît. Les cadres du formulaire, au style par défaut, existaient déjà avant ce point. e2e ciblé 5 sur 5, `gate:e2e` 190 sur 191 (un délai de `branche-creer`, vert seul). Mon gate : 4 742, et un délai de `cartes-reliees` sous charge, vert seul (63 sur 63).

## 5. Pièges

- **Un avis n'a pas d'outil.** Un `codex exec` sans `--sandbox read-only` dans un répertoire vide pourrait écrire ou lancer des commandes. Le test vérifie l'argv exact.
- **Le texte d'une question ne passe dans aucun journal**, comme dans Swairm (« Aucun texte de question ou de réponse ne passe dans les journaux »).
- **Les flags de `vibe`** ne sont pas vérifiables sur le serveur, où `vibe` n'est pas installé. Le job `contrat-cli` les vérifie sur la version épinglée (66.7).

## 6. Fini quand

- `aid avis --challenge "<question>"` rend trois avis, de trois fournisseurs, et un tableau d'accord, dans l'e2e avec de faux binaires ; les flags passent le job `contrat-cli`.
- L'écran d'avis d'A-I-D marche sans le binaire `swairm`.
- Le rôle plan sait challenger une décision structurante et remonter un désaccord.

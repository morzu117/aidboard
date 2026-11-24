# Chantier 66 : des avis de plusieurs fournisseurs, par leurs CLI d'abonnement

| Champ | Valeur |
|---|---|
| État | **Révision 0, 24 novembre 2026.** Sujet « routage des modèles » de la note d'idéation de Julien du 17 novembre (§3 quinquies). Arbitrage de Julien du 24 novembre : les autres fournisseurs passent par les CLI d'abonnement déjà installés (`claude`, `codex`, `vibe`), sans clé d'API ni agrégateur. |
| Emplacement final | `docs/chantiers/66-avis-multi-fournisseurs.md` sur `main` |
| Base | `main` |
| Organisation | Comme au 63 : cell-gestion gère le chantier, Codex CLI écrit le code et les tests, cell-gestion relit, lance le gate, commite et ouvre la PR. |
| Validation | Le gate est vert à chaque point, puis `gate:e2e`. La recette se fait sur la tour, où sont les trois CLI. Le merge se fait sur le oui de Julien, CI verte. |

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
- Un modèle se nomme comme le CLI l'accepte : `--model` pour claude, `-m` pour codex, `--agent` ou `--model` pour vibe, selon ce que la recette établira.

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
- La fiche `docs/recette-chantier-66-avis-multi-fournisseurs.md`, sur la tour. Elle établit les flags exacts de `vibe` et de `codex`, lance un challenge réel sur une question factice, et vérifie l'écran.

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

## 5. Pièges

- **Un avis n'a pas d'outil.** Un `codex exec` sans `--sandbox read-only` dans un répertoire vide pourrait écrire ou lancer des commandes. Le test vérifie l'argv exact.
- **Le texte d'une question ne passe dans aucun journal**, comme dans Swairm (« Aucun texte de question ou de réponse ne passe dans les journaux »).
- **Les flags de `vibe`** ne sont pas vérifiables sur le serveur, où `vibe` n'est pas installé. La fiche les établit sur la tour, et l'adaptateur s'aligne si besoin, dans un commit de recette.

## 6. Fini quand

- `aid avis --challenge "<question>"` rend sur la tour trois avis, de trois fournisseurs, et un tableau d'accord.
- L'écran d'avis d'A-I-D marche sans le binaire `swairm`.
- Le rôle plan sait challenger une décision structurante et remonter un désaccord.

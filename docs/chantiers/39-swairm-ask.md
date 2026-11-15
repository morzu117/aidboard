# Chantier 39 : `swairm ask --n N` et le tableau d'accord et de désaccord

| Champ | Valeur |
|---|---|
| État | **Révision 0, 9 novembre 2026.** Julien a retenu Q1 à Q5, Q7 et Q8 de la spec ; Q8 donne Claude seul. Le lab a relu le nettoyage et la règle 4 (DM 92943). Q6, la première question à essayer, reste ouverte : elle ne sert qu'à la recette réelle. |
| Emplacement final | `docs/chantiers/39-swairm-ask.md` sur `main` d'aidboard. La partie Swairm est reprise dans `docs/chantiers/08-swairm-ask.md` de `morzu117/swairm`. |
| Dépôts | `morzu117/swairm`, pour 39.1 à 39.3, puis `morzu117/aidboard`, pour 39.4 à 39.6. |
| Spec | `specs/ask-39.md`, révision 1, avec la décision Q8 (dossier de travail, hors dépôt). |
| Organisation | Comme au 38. cell-gestion gère le chantier. Codex CLI écrit le code et les tests de chaque point. cell-gestion relit, lance les vérifications, commite et ouvre les PR. |
| Validation | Julien valide le 39, après sa recette sur le Mac. Le lab relit le nettoyage (39.1). Le merge suit la règle de Julien : la CI verte. |

## 1. Pourquoi

Avoir un deuxième avis : la même question part à N agents Claude indépendants, et A-I-D montre, sous-question par sous-question, où ils s'accordent et où ils divergent. Ce sont les blocs 7 et 8 du plan d'architecture, et l'étape 3 du plan du lab (88351).

## 2. État actuel

| Zone | Où | Ce qui existe |
|---|---|---|
| Le CLI | `swairm/scripts/swairm.py`, `docs/cli-swairm.md` | `status`, `inbox` et `events`, en lecture seule, avec un JSON versionné `swairm-…/1`. Les codes de sortie sont 0, 2 et 3. |
| Le lancement de Claude | `swairm/spawning_pool/claude_runner.py` | `build_command()` pour `claude -p`, `drone_flags()` pour le budget et le MCP fermé, et l'enveloppe `--output-format json` qui donne le coût et le modèle servi (`spawning_pool/usage.py`). |
| La facturation | `swairm/spawning_pool/billing.py` | `strip_api_credentials()` retire les clés d'API, et le CLI retombe sur l'abonnement. |
| Les tests | `swairm/tests/test_swairm_cli.py` | Pytest, avec un faux `claude` dans `PATH` ailleurs (`tests/test_claude_runner*`). |
| A-I-D | `src/daemon/…`, `web/src/ecrans/Swarph.tsx` | Rien sur Swairm, hormis la cell interactive du 14 (`docs/chantiers/14-cell-swairm.md`). |

## 3. Cible et hors-périmètre

**Cible.**
- `swairm ask` : N avis indépendants, sans outil, sur l'abonnement de Julien, avec une sortie `swairm-ask/1`.
- Dans A-I-D : la boîte « Demander N avis », le tableau, et la réouverture des dernières demandes.

**Hors-périmètre.**
- Codex (Q8).
- Le pilotage de Swairm (`run`, `dispatch`, `promote`).
- La question posée à N cells du mesh (40).
- Les sujets Swairm en cartes (41).
- Toute écriture sur un board.

## 4. Décisions

### D244. `swairm ask` : la seule commande qui coûte

```
swairm ask --n N [--modeles sonnet,opus] [--budget USD] --question-file F --json
```

- **Les paramètres.**
  - N vaut 3 par défaut, et 5 au plus. Une valeur hors de 1 à 5 donne le code 2.
  - `--modeles` vaut `sonnet,opus` par défaut, et les modèles sont attribués en tourniquet. Seuls les alias `sonnet`, `opus` et `haiku` sont admis.
  - `--budget` vaut 0,50 USD par avis par défaut, et 2 USD au plus. Il passe par `--max-budget-usd`.
- **La documentation.** `docs/cli-swairm.md` reçoit une section à part : « La seule commande qui coûte. » Le préambule « il ne fait que regarder » reste vrai pour `status`, `inbox` et `events`, et il le dit.
- **Les codes de sortie.**
  - 0 si au moins un avis est valide.
  - 2 pour un usage invalide ou une question refusée par le nettoyage.
  - 3 si aucun avis n'est valide.

### D245. Le nettoyage avant envoi (lab, N1 et N3)

- **Les motifs de secrets.** On reprend tels quels les motifs de swarph-cli : `scrub.py` (`_SECRET_PATTERNS`) et `redact.py` (les tables, et les jetons isolés à forte entropie). swarph-cli est public, sous licence MIT.
  - Ils sont copiés dans `swairm/oracle/nettoyage.py`, avec la source et le commit en commentaire. Swairm ne dépend pas de swarph-cli.
  - Un test vérifie chaque motif.
- **Les hôtes et les adresses**, qui s'ajoutent :
  - `*.ts.net` ;
  - en IPv4, `100.64.0.0/10`, `10.0.0.0/8`, `172.16.0.0/12` et `192.168.0.0/16` ;
  - en IPv6, `fd7a:115c:a1e0::/48` et `fc00::/7` ;
  - les noms d'hôte que Julien déclare dans `~/.swairm/ask.yml` (`hotes_prives: []`), un fichier optionnel.
- **Le refus est net.** Le message nomme la classe, par exemple « ressemble à une clé API » ou « adresse privée ». Il ne recopie jamais le texte trouvé, ni à l'écran, ni dans le fichier de résultat. Une question refusée n'est pas gardée.

### D246. Les avis, sans aucun outil (lab, N2)

- **La commande de chaque avis** :

  ```
  claude -p <prompt> --tools "" --setting-sources "" --strict-mcp-config --disable-slash-commands --permission-mode dontAsk --model <m> --max-budget-usd <b> --output-format json
  ```

  - **Pas de `--bare`** : il saute le trousseau du Mac, où vit le login de l'abonnement.
  - **Pas de `--mcp-config`**.
  - L'environnement passe par `strip_api_credentials()`.
  - Le dossier de travail est un dossier temporaire vide, supprimé après l'avis.
- **Le prompt** est fixe, versionné dans le code, et il contient :
  - la question ;
  - la consigne de répondre en JSON seul : `{"reponses": [{"n": 1, "verdict": "oui|non|nuance|ne_sait_pas", "justification": "…"}]}` ;
  - l'interdiction de supposer un contexte qui n'est pas dans la question.
- **Les avis tournent en parallèle**, chacun avec un délai de 180 s. Un avis qui dépasse son délai, son budget, ou qui sort en erreur, reçoit l'état `echec`, `budget` ou `delai`. Il n'est pas relancé.

### D247. Les sous-questions et l'accord

- **Le découpage en sous-questions.** Il est fait par une fonction pure, sur les lignes qui commencent par `N.` ou `N)`. Sans numérotation, le texte entier est la sous-question 1. On compte 12 sous-questions au plus.
- **La lecture des réponses.** Une réponse se lit par `json.loads` sur le premier objet JSON du texte rendu. Le texte est ensuite vérifié :
  - un verdict hors de la liste fermée donne une réponse `invalide` ;
  - une sous-question manquante donne `manquant` pour cette case ;
  - la justification est coupée à 600 caractères.
- **L'accord**, pour chaque sous-question, se calcule sur les seuls verdicts valides :
  - `unanime` si tous les verdicts sont identiques et qu'il y en a au moins 2 ;
  - `majorite` si un verdict a strictement plus de la moitié ;
  - `partage` sinon ;
  - `insuffisant` s'il y a moins de 2 verdicts valides.
  - Il n'y a ni pondération ni score.

### D248. La sortie `swairm-ask/1` et le fichier de résultat

```json
{
 "format": "swairm-ask/1",
 "id": "20261109T071500Z-3f2a",
 "genere_a": "…",
 "question": "…",
 "sous_questions": [{"n": 1, "texte": "…"}],
 "avis": [{"i": 1, "modele_demande": "sonnet", "modele_servi": "…", "etat": "ok", "cout_usd": 0.04, "duree_s": 21.3,
           "reponses": [{"n": 1, "verdict": "oui", "justification": "…"}], "brut": null}],
 "accord": [{"n": 1, "accord": "majorite", "verdict": "oui", "compte": {"oui": 2, "non": 1}}],
 "cout_total_usd": 0.12
}
```

- **Les champs.**
  - `brut` contient le texte rendu, coupé à 4 000 caractères, seulement quand l'avis est `invalide`.
  - L'enveloppe de Claude n'est pas recopiée, en dehors du coût, du modèle et de la durée.
- **Le fichier de résultat.**
  - Le même JSON est écrit dans `~/.swairm/asks/<id>.json`, avec le mode 0600, dans un dossier 0700.
  - `swairm ask --list --json` rend `swairm-asks/1`, les 20 dernières demandes : `id`, `genere_a`, la question coupée à 200 caractères, N et l'accord résumé.
  - `swairm ask --show <id> --json` relit une demande.
  - L'`id` est validé par `^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4}$`.

### D249. A-I-D lance `swairm ask` comme il lance swarph

- **Le lecteur.** Un lecteur `SwairmAsk` (`src/daemon/swairm/ask.ts`) :
  - lance le binaire `swairm`, dont le chemin vient de la config d'A-I-D, avec la valeur par défaut `swairm` dans le `PATH` ;
  - n'a jamais de shell, passe ses arguments en tableau, et attend 600 s au plus ;
  - écrit la question dans un fichier temporaire 0600, supprimé après l'appel.
- **Les routes**, toutes locales et jamais réexposées en mode host :
  - `POST /api/swairm/ask {question, n, modeles}` ;
  - `GET /api/swairm/asks` ;
  - `GET /api/swairm/asks/:id`.
- **Les règles du POST.**
  - Il refuse une seconde demande tant qu'une première est en cours (409).
  - « Annuler » envoie `SIGTERM` au processus.
  - Il exige un en-tête `X-AID-Confirm: ask`, que la boîte pose seulement au clic. Un fetch fortuit ne déclenche donc rien : c'est le geste humain de la règle 1.
- **Les réponses**, discriminées comme D95 :
  - les états propres sont `absent`, `too-old` (`ask` manquant, code 2 sur `invalid choice`), `refusee` (code 2 avec le message du nettoyage), `aucun-avis` (code 3), `timeout` et `format` ;
  - le message du nettoyage est rendu tel quel : il ne contient jamais le texte trouvé (D245).

### D250. La boîte et le tableau

- **La boîte.** L'écran Swarph reçoit, si `swairm` est présent, un bouton « Demander N avis » (`data-node="swarph.ask"`). Il ouvre la boîte `DemanderAvis`, qui contient :
  - le texte, qu'on peut numéroter ;
  - N, de 1 à 5 ;
  - les modèles ;
  - le coût maximal, N × le budget ;
  - le rappel : « Le texte part chez le fournisseur de Swairm. N'y mets ni secret ni contenu de carte. »
  - « Envoyer » est désactivé si le texte est vide. Pendant l'attente, la boîte affiche le temps écoulé et un bouton « Annuler ».
- **Le tableau** (`TableauAvis`) :
  - une ligne par sous-question, une colonne par avis, avec le modèle servi en tête ;
  - chaque case montre une pastille de verdict, et la justification se déplie ;
  - la colonne « Accord » vient en dernier ;
  - les lignes `partage` sont en tête, puis `majorite`, puis `unanime`, et le tri se change ;
  - le coût total s'affiche en pied ;
  - tout est en texte React, sans Markdown ni lien.
- **Les dernières demandes** sont une liste sous le bouton, et une demande se rouvre en lecture.

## 5. Points

### 39.1 Le nettoyage et les sous-questions (swairm, D245, D247)

`oracle/nettoyage.py` et `oracle/ask_sous_questions.py`, en fonctions pures, avec `tests/test_ask_nettoyage.py` et `tests/test_ask_sous_questions.py`. Les tests couvrent :
- chaque motif, et chaque plage d'IP ;
- un nom `.ts.net` ;
- un hôte déclaré ;
- l'absence de faux positif sur un texte ordinaire avec des chiffres ;
- un message de refus qui ne contient jamais le texte trouvé ;
- le découpage, avec ou sans numéros, et la limite de 12 ;
- l'accord dans chaque cas.

**Le lab relit ce point avant le commit.**

### 39.2 Les avis sans outil (swairm, D246)

`spawning_pool/ask_runner.py`, et un faux `claude` dans les tests (`tests/test_ask_runner.py`). Les tests couvrent :
- l'argv exact : `--tools ""`, `--setting-sources ""`, `--strict-mcp-config` sans `--mcp-config`, `--disable-slash-commands`, `--permission-mode dontAsk`, et ni `--bare` ni `--allowedTools` ;
- l'environnement sans clé d'API ;
- le dossier vide, supprimé ensuite ;
- le parallélisme ;
- le délai, le budget, une sortie invalide et la lecture du premier objet JSON.

### 39.3 La commande et sa sortie (swairm, D244, D248)

`scripts/swairm.py`, avec `ask`, `--list` et `--show`, le format `swairm-ask/1`, les fichiers dans `~/.swairm/asks/` avec leurs modes, les codes de sortie, la section de `docs/cli-swairm.md` et `docs/chantiers/08-swairm-ask.md`. Les tests vont dans `tests/test_swairm_cli.py`, avec le faux `claude`.

### 39.4 Le lecteur et les routes (aidboard, D249)

`src/daemon/swairm/ask.ts`, `src/daemon/routes/swairm.ts`, et un faux `swairm` dans `test/fixtures/fake-swairm.sh`. Les tests couvrent :
- chaque état ;
- le 409 ;
- l'annulation ;
- un `X-AID-Confirm` absent, qui donne 403 sans rien lancer ;
- le fichier temporaire supprimé ;
- le 404 en mode host.
- *Révision 39.4.* `SwairmAsk` lance `[bin, 'ask', '--n', N, '--modeles', m, '--question-file', F, '--json']`, sans `--budget` : le budget de swairm par défaut, 0,50 USD, est exposé en `BUDGET_ASK_USD`. Un `swairm.bin` vide prend `swairm` dans le `PATH`, et la cell garde son comportement. `GET /api/swairm/ask/etat` rend `{enCours, depuis, budgetUsd}` pour la boîte. `annule` est un état en plus de ceux de D249. Gate 2517.

### 39.5 La boîte et le tableau (aidboard, D250)

`web/src/ui/DemanderAvis.tsx`, `web/src/ecrans/TableauAvis.tsx` et `web/src/data/swairm.ts`. Les tests couvrent :
- le coût maximal ;
- le bouton désactivé ;
- le tri ;
- une justification avec `<img src=x onerror=alert(1)>`, rendue en texte ;
- les états.
- *Révision 39.5.* `api()` et `AidClient.request` acceptent des en-têtes optionnels, utilisés seulement par `demanderAvis` (1 ligne modifiée). `ui/DemandesAvis.tsx` porte le bouton et la liste sur l'écran Swarph. L'état de la demande et la liste reprennent la mécanique de relecture du Board. Fermer la boîte n'annule pas la demande : en la rouvrant, l'attente en cours s'affiche. Gate 2533.

### 39.6 L'e2e et la fiche de recette (aidboard)

- `e2e/swairm-ask.spec.ts`, sur le faux `swairm`.
- `docs/recette-chantier-39-ask.md`, pour Julien, sur son Mac et son abonnement. La fiche couvre :
  - la question de la Q6 ;
  - le coût réel comparé au plafond ;
  - une question volontairement refusée, par exemple avec une fausse clé ;
  - la vérification qu'aucun avis n'a touché au disque.
- *Révision 39.6.* Trois e2e, un daemon par mode du faux swairm. La fiche de recette ne contient que des formes génériques, et la fausse clé y est écrite en `X`. **Correction du 39.4 :** SIGTERM ne visait que swairm, alors que Python ne le relaie pas à ses enfants. `SwairmAsk` lance donc swairm par `spawn`, avec `detached`, dans son propre groupe, et `annuler()` comme le délai envoient `SIGTERM` à `-pid`. Le test `annuler arrête aussi les petits-enfants` le vérifie (faux swairm en mode `enfant`). La sortie est bornée à 4 Mio, et au-delà, l'état est `format`. Gate 2534, e2e 121.

## 6. Pièges

- **`--allowedTools ""` pré-autorise et ne retire rien.** Seul `--tools ""` coupe les outils. Le test de l'argv est la vraie protection.
- **`--setting-sources ""` coupe les hooks.** Sans lui, les hooks de Julien tourneraient pour chaque avis.
- **`--bare` casserait l'abonnement sur le Mac.**
- **Les modèles servis** peuvent différer des alias demandés. Le tableau affiche le modèle servi, lu dans l'enveloppe.
- **Les justifications viennent d'un modèle.** Elles s'affichent en texte seul, comme tout contenu étranger (invariant 9).
- **Les deux dépôts.** aidboard ne dépend que du contrat `swairm-ask/1`. Le faux `swairm` le reproduit, et un champ nouveau ne casse rien.

## 7. Fini quand

- 39.1 à 39.3 sont mergés dans swairm. Le lab a relu 39.1, et pytest et ruff sont verts.
- 39.4 à 39.6 sont commités dans aidboard, avec le gate et l'e2e verts.
- La CI est verte des deux côtés.
- La recette de Julien est faite.

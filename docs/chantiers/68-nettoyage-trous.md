# Chantier 68 : boucher les trous du filtre `nettoyer`

| Champ | Valeur |
|---|---|
| État | **Révision 0, 25 novembre 2026.** Julien a dit oui le 25 novembre pour un chantier à part, après la revue du lab sur la PR #211 (chantier 66). |
| Emplacement final | `docs/chantiers/68-nettoyage-trous.md` sur `main` |
| Base | `main` (2427d91) |
| Organisation | cell-gestion gère le chantier ; Codex CLI écrit les tests et le code. Chaque point testable passe d'abord par une session de testeur, puis par une session de dev distincte (chantier 67, DM53). |
| Dépend de | Rien. La phase `acceptation` du chantier 67 (#212) n'est pas encore sur `main` : voir DM61. |
| Validation | Le gate est vert à chaque point. Relecture du lab, car c'est la barrière avant les fournisseurs externes. Merge sur le oui de Julien, CI verte. |

## 1. Pourquoi

`src/shared/nettoyage.ts` est la seule barrière entre un texte d'A-I-D et un service externe : une question d'avis envoyée à trois fournisseurs (chantier 66), un DM vers le comité, une écriture confirmée. Il refuse un texte qui ressemble à un secret, ou qui nomme un hôte ou une adresse privés.

En relisant la PR #211, le lab a trouvé six familles de textes qui passent alors qu'ils ne devraient pas. Ces trous existaient avant le chantier 66 : ce chantier les bouche, sans toucher aux appelants.

## 2. Cible et hors-périmètre

**Cible.** Les motifs et les exemptions de `nettoyer`, et leurs tests, y compris les familles ajoutées par le lab à la lecture du plan (DM62).

**Hors-périmètre.**
- Les appelants de `nettoyer`, et ce qu'ils lui passent (les hôtes privés par défaut du service d'avis sont dans le 66.6).
- Le module d'origine dont `nettoyage.ts` est le portage. Le signaler en amont est une décision à part de Julien.
- Un filtre par modèle. `nettoyer` reste mécanique.

## 3. Décisions

### DM58. Les affectations de secret

- **Jamais plus permissif.** Ce chantier ne rend `nettoyer` plus permissif nulle part : un texte que la base refuse reste refusé. Les exemptions ci-dessous ne valent que pour les refus nouveaux. Ainsi `password=test` et `password: <mot-de-passe>`, refusés aujourd'hui, le restent.
- Une clé dont le dernier segment, séparé par `_` ou `-`, est `password`, `passwd`, `pwd`, `passphrase`, `secret`, `token`, `key`, `credential` ou `credentials` est une **clé de secret**, quelle que soit la casse et quel que soit son préfixe : `DB_PASSWORD`, `POSTGRES_PASSWORD`, `SECRET_KEY`, `api_token`, `access_token`, `refresh_token`, `client_secret` et `private_key` le sont.
- La clé peut être entre guillemets, comme en JSON, YAML ou TOML : `"password": "hunter2"`, `'secret': '…'`, `"api_key" = "…"`.
- `<clé de secret> = <valeur>` ou `<clé de secret>: <valeur>`, la valeur avec ou sans guillemets, est refusé dès que la valeur a quatre caractères ou plus et n'est pas une valeur d'exemple.
- Une valeur hexadécimale n'est plus exemptée derrière une clé de secret. Elle le reste ailleurs : un sha de commit cité seul, ou derrière `commit`, `head` ou `base`, passe.
- Une **valeur d'exemple** est une valeur **égale** à un mot de la liste d'exemples (`example`, `test`, `none`, `true`, `changeme`…), à la casse et aux guillemets près, ou une valeur entre chevrons comme `<mot-de-passe>`. Une valeur qui **contient** l'un de ces mots n'est plus exemptée pour autant.

### DM59. Les formes qui passent à côté des motifs

- **Les URL avec identifiants.** `schéma://utilisateur:motdepasse@hôte` est refusé aussi quand l'utilisateur est vide (`redis://:pw@h`) et quand le mot de passe contient `/`, `:` ou `@` encodé.
- **Les clés privées.** Un en-tête `-----BEGIN … PRIVATE KEY…-----` suffit au refus, avec ou sans pied, et quelle que soit la suite du titre : `BEGIN PGP PRIVATE KEY BLOCK` est refusé.
- **Les caractères invisibles.** Tous les caractères de format Unicode (`\p{Cf}`, dont U+00AD) sont retirés avant le contrôle, et pas seulement la liste actuelle.
- **Les adresses collées à un mot.** `host:10.0.0.5`, `ip=192.168.1.2` et `[fd00::1]` sont refusés : le candidat d'adresse est pris sans le préfixe qui le colle.

### DM62. Les autres porteurs de secret

Relevés par le lab à la lecture du plan.

- **Les en-têtes.** `Authorization:` suivi de `Basic`, `Token` ou de tout autre schéma et d'une valeur, `Cookie:` et `Set-Cookie:` avec une valeur sont refusés, comme `Bearer` aujourd'hui.
- **Les paramètres d'URL.** Un paramètre de requête dont le nom est une clé de secret (DM58), ou `sig`, `signature`, `X-Amz-Signature` ou `X-Amz-Credential`, est refusé dès qu'il a une valeur : `?access_token=…`, `&sig=…`.
- **Les URL de webhook.** Une URL dont le chemin est lui-même le secret est refusée : les webhooks Slack (`hooks.slack.com/services/…`) et Discord (`…/api/webhooks/<id>/<jeton>`).
- **Les préfixes connus.** `ya29.` (OAuth Google), `AGE-SECRET-KEY-1`, `dop_v1_`, `SG.` suivi de deux segments, `xapp-`, et le jeton de bot Telegram (`<8 à 10 chiffres>:AA<33 caractères>`), avec une longueur minimale qui exclut les mots courants. `sk_test_` et `rk_test_` aussi, comme `sk_live_`.

### DM60. Les faux positifs se mesurent

Un filtre plus strict refuse plus. Les appelants actuels (comité, écritures confirmées, avis) ne doivent pas se mettre à refuser des textes légitimes.

- Le corpus de contrôle est l'ensemble des fichiers Markdown suivis de `docs/` et de `kernel/` : ils sont publics, et ne contiennent aucun secret.
- Le dev lance `nettoyer` sur chaque fichier, par blocs de 20 000 caractères, à la base et à la tête. La liste des fichiers refusés et leur classe vont dans la note de révision.
- Un fichier refusé à la tête et pas à la base est soit un vrai trou (le fichier cite un secret d'exemple trop réaliste, et la note le dit), soit un faux positif à corriger avant le commit.

### DM61. La phase `acceptation` avant son merge

Le chantier 67 n'est pas encore sur `main`. Jusqu'à son merge :
- les sessions de testeur et de dev suivent le DM53 du 67 ;
- cell-gestion contrôle les commits marqués avec `aid acceptation verifier` et `couverture`, pris d'une copie construite de la branche du 67 ;
- `preuve` ne peut pas lancer vitest sans le `acceptation.lancer` du 67 : cell-gestion lance le fichier d'acceptation à la main, au commit marqué puis à la tête, et note les deux résultats ;
- si le 67 est mergé avant ce chantier, la branche reprend `main` et `aid acceptation preuve` remplace le contrôle à la main.

## 4. Points

### 68.1 Le plan

Ce document, et une ligne dans `README.md`.

### 68.2 Les affectations de secret (DM58)

Les clés de secret à préfixe, les nouveaux derniers segments, la clé entre guillemets, la valeur hexadécimale derrière une clé de secret, la valeur d'exemple égale et non contenue. Les tests ajoutent les cas qui doivent continuer de passer (un sha de commit seul, `commit=<sha>`, `DB_PASSWORD=example`, `token = example`) et ceux que la base refuse et qui doivent rester refusés (`password=test`, `password: <mot-de-passe>`).

- _Acceptation._ Couvert par `test/shared/nettoyage-affectations.test.ts` (1d24784), trente-cinq cas écrits par le testeur depuis le plan seul, en deux passes : la première a montré que le plan exemptait des textes que la base refuse, d'où la règle « jamais plus permissif ». Refusés : les neuf derniers segments du DM58, avec préfixe, en toute casse, avec `=` ou `:`, la clé et la valeur entre guillemets, en YAML et en JSON multilignes, la valeur hexadécimale et la valeur qui contient un mot d'exemple. Qui passent : un sha seul ou derrière `commit`, `head` et `base`, `DB_PASSWORD=example`, `token = example`, une valeur vide ou de trois caractères, une clé dont le segment de secret n'est pas le dernier. Échec attendu au commit marqué : seize cas refusés que la base laisse passer, sur une assertion. Les neuf refus existants et les dix textes qui passent sont déjà verts. Laissé ouvert : un saut de ligne entre la clé et sa valeur.
- _Révision 68.2._ Une passe du testeur en deux temps, puis une passe du dev en deux temps : la première version exemptait trois phrases précises du corpus, remplacées par des règles générales (références, modes de `credentials`). Preuve à la main (DM61) : le fichier d'acceptation rend 16 échecs et 19 réussites au commit marqué, et 35 réussites à la tête. Mesure « jamais plus permissif » : aucun texte refusé par la base n'est accepté. Nouveau refus sur le corpus : une ligne de `docs/chantiers/README.md` (« absence de token : requête rejetée »), faux positif connu, gardé pour la mesure du DM60. Gate 4 733.

### 68.3 Les formes qui passent à côté (DM59)

Les URL avec un utilisateur vide ou un mot de passe à `/`, l'en-tête PGP et l'en-tête sans pied, U+00AD et les autres caractères de format, les adresses collées à un mot. Les tests ajoutent les cas qui doivent continuer de passer : `https://example.com/a:b@c` sans identifiants, une adresse publique de documentation (`192.0.2.1`), une heure `10:00:00`.

- _Acceptation._ Couvert par `test/shared/nettoyage-formes.test.ts` (21a45e1), vingt-deux cas écrits par le testeur depuis le plan seul. Refusés comme secret : les URL à utilisateur vide, ou dont le mot de passe contient `/`, `:`, `%40` ou `%3A` ; les blocs PGP avec et sans pied ; l'en-tête OpenSSH seul ; un jeton fabriqué, intact ou coupé par U+00AD, U+2063 ou U+180E. Refusés comme adresse privée : `host:10.0.0.5`, `ip=192.168.1.2`, `[fd00::1]`, `addr=172.16.0.9:8080`. Qui passent : une URL sans identifiants dont le chemin contient `:` et `@`, deux adresses de documentation, une heure, un en-tête de clé publique, un texte français avec une césure. Échec attendu au commit marqué : neuf cas, sur une assertion. Les sept refus existants et les six textes qui passent sont déjà verts.
- _Révision 68.3._ Une passe du testeur, puis une passe du dev. Preuve à la main (DM61) : le fichier d'acceptation rend 9 échecs et 13 réussites au commit marqué, et 22 réussites à la tête. Mesure « jamais plus permissif » : aucun texte assoupli, et aucun nouveau refus sur le corpus. Les motifs élargis (l'URL, la clé privée) sont des sur-ensembles des anciens. Gate 4 755.

### 68.4 Les autres porteurs de secret (DM62)

Les en-têtes, les paramètres d'URL, les URL de webhook, les préfixes connus. Les tests ajoutent les cas qui doivent continuer de passer : `Authorization:` seul dans une phrase, `https://example.com/?page=2`, une URL Discord sans webhook, le mot `SG.` dans une phrase.

### 68.5 La mesure des faux positifs (DM60)

La mesure sur le corpus, à la base et à la tête, et sa conclusion dans la note de révision.

- _Acceptation._ Non testable à l'avance : c'est une mesure sur le corpus du dépôt, qui n'existe qu'une fois le code des 68.2 à 68.4 écrit.

## 5. Pièges

- **Le filtre qui refuse tout.** C'est le DM60. Une heure, une adresse de documentation, un sha et un mot de passe d'exemple doivent continuer de passer.
- **Un vrai secret dans un test.** Les fixtures utilisent des valeurs fabriquées, jamais un jeton réel, et aucun vrai nom d'hôte, de cell ou de projet (gardes 49 et 54).
- **Les doublons de motifs.** `nettoyage.ts` répète déjà plusieurs motifs. Le dev n'en ajoute pas un troisième : il corrige celui qui existe.

## 6. Fini quand

- 68.2 à 68.5 sont mergés, avec la CI verte, la relecture du lab et le oui de Julien.
- La mesure des faux positifs est écrite.

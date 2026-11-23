# Chantier 60 : des pages closes plutôt que supprimées, des liens typés, et une décision en un appel

| Champ | Valeur |
|---|---|
| État | **Révision 0, 23 novembre 2026.** C'est le lot C de la note d'idéation de Julien du 17 novembre (la mémoire), et la recommandation R3 de l'analyse du 16 novembre. Julien a dit oui le 23 novembre, et le gel du périmètre est levé pour ce lot. Le lab a répondu sur la forme des liens (DM 103453, Q1) : le frontmatter, en gardant les `[[liens]]` du corps pour rester compatible avec swarph. |
| Emplacement final | `docs/chantiers/60-memoire-liens-validite.md` sur `main` |
| Base | `main` (`0862794`) |
| Organisation | Comme au 57. cell-gestion gère le chantier ; Codex CLI écrit le code et les tests de chaque point ; cell-gestion relit, lance le gate, commite et ouvre la PR. |
| Dépend de | 06 (la mémoire locale), 57 (l'entretien, le journal d'usage, `remplacee_par` et `doublon_de` posés par l'entretien). |
| Validation | Le gate est vert à chaque point. Le chantier ne touche pas au contrat swarph : la relecture du lab n'est pas requise. Merge sur le oui de Julien, CI verte. |
| Rayon d'impact | `src/daemon/memory/` (`store.ts`, `service.ts`, `maintain.ts`, un nouveau `liens.ts`), `src/daemon/routes/memory.ts`, `src/shared/memory.ts`, `src/cli/commands/mem.ts`, `src/cli/commands/mcp.ts`, `migrations/037_*.sql`, `kernel/policy/namespace.md`, `kernel/adapters/aid.md`, `kernel/roles/`, `kernel/CHANGELOG.md`, et les blocs rendus par `/sync`. Aucun écran. |

## 1. Pourquoi

La mémoire sait garder des pages, pas dire lesquelles sont encore vraies. Trois manques, relevés dans la note du 17 novembre (§6.3 et §9.1) :

1. **Une page remplacée reste trouvée.** L'entretien pose `remplacee_par` (découpage) et `doublon_de` (doublon), mais `memory_search` les rend comme les autres. Un agent peut lire une leçon périmée sans le savoir.
2. **Rien ne relie deux pages.** Une leçon qui en précise une autre, ou qui la contredit, ne le dit nulle part. La recherche ne peut pas ramener la voisine utile.
3. **Une décision n'a pas de forme.** Un agent qui tranche un choix écrit une page libre. S'il remplace une décision plus ancienne, il doit penser à la fermer à la main, et rien ne l'y aide.

La note abandonne le graphe bi-temporel (Graphiti, Neo4j), surdimensionné pour environ 430 pages. Deux champs de frontmatter et une table de liens suffisent.

## 2. État actuel

- `memory_pages` garde le frontmatter en JSON ; `memory_fts` indexe titre, corps et tags ; `memory_vectors` garde les vecteurs (sqlite-vec).
- Le frontmatter est libre. Clés posées par le code : `doublon_de` (une chaîne, par `applyProposal`), `remplacee_par` (une liste, par le découpage), `issu_de` (sur les pages nées d'un découpage), `entretien_rejete`.
- `MemoryStore.searchFts` et `MemoryService.search` ne filtrent rien d'autre que le namespace.
- Le MCP expose `memory_get`, `memory_put`, `memory_search`, `memory_list` et les `index_*`.
- Les pages cycliques `plan/`, `dev-handoff/` et `review/` se purgent après la rétro ; les autres chemins d'un namespace ne sont jamais purgés.

## 3. Cible et hors-périmètre

**Cible.**
- Une page peut être **close** : elle reste lisible, mais la recherche ne la rend plus par défaut, et elle mène à celle qui la remplace.
- Des **liens typés** entre pages, déclarés dans le frontmatter, plus les `[[liens]]` du corps. Une table dérivée les indexe dans les deux sens.
- La recherche rend, à part, les **voisines** d'un saut des pages trouvées.
- Une opération **`decide`** : elle écrit une page de décision et ferme, dans le même geste, les pages qu'elle remplace.

**Hors-périmètre.**
- L'opération `consolidate` et l'extraction depuis les journaux (lot D).
- L'assemblage du contexte par rôle et le classement par poids (lot E).
- La détection automatique des contradictions et l'oubli (lot F). Ici, un lien `contredit` est déclaré, jamais deviné.
- Un écran de la mémoire. Aucun n'existe aujourd'hui, et ce chantier n'en ajoute pas.

## 4. Décisions

### DM19. Une page close reste lisible, et le frontmatter dit pourquoi

- Deux clés nouvelles : `valide_depuis` et `close_le`, chacune une date `AAAA-MM-JJ` ou un instant ISO 8601.
- Une page est **close** si l'une de ces conditions est vraie :
  - elle a `close_le` ;
  - elle a `remplacee_par`, non vide (posé par le découpage) ;
  - elle a `doublon_de` (posé par l'entretien).
- Une page close n'est jamais supprimée par ce chantier. Le miroir garde son fichier.
- Le frontmatter fait foi. L'état clos est une colonne dérivée (`memory_pages.closed`), recalculée à chaque écriture.
- Une écriture par l'API, le CLI ou le MCP refuse en 400 :
  - un `close_le` dans le futur ;
  - une date mal formée ;
  - un `close_le` antérieur à `valide_depuis`.
  Le message nomme la clé fautive. Un fichier relu du miroir (tirage, `reindex`, import) n'est pas refusé pour cela : la date invalide est ignorée et notée au journal du daemon.
- `remplacee_par` accepte désormais aussi une chaîne seule, lue comme une liste d'un élément.

### DM20. Quatre types de lien déclarés, plus les liens du corps

- La clé `liens` est un objet, de type vers liste de slugs :
  ```yaml
  liens:
    precise: [lesson/sqlite/wal-un-ecrivain]
    contredit: [lesson/typescript/strict-partout]
    remplace: [aid/decision/ancien-choix]
    issu_de: [aid/retro/cycle-12]
  ```
- Les quatre types, de la page qui déclare (A) vers la cible (B) :
  - `precise` : A précise B ;
  - `contredit` : A contredit B, et le lien se lit dans les deux sens ;
  - `remplace` : A remplace B ;
  - `issu_de` : A vient de B.
  Aucun autre type n'est admis.
- Les clés existantes deviennent des liens, sans réécrire les pages :
  - `issu_de: X` sur A donne `A issu_de X` ;
  - `remplacee_par: [X]` sur A donne `X remplace A` ;
  - `doublon_de: X` sur A donne `X remplace A`.
- **Les `[[slug]]` du corps** (réponse du lab, DM 103453) sont lus comme un cinquième type, `cite`, sans sens particulier. C'est la forme que swarph lit. Seuls les slugs valides (`MEM_SLUG_RE`) comptent, et les blocs de code sont ignorés.
- Une écriture par l'API refuse en 400 trois cas, avec le type ou le slug fautif dans le message :
  - un type inconnu ;
  - une valeur qui n'est pas une liste de slugs valides ;
  - un lien d'une page vers elle-même.
  Une relecture du miroir ignore le lien fautif et le note au journal. Un slug cible absent est admis (le lien pend) et compté dans la santé.
- **Un lien `remplace` ne ferme pas la cible.** Écrire A ne modifie jamais B. Seule la cible elle-même, par son frontmatter, est close, ou `decide` (DM22). Un `remplace` vers une page ouverte est rendu comme voisin, avec son type.

### DM21. La table dérivée et la recherche

- `memory_links (from_slug, to_slug, type, declared_by)`, clé primaire sur les quatre, index sur `to_slug` et `declared_by`. Elle est dérivée et jamais écrite à la main. `declared_by` est la page dont le frontmatter ou le corps porte le lien : une clé héritée (`remplacee_par` sur A) donne une arête X→A déclarée par A. Une lecture compte chaque arête une fois, quelle que soit la page qui la déclare.
- Elle est recalculée pour une page à chaque `put` et vidée à chaque `remove`, dans la même transaction que la page. `clear()` la vide.
- Au démarrage du daemon, colonne `closed` et table sont recalculées pour toutes les pages, en une transaction (quelques centaines de pages).
- Migration `037_memory_links.sql` : la colonne `closed INTEGER NOT NULL DEFAULT 0` et la table. Elle ne contient aucun remplissage : le recalcul du démarrage s'en charge.
- **La recherche** (FTS et vecteurs) écarte les pages closes, sauf avec l'option `closes` (`?closes=1`, `--closes`, `closes: true`).
  - Une page close qui correspondait mène à ses **remplaçantes ouvertes** : celles qui la remplacent par un lien `remplace`, en suivant la chaîne sur cinq sauts au plus, sans boucle.
  - Une remplaçante est rendue dans `hits` à la place de la page close, avec `via: { slug, type: 'remplace' }`, si elle n'y est pas déjà.
- **Les voisines.** La réponse gagne un champ `voisins`.
  - Ce sont les pages ouvertes reliées d'un saut aux `hits`, dans les deux sens, par `precise`, `contredit`, `issu_de` ou `cite`.
  - Elles sont rangées par ordre des hits, `contredit` d'abord. Celles déjà dans `hits` sont exclues. Il y en a cinq au plus.
  - Chacune porte `via: { slug, type, sens: 'sortant' | 'entrant' }`.
  - `hits` garde sa limite, et un client qui ignore `voisins` voit le même contrat qu'avant.
- Le journal d'usage (57.11) note les slugs des `hits`, pas ceux des `voisins`.

### DM22. `decide` : une décision, et ce qu'elle ferme, en un geste

- `POST /api/memory/decisions { slug, title, raison, texte?, remplace?: string[], namespace? }`.
- Elle écrit la page `<namespace>/decision/<slug>`, en mode création, avec ce frontmatter :
  - `type: decision`, `valide_depuis` (le jour), `raison` ;
  - `liens.remplace`, si des pages sont remplacées.
  Le corps est le titre en `#`, puis `texte`.
- `<namespace>` est celui du token de run. L'admin le donne par `namespace`, sans quoi c'est 400. `slug` est un seul segment `[a-z0-9._-]`.
- Pour chaque slug de `remplace`, tout est vérifié **avant la première écriture** :
  - la page existe : sinon 404, avec le slug ;
  - elle est ouverte : sinon 409 « déjà close » ;
  - elle est accessible en écriture par le même principal, avec la règle de `put` (un run n'écrit que dans son namespace, et dans `lesson/` seulement en rétro) : sinon 403.
- Puis, dans la file de la mémoire : la décision est créée, et chaque page remplacée reçoit `close_le` (le jour) et `remplacee_par` (avec la décision ajoutée), en `replace` à la révision lue.
  - Un échec annule tout, comme le découpage du 57 (DM13) : les fermetures déjà faites sont rendues à leur texte d'origine, à leur révision, puis la décision est retirée.
- Un événement `memory.decision` porte le slug, les pages fermées et l'auteur, jamais le texte.
- Les pages `<ns>/decision/` sont durables : la purge ne les touche pas. C'est déjà le cas, la purge ne vise que `plan/`, `dev-handoff/` et `review/`. Un test le garde.

### DM23. Les mêmes opérations partout

- **MCP :**
  - `memory_decide` (les champs de DM22) ;
  - `memory_links { slug }`, qui rend `{ sortants: [{ slug, type, existe }], entrants: [...] }`, plus `closed` et la raison de la fermeture ;
  - `memory_search` gagne `closes` et rend `voisins`.
  Les descriptions disent qu'une page close n'est pas une instruction, mais un fait daté.
- **Routes :** `GET /api/memory/links/*` et l'option `closes` de `/api/memory/search`. `GET /api/memory/pages/*` gagne `closed`.
- **CLI :**
  - `aid mem decide <slug> --title T --raison R [--remplace <slug>]… [--namespace ns]`, avec le texte facultatif sur stdin ;
  - `aid mem links <slug> [--json]` ;
  - `aid mem search … --closes`.
  Les codes de sortie sont ceux de `MEM_HELP`, plus 6 « déjà close ».
- **Santé :** `MemoryHealth` gagne `closed` (le nombre de pages closes) et `links: { total, pendants }`.

### DM24. L'entretien et le noyau suivent

- L'entretien ne propose rien sur une page close : ni tags, ni doublon, ni découpage. Une page close n'est jamais candidate voisine d'un doublon.
- Appliquer un doublon ou un découpage pose aussi `close_le` (le jour) sur la page d'origine.
- Le noyau :
  - `kernel/policy/namespace.md` décrit `valide_depuis`, `close_le`, `liens` et ses quatre types, les `[[liens]]` du corps, les pages `<ns>/decision/`, et la règle « on ferme, on ne supprime pas » ;
  - `kernel/adapters/aid.md` liste les deux outils et les deux commandes ;
  - les rôles `plan`, `review` et `retro` disent quand appeler `decide` : un choix qui engage la suite du projet, ou qui en remplace un autre ;
  - `kernel/CHANGELOG.md` gagne une entrée mineure, sans migration ;
  - les blocs rendus sont re-rendus par `/sync`, jamais édités à la main.

## 5. Points

### 60.1 Le plan

Ce document, et une ligne dans `README.md`.

### 60.2 Le schéma dérivé (DM19, DM20, DM21 sans la recherche)

`src/daemon/memory/liens.ts`, une fonction pure : du frontmatter et du corps vers `{ closed, liens, erreurs }`. Ensuite, la migration 037, le recalcul dans `put`, `remove`, `clear` et au démarrage, le refus en 400 à l'écriture par l'API, la tolérance à la relecture du miroir, et les compteurs de santé.

Les tests couvrent :
- chaque type et chaque clé héritée ;
- les `[[liens]]` du corps, hors blocs de code ;
- les dates refusées ;
- la colonne `closed` après un `put`, un `remove` et un `reindex` ;
- un lien pendant ;
- un démarrage sur une base du 57 sans la table.

- _Révision 60.2._ Fait :
  - `src/daemon/memory/liens.ts` (`deriveMemoryLinks`), sur le lexer de `marked`, déjà une dépendance ;
  - la migration 037, avec `declared_by` ajouté à la table ;
  - le recalcul dans `put`, `remove`, `clear` et au démarrage (`rebuildDerived`) ;
  - le refus 400 dans la route seule, l'import et le miroir ne faisant que journaliser ;
  - `closed` sur `MemoryPage`, et les compteurs de santé.

  Les dates sans décalage sont lues en UTC. Ma reprise : une page qui se cite elle-même dans son corps n'est pas refusée, la citation est ignorée.

### 60.3 La recherche (DM21)

Le filtre des pages closes en FTS et en vecteurs, l'option `closes`, les remplaçantes en chaîne, et le champ `voisins`, dans le service, la route, le CLI et le MCP.

Les tests couvrent :
- une page close absente puis présente avec `closes` ;
- une chaîne de trois remplacements, et une boucle ;
- les voisines dans les deux sens, `contredit` en tête, la limite de cinq ;
- `hits` inchangé pour un client qui ignore `voisins` ;
- le journal d'usage sans les voisines.

- _Révision 60.3._ Fait :
  - le filtre des pages closes, en FTS (dans le SQL) et en vecteurs (`closedSlugs`, en une requête) ;
  - les remplaçantes, qui reprennent le rang de la page close, dans le scope demandé ;
  - `voisins`, et `SearchResult` dans `shared` ;
  - `closes` dans la route, le CLI et le MCP.

  Ma reprise : la lecture FTS élargie, qui garde le rang des pages closes, est bornée à quatre fois la fenêtre au lieu d'être sans limite. Gate 4 667.

### 60.4 `decide` et `links` (DM22, DM23)

La route, le service, l'annulation, l'événement, les deux outils MCP et les deux commandes.

Les tests couvrent :
- une décision sans remplacement ;
- une décision qui ferme deux pages ;
- un refus 404, 409 ou 403 sans aucune écriture ;
- un échec au milieu des fermetures, rendu à l'identique (texte et révision restaurés, décision retirée) ;
- un run qui veut fermer une leçon hors rétro ;
- la purge qui épargne `decision/`.

### 60.5 L'entretien et le noyau (DM24)

Les exclusions de l'entretien, `close_le` posé par les applications, et les textes du noyau re-rendus. Les tests de l'entretien vérifient qu'aucune proposition ne vise une page close.

### 60.6 La fiche de recette

`docs/recette-chantier-60-memoire-liens.md`, sur une instance de recette avec des pages d'exemple neutres :
- fermer par `decide` ;
- chercher avec et sans `--closes` ;
- lire `aid mem links` ;
- voir les voisines ;
- vérifier que le miroir garde chaque fichier ;
- recalculer après un `reindex`.

## 6. Pièges

- **Le miroir fait foi.** La table et la colonne se recalculent depuis le frontmatter. Ne jamais écrire dans `memory_links` à la main, ni la sauvegarder.
- **Une relecture du miroir ne doit jamais échouer** pour un lien ou une date : elle ignore et note. Sinon, un fichier écrit à la main sur une autre machine bloquerait le tirage du 57 (DM12).
- **L'annulation de `decide`** remet chaque page à sa révision lue. Une page modifiée entre-temps n'est pas écrasée : l'erreur le dit, comme au découpage.
- **Les exemples** n'utilisent que des slugs neutres (`aid/decision/exemple`, `lesson/sqlite/…`). Aucun vrai contenu de mémoire dans le dépôt.

## 7. Fini quand

- Une page remplacée n'est plus rendue par `memory_search` par défaut. Sa remplaçante l'est, avec la raison.
- `memory_links` rend les liens sortants et entrants d'une page, et `memory_search` rend les voisines.
- `memory_decide` écrit une décision et ferme les pages qu'elle remplace, tout ou rien.
- Le miroir reste la seule source, et un `reindex` redonne le même état.
- Le noyau décrit les nouvelles règles, et les blocs sont re-rendus.

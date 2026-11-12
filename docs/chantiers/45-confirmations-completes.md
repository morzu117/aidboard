# Chantier 45 : les confirmations complètes

| Champ | Valeur |
|---|---|
| État | **Révision 1, 12 novembre 2026.** Julien a validé la spec et tranché Q-J1. PASS du lab sur la spec, révision 1 (DM 96814), puis sur le plan, révision 0 (DM 96818). La révision 1 corrige D305 et ajoute D310. |
| Emplacement final | `docs/chantiers/45-confirmations-completes.md` sur `main` |
| Base | `feat/40-avis-mesh` (PR #152), parce que le 45 couvre les trois actions du 40. La PR du 45 se rebase sur `main` après le merge de #152. |
| Spec | `specs/confirmations-completes-45.md`, révision 1 (dossier de travail, hors dépôt). |
| Organisation | morzu-vps gère le chantier. Un agent Codex CLI écrit le code et les tests de chaque point, sur un brief tiré de ce plan. morzu-vps relit chaque diff, lance le gate, commite et ouvre la PR. |
| Validation | Le lab relit le plan, puis le code des points 45.2 et 45.3. Ensuite viennent la recette de Julien et son oui pour le merge, CI verte. |

## 1. Pourquoi

Le chantier 40 a accepté deux écarts (`40-avis-mesh.md`, §6) :

1. **Le panneau des confirmations du Mac** montre le résumé d'une demande, pas ses paramètres signés.
2. **Le téléphone** montre les paramètres avant la signature, mais jamais le résultat de l'exécution. Après la réponse, il affiche « Réponse envoyée », et c'est tout.

Ces deux écarts valent pour toutes les actions confirmées : merge, push, nettoyage, les écritures du 35 bis et du 36, et les trois actions du 40. Ce chantier les comble.

## 2. État actuel

| Zone | Où | Ce qui existe |
|---|---|---|
| La table | `pda_demandes` (migrations 023, 024 et 025) | `params` (le JSON canonique signé), `resume` (160 caractères au plus), `numero_mac`, `resultat` (`executee`, `echouee`, `perimee`, `annulee`), `raison` (un code court), et `envoi` (le `ResultatEnvoi` des actions mesh). |
| La liste du Mac | `GET /api/confirmations` (`src/daemon/routes/confirmations.ts`) | Elle est réservée à l'admin. Elle rend `id, action, classe, resume, etat, resultat, raison, cree_a, echeance` et, pour les actions mesh seulement, `envoi`. Elle ne rend ni `params` ni aucun numéro. |
| Le numéro « toujours » | `GET /api/confirmations/:id/numero` | Il est réservé au cookie admin et sert `no-store`. Le chantier n'y touche pas. |
| Le panneau du Mac | `web/src/ui/PanneauConfirmations.tsx`, `AttenteConfirmation.tsx` | Il affiche le résumé, l'état, le résultat et, pour les actions mesh, `envoi.status` et `envoi.detail`. |
| Le téléphone | `web/src/AppPda.tsx` | Il vérifie l'enveloppe de chaque demande avec la clé du daemon, puis affiche le résumé et le composant `Parametres`. `Parametres` n'a pas de cas pour `mesh.ecrire`, `mesh.etat`, `host.option`, `reglage` ni `essai`. |
| Le relais | `src/relais/index.ts` | Il garde un état en mémoire seulement. Ses routes sont `PUT /autorises`, `PUT` et `DELETE /demandes/:id`, `GET /reponses` (signées par le daemon), ainsi que `GET /demandes` et `POST /reponses/:id` (signées par un appareil autorisé). Le journal ne garde que des identifiants. |
| Après la signature | `src/daemon/pda/file.ts`, `porte.ts` | Le daemon relève les réponses toutes les 15 s. Il consomme la demande et la retire du relais avant de l'exécuter, puis il écrit `resultat`, `raison` et `envoi`. **Aucun canal ne va du Mac vers le téléphone après l'exécution.** |

## 3. Cible et hors-périmètre

**Cible.**
- **Sur le Mac :** chaque demande du panneau, ouverte ou récente, montre ses paramètres signés.
- **Sur le téléphone :** une demande à laquelle il a répondu montre ensuite son résultat. Ce résultat n'est fait que de codes, sans aucun texte.

**Hors du périmètre :**
- Tout changement du corps d'une demande (v2), de la signature d'une demande ou du numéro.
- Tout texte venu d'un serveur, envoyé au téléphone : `envoi.detail`, `current_stage`, les messages d'erreur.
- Une notification push du résultat (#1232).
- Toute nouvelle colonne en base.

## 4. Décisions

### D304. Le Mac montre les paramètres signés

- `GET /api/confirmations` ajoute `params`, l'objet relu depuis la colonne, pour toutes les actions, ouvertes et récentes. Si la colonne est illisible, `params` vaut `null`.
- `numero_mac` et `numero` ne sont jamais rendus. Le seul accès au numéro reste la route `/numero`.
- Les principaux autorisés ne changent pas : la liste reste réservée à l'admin, cookie ou bearer (L4). Le paramètre ne donne aucun pouvoir : un admin bearer peut déjà créer ces demandes.
- La liste gagne `Cache-Control: no-store`, comme `/numero`.
- Le composant `Parametres` sort d'`AppPda.tsx` vers `web/src/ui/ParametresSignes.tsx`. Le panneau du Mac et le téléphone l'utilisent tous les deux. Il gagne les cas qui lui manquent : `mesh.ecrire`, `mesh.etat`, `host.option`, `reglage` et `essai`.
- Tout texte s'affiche comme du texte, jamais comme du HTML ou du Markdown. Une valeur de forme inattendue s'affiche « illisible ». Une demande sans paramètres par construction (une demande « essai » v1, `params` à NULL) s'affiche « aucun paramètre ».
- **Le chemin de `projet.retirer`** (Q-J1, tranché par Julien le 12 novembre) : en entier sur le Mac, réduit à son dernier segment sur le téléphone. La signature couvre toujours le chemin entier. Cela précise D220 du 43 et D232 du 34.
- Sur le Mac, les paramètres sont repliés par défaut, sous « Paramètres signés ».
- Le test qui fixe la liste exacte des clés (`test/confirmations-porte.test.ts`) est gardé, avec `params` ajouté, et il gagne une assertion négative : ni `numero` ni `numero_mac`, pour le cookie comme pour le bearer. Ce sont des lignes modifiées hors du chantier, à compter.

### D305. Le résultat signé

Depuis tout chemin de D307, le daemon signe un résultat et le publie sur le relais.

- **Le corps.** C'est un JSON canonique `{ v: 1, id, action, resultat, raison, code, emis }`.
  - `resultat` vaut `executee`, `echouee`, `perimee` ou `annulee`.
  - `raison` est le code court déjà écrit en base, ou `null`.
  - `code` vaut `ResultatEnvoi.code` pour les actions mesh, et `null` pour les autres. Sa liste fermée est exactement l'énumération `ResultatEnvoi.code` (`src/shared/ecritures.ts`), construite par A-I-D depuis le résultat du proxy, jamais un texte du gateway (L2).
  - `emis` est l'heure en millisecondes.
- **Ce que le corps ne contient pas :** ni `params`, ni `resume`, ni `envoi.detail`, ni `current_stage`, ni `status`, ni l'identifiant du message mesh, ni `open_obligations`, ni un nom de sujet, de projet ou d'appareil.
- **Les valeurs sont fermées.** Chaque champ est vérifié par une liste fermée avant la signature. Une valeur hors de la liste ne part pas, et elle est journalisée sans contenu.
- **La signature** est en ES256 avec la clé du daemon, sur `"aid-pda-resultat-v1\n" ‖ corps`. Ce contexte est distinct de celui des demandes (`aid-pda-demande-v1`), pour qu'une enveloppe de demande ne puisse pas servir de résultat, et inversement.
- **La forme** est l'enveloppe actuelle `{ corps: base64url, sig }`. Elle est signée mais pas chiffrée : le relais peut lire ces codes.
- **Les demandes qui ne donnent aucun résultat :** une demande refusée, ou expirée. Le téléphone sait déjà qu'il l'a refusée.

### D306. Le relais garde les résultats

- **Route `PUT /resultats/:id`**, signée par le daemon, comme `PUT /demandes/:id`. Le corps est borné à 1 Kio, et le relais décode l'enveloppe sans la juger.
- **Route `GET /resultats`**, signée par un appareil autorisé, comme `GET /demandes`. Elle rend la liste des enveloppes.
- **Conservation.** Un résultat est gardé 24 h, en mémoire, avec au plus 50 résultats. Le plus ancien part en premier. Un redémarrage du relais les perd, ce qui est accepté : le Mac garde le résultat en base.
- **Le journal** ne garde que la méthode, la route, le statut, l'identifiant et l'appareil, comme aujourd'hui.
- **Le CORS** de `GET /resultats` suit celui de `GET /demandes`. Le préflight `OPTIONS`, qui ne répond aujourd'hui qu'à `/demandes` et `/reponses/:id`, gagne `/resultats`, avec un test.
- **Le GET ne consomme pas**, à la différence de `/reponses`.
- **Trois contextes de signature :** demande, relais et résultat. Aucun n'est le préfixe d'un autre.

### D307. Le daemon publie, sans nouvelle colonne

- `FilePda` met un résultat dans une file en mémoire depuis **tout chemin qui écrit un `resultat` après un « oui » signé** :
  - après `executerConfirmee` ;
  - quand le numéro retapé est faux (`resultat` `annulee`, `raison` `numero`), qui s'arrête avant l'exécution. C'est le résultat dont le téléphone a le plus besoin ;
  - et depuis `annuler()` sur le Mac. Ainsi, un « oui » donné dans les 15 s avant la relève reçoit « Annulée ».
- Il le publie au tour suivant. En cas d'échec, il retente à chaque tour pendant 1 h, puis il l'abandonne.
- Un échec est journalisé sans contenu.
- Un redémarrage du daemon vide la file, ce qui est accepté.
- Sans `config.modeHost.relais`, rien n'est publié.
- Aucun autre transport n'est ouvert (43, piège : pas de transport réglable autre que `config.modeHost.relais`).

### D308. Le téléphone montre le résultat

- **La mémoire du téléphone.** Après avoir répondu « oui », le téléphone garde la demande en mémoire, sans stockage persistant, dans une liste « Réponses récentes » : l'id, l'action, le résumé déjà affiché et l'heure.
- **La relève.** Il lit `GET /resultats` à chaque relève des demandes. Il vérifie chaque enveloppe avec la clé du daemon et le contexte `aid-pda-resultat-v1`, et jette toute enveloppe qui ne se vérifie pas.
- **L'affichage**, par l'id :

  | Cas | Affichage |
  |---|---|
  | `executee` | « Exécutée » |
  | `echouee` | « Échouée », suivi de la raison ou du code d'envoi s'il y en a un. Jamais « (null) » ni des parenthèses vides. |
  | `perimee` | « Périmée » |
  | `annulee` | « Annulée » |
  | `annulee` avec la raison `numero` | « Annulée : numéro faux » |
  | code d'envoi `upstream_ambiguous`, `delai` ou `interrompu` | « Issue incertaine, à vérifier sur le Mac », **jamais « Échouée »**, même si `resultat` vaut `echouee`. L'appel a pu atteindre le gateway et l'écriture a pu passer : relancer depuis le téléphone risquerait de l'envoyer deux fois. |
  | raison `delai`, pour une action hors mesh (merge, push, nettoyage) | « Issue incertaine, à vérifier sur le Mac ». L'action a pu aboutir. |
  | autre code d'envoi mesh que `succes` | ajouté entre parenthèses |
  | pas encore de résultat | « En attente du résultat » |
  | 24 h passées sans résultat | « Résultat non reçu, à lire sur le Mac » |

  Le téléphone n'affirme jamais un échec qu'il n'a pas reçu.
- **La relecture après « oui ».** Le daemon publie 15 à 30 s après la réponse, et le téléphone ne relit aujourd'hui qu'au chargement et au retour de visibilité. Après un « oui », il relit donc les résultats à +20 s et à +45 s, puis à chaque retour de visibilité.
- **Un résultat dont l'action diffère** de celle gardée pour le même id est jeté.
- **Après un rechargement**, la mémoire est vide. Un résultat vérifié dont l'id est inconnu s'affiche avec le nom de l'action et l'heure, sans résumé.
- Tout s'affiche comme du texte.

### D309. Ce qu'un relais hostile peut faire

| Ce que peut faire un relais hostile | Effet | Ce que prévoit la spec |
|---|---|---|
| Retenir un résultat, ou le retarder | Le téléphone affiche « En attente du résultat », puis « Résultat non reçu, à lire sur le Mac ». | Ces deux libellés |
| Forger un résultat ou le modifier | Sans la clé du daemon, l'enveloppe ne se vérifie pas, et le téléphone la jette. | La vérification par la clé du daemon |
| Servir une enveloppe de demande comme résultat | Elle ne se vérifie pas. | Le contexte de signature distinct |
| Rejouer un vieux résultat | Les id sont uniques, donc le résultat ne s'attache qu'à sa propre demande. | — |
| Lire les codes en clair | Il apprend : telle demande, telle action, exécutée ou échouée. | C'est déjà le cas aujourd'hui, puisque le relais voit passer la demande et la réponse. Le résultat n'ajoute que des codes, aucun texte. |

### D310. Les règles de construction (relecture du plan, DM 96818)

- **Le résultat publié est construit depuis la ligne relue après l'écriture** (`resultat`, `raison`, `envoi.code`), jamais depuis des valeurs en mémoire. Le téléphone montre ainsi exactement ce que montre le Mac. Tous les `terminer()` d'`executerConfirmee` sont couverts, chemins « perime » compris.
- **Le téléphone rattache un résultat par le `corps.id` signé seulement**, jamais par la position dans la liste ni par l'id du chemin.
- **La borne de 1 Kio de `PUT /resultats` s'applique dans la boucle de lecture**, avant l'authentification, comme les bornes actuelles. Jamais après le décodage.
- **La priorité des libellés de D308 :**
  1. l'issue incertaine l'emporte, que ce soit par le code `upstream_ambiguous`, `delai` ou `interrompu`, ou par la raison `delai`. La raison `delai` rend l'issue incertaine pour toute action, mesh comprise ;
  2. puis la raison `numero` ;
  3. puis le `resultat` de base.
- **Le dernier segment d'un chemin** ignore une barre finale : `/a/b/` donne `b`.

## 5. Points

### 45.1 Le Mac voit les paramètres signés (D304)

- `src/daemon/routes/confirmations.ts` :
  - `GET /api/confirmations` ajoute `params`, l'objet relu de la colonne, à chaque ligne, ouverte ou récente. Si la colonne est NULL ou illisible, `params` vaut `null`.
  - La réponse porte `Cache-Control: no-store`.
  - Les numéros (`numero`, `numero_mac`) ne sont jamais sélectionnés.
- `web/src/ui/ParametresSignes.tsx`, nouveau : le composant `Parametres` d'`AppPda.tsx`, déplacé sans changer son rendu pour les cas existants, avec les props `{ action, params, surface: 'mac' | 'telephone' }`.
  - Il gagne les cas `mesh.ecrire`, `mesh.etat`, `host.option`, `reglage` et `essai`.
  - `params` à `null` donne « aucun paramètre ».
  - Une forme inattendue donne « illisible », sans exception.
  - `projet.retirer` montre la racine entière sur le Mac, et son dernier segment sur le téléphone.
- `web/src/AppPda.tsx` utilise `ParametresSignes` avec `surface="telephone"`.
- `web/src/ui/PanneauConfirmations.tsx` : chaque demande, ouverte ou récente, montre ses paramètres sous un `<details>` « Paramètres signés », replié par défaut, avec `surface="mac"`. Le type client de la liste gagne `params`.
- **Tests :**
  - le dernier segment avec une barre finale (`/a/b/` donne `b`) ;
  - le test de la liste exacte des clés (`test/confirmations-porte.test.ts`) est gardé, avec `params` ajouté, plus une assertion négative : ni `numero` ni `numero_mac`, pour le cookie admin comme pour le bearer admin ;
  - `no-store` sur la liste ;
  - `params` NULL donne `null` ;
  - le rendu de `ParametresSignes` pour chaque action, avec un texte hostile rendu comme du texte, « aucun paramètre » et « illisible » ;
  - la racine entière ou réduite ;
  - le panneau replié puis déplié ;
  - les tests existants du téléphone restent verts.
- 45.1, livré : 44 tests ajoutés. Le gate est vert, 3 483 tests réussis. 99 lignes existantes ont été remplacées, dont 89 ont seulement été déplacées avec le composant. Les tests mesh vérifient toujours que le texte n'apparaît nulle part hors de `params`.

### 45.2 Le résultat signé (D305, D306, D307)

- `src/shared/pda.ts` : le contexte `aid-pda-resultat-v1`, le type `CorpsResultatV1`, ainsi que `signerResultat` et `verifierResultat`, avec les listes fermées.
- `src/relais/index.ts` : les routes `PUT /resultats/:id` et `GET /resultats`, le préflight, les bornes et la purge.
- `src/daemon/pda/` : la file de publication, alimentée depuis `executerConfirmee`, le numéro faux et `annuler()`.
- **Tests :** le relais hostile, les contextes croisés, les bornes (dans la boucle de lecture), la purge, les retentatives, et la construction depuis la ligne relue pour chaque chemin de D307.
- 45.2, livré : 58 tests ajoutés. Le gate est vert, 3 541 tests réussis. Chemins couverts : tous les `terminer()` d'`executerConfirmee`, le numéro faux et `annuler()`. Les raisons signées sont `perime`, `delai`, `script` et `numero`, les seules que le code écrit. Le code de 45.2 est à relire par le lab, ainsi que la route de 45.1.

### 45.3 Le téléphone montre le résultat (D308)

« Réponses récentes », la relecture à +20 s et +45 s, et le tableau des libellés. **Tests :** chaque ligne du tableau et la priorité de D310, une enveloppe forgée jetée, une action différente jetée, et un relais qui sert le résultat X sous l'id Y (rattaché à X par le `corps.id` signé, ou jeté).

### 45.4 La fin

Un e2e sur le relais local, la fiche `docs/recette-chantier-45-confirmations-completes.md`, et le renvoi depuis les notes 34, 40 et 43.

## 6. Pièges

- Ne jamais rendre `numero` ni `numero_mac` ailleurs que par `/numero`.
- Ne jamais envoyer au téléphone un texte venu d'un serveur : seulement des codes de listes fermées.
- Le téléphone n'affirme jamais un échec quand l'issue est incertaine (D308).
- Aucun transport autre que `config.modeHost.relais`.
- Aucune colonne ni migration.
- Les tests de frontière host ne changent pas.

## 7. Fini quand

- Les points 45.1 à 45.4 sont commités.
- Le gate est vert, et la CI de la PR est verte.
- Le lab a rendu PASS sur le code des points 45.2 et 45.3.
- Julien a fait la recette, puis donné son oui pour le merge.

## 8. Relectures

- **L1, chiffrement : non.** Le relais reçoit déjà en clair le corps de chaque demande, avec ses `params`, son `resume` et, hors classe « toujours », le numéro. Chiffrer le seul résultat cacherait des codes dont la demande est passée en clair. La confidentialité face au relais relève d'un chantier de chiffrement des demandes, hors du 45.
- **L2, le code d'envoi : oui**, aux conditions de D305 (une liste fermée, exactement l'énumération) et de D308 (l'issue incertaine).
- **L3, le chemin : tranché par Julien (Q-J1).** Masquer ne change que l'écran du téléphone, puisque le relais voit le chemin dans les `params`. L'avis du lab : le dernier segment sur le téléphone, le chemin entier sur le Mac. C'est la proposition de D304 (**Q-J1**).
- **L4, les paramètres : l'admin suffit.** Le numéro est réservé au cookie parce qu'il est le facteur humain d'une confirmation « toujours ». Les paramètres ne donnent aucun pouvoir. Les conditions (le test exact des clés et `no-store`) sont en D304.


# Chantier 34 : les confirmations par le téléphone

| Champ | Valeur |
|---|---|
| État | **Révision 0, 8 novembre 2026**, à relire par le lab. Julien a tranché Q1 à Q4 de la spec, puis l'armement (D233). Le lab a relu la spec (DM 92515), et ses deux points obligatoires sont écrits en D224 et D226. PASS de lab sur la spec (DM 92518), dont les deux précisions sont écrites en D224 et D226. |
| Emplacement final | `docs/chantiers/34-confirmations.md` sur `main`, dans le premier commit du chantier |
| Base | **9ec6a45** (`origin/main`, PR #129). |
| Spec | `specs/confirmations-34.md`, révision 3 (dossier de travail, hors dépôt ; copie sur morzu-vps dans `~/work/aid-specs/`). |
| Organisation | Comme au 43. morzu-vps gère le chantier. Un agent Codex CLI écrit le code et les tests de chaque point, sur un brief tiré de ce plan. morzu-vps relit chaque diff, lance le gate, commite et ouvre la PR. |
| Validation | Le lab valide le 34 (DM 89702) : le plan, puis la frontière sur les diffs. La recette de Julien suit, sur ses appareils. Le merge suit la règle de Julien : la CI verte et la validation du lab. |

## 1. Pourquoi

Ligne 34 du programme : « Confirmations par le téléphone : réglage, plancher, numéro à reporter. Côté A-I-D : demande, attente, file si le téléphone est indisponible. » Le 43 a livré le canal (le relais, la passkey, la vérification) avec la seule action `essai`. Le 34 y branche les vraies actions du Mac.

## 2. État actuel

| Zone | Où | Ce qui existe |
|---|---|---|
| Le canal | `src/shared/pda.ts`, `src/daemon/pda/` | `CorpsDemande` (action `essai`), `FilePda` (créer, tirer, traiter, consommer), `verifierAssertion` (D218 du 43), le registre et le relais. |
| Le merge | `routes/topics.ts:773`, `scripts/git/topic-merge.sh` | `topic.merge` porte déjà la tête affichée (`AID_MERGE_HEAD` → `--match-head-commit`). |
| Le push git | `routes/topics.ts:559`, `scripts/git/topic-push.sh` | Un `git push origin <branche>` **nu**. |
| Le nettoyage | `scripts/git/topic-cleanup.sh` | Supprime le worktree et la branche (`branch -D`), sans vérifier leur tête. |
| Le retrait d'un projet | `routes/workspaces.ts:170` | Refuse s'il reste un sujet ouvert ; ne supprime que des lignes en base. |
| Le mode host | `routes/host.ts` | `approuver` un appairage ; `PUT /api/host/code` et `/push` ; activer un PDA. |
| L'authentification | `src/daemon/security.ts` | Le principal `admin` par cookie (l'UI) ou par bearer ; les agents ne reçoivent qu'un jeton de run (`POST /api/events` seulement). |

## 3. Cible et hors-périmètre

**Cible.** Huit actions passent par une confirmation, rangées en deux classes. La porte est commune. L'exécution part de la réponse vérifiée, avec les paramètres signés et l'attendu porté par l'écriture. Le Mac montre la file et le résultat. Le réglage vit en base.

**Hors-périmètre.**
- Le merge lancé **depuis le téléphone** (l'écran du 32) : il réutilisera la même porte, mais dans un chantier à part.
- L'argent, les identifiants du commander, la création de pairs : A-I-D n'a aucune de ces actions.
- Le SSO (chantier 33) et la règle « pas de mode `auto` avec le SSO ».

## 4. Décisions

### D222. Les actions et leurs classes

| Action | Classe | Route d'origine | Paramètres signés |
|---|---|---|---|
| `merge` | par défaut | `topic.merge` | `topicId`, dépôt (`owner/nom`), `pr`, `tete` (40 hex), `strategie`, `supprimerBranche`, `nettoyer` |
| `push` | par défaut | `git.pousser` | `topicId`, `branche`, `tete` locale (40 hex), `distante` attendue (40 hex ou `null` si absente) |
| `nettoyage` | par défaut | `topic.cleanup` | `topicId`, `branche`, `tete` (40 hex ou `null`), `etat` |
| `projet.retirer` | par défaut | `DELETE /api/workspaces/:id` | `workspaceId`, `racine` |
| `appairage` | toujours | `POST /api/host/appairages/:id/approuver` | `appairageId`, `nom`, `identite`, `sansIdentite` |
| `pda.activer` | toujours | `POST /api/host/pda/appareils/:id/activer` | `appareilId`, `empreinte` |
| `host.option` | toujours | `PUT /api/host/code` et `/push` | `option` (`code` ou `push`), `actif` |
| `reglage` | toujours | nouvelle route (D227) | `classe`, `action`, `actif` |

`essai` reste, en classe « par défaut », sans effet. Couper le code, le push ou le PDA, révoquer un appareil, « Couper tous les accès » : ce sont des retraits de droits, **jamais** sous confirmation (lab, DM 92515).

### D223. Le corps signé

`CorpsDemande` passe en `v: 2` : `{ v, id, action, classe, params, resume, numero, echeance, emise }`.
- `params` est l'objet de D222, validé par un schéma fermé propre à l'action. `lireCorpsDemande` refuse toute clé en trop.
- `resume` est le texte de l'invite, ≤ 160 caractères, construit par le daemon à partir des seuls `params` (D229). L'app l'affiche en texte, et affiche aussi les `params` à sa façon : un relais ne peut changer ni l'un ni l'autre.
- `numero` : les 4 chiffres pour la classe « par défaut », comme au 43. Pour la classe « toujours », `null` : le numéro n'est pas dans le corps (Q1).
- `echeance` : `emise + 15 min` (Q3).
- Le v1 (`essai`) reste lisible par l'app tant que le 34 n'est pas déployé. Ensuite, le daemon ne signe plus que du v2.

### D224. L'attendu porté par l'écriture (obligatoire, lab)

Une revérification juste avant l'écriture laisse une fenêtre. Chaque exécution porte donc l'attendu signé **jusqu'à l'écriture** :
- `merge` : `gh pr merge --match-head-commit <tete>` toujours (le script le rend obligatoire quand `AID_MERGE_EXIGER_TETE=1`).
- `push` : `git push --force-with-lease=refs/heads/<branche>:<distante> origin <tete>:refs/heads/<branche>`. Si `distante` vaut `null`, le bail exige que la branche soit absente (`--force-with-lease=refs/heads/<branche>:`). Le script refuse aussi si `git rev-parse <branche>` n'est pas égal à `tete`.
- `nettoyage` : la branche locale est supprimée par `git update-ref -d refs/heads/<branche> <tete>`, qui échoue si elle n'est pas à `tete`. Il n'y a pas de lecture puis de suppression en deux temps (lab, DM 92518). Une branche distante éventuelle est supprimée par `git push --delete` avec `--force-with-lease=refs/heads/<branche>:<tete>`. L'état du sujet est relu et passé à `archived` dans la même transaction qui consomme la demande.
- `projet.retirer` : la vérification (« aucun sujet ouvert », la racine) et la suppression se font dans **une seule** transaction SQLite.
- `appairage`, `pda.activer`, `host.option`, `reglage` : la relecture de l'état et l'écriture se font dans une seule transaction (l'appairage est toujours en attente et non expiré ; l'appareil est en attente avec la même empreinte ; etc.).

Une revérification a lieu juste avant aussi, pour refuser tôt avec un message clair (L2).

### D225. La porte

Un module `src/daemon/confirmations/` expose, par action, deux fonctions :
- `preparer(entree)` : la validation de la route d'origine (droits, existence, bornes, 409 actuels). Elle renvoie les `params` signables, ou une erreur HTTP.
- `executer(params)` : l'effet, avec l'attendu de D224.

La route d'origine appelle `preparer`. Si l'action est sous confirmation (D227), elle crée la demande et répond **202** `{ confirmation: id }`. Sinon, elle appelle `executer` comme aujourd'hui. À la réponse « oui », `FilePda` appelle **le même `preparer`** avec les `params` signés, compare le résultat aux `params` signés (tout écart : refus `perime`), puis `executer`. Il n'y a pas de second chemin qui saute un contrôle (L3).

**Une fois les confirmations armées (D233)**, sans PDA allumé ou sans appareil actif, une action sous confirmation répond **409** `{ error: 'confirmation_impossible' }`, avec un message qui l'explique. Il n'y a pas de repli sur le Mac seul, sauf l'amorçage de D226.

### D226. L'amorçage (obligatoire, lab)

- **Tant qu'aucun appareil PDA n'est actif**, allumer le PDA et activer un appareil se font sur le Mac seul (Q2).
- Ce chemin n'est ouvert qu'au principal `admin` **par cookie** (`via: 'cookie'`), jamais au bearer, et la route exige `{ empreinte }` égale à celle de l'appareil : l'UI ne l'envoie qu'après la comparaison confirmée.
- Il est journalisé en évidence (`pda.amorcage`, sans contenu). Le panneau affiche « Premier appareil activé sans confirmation » tant qu'aucun second appareil n'est actif.
- Dès qu'un appareil est actif, toute activation est une action `pda.activer` sous confirmation.
- La révocation reste immédiate. Si le dernier appareil est révoqué, toute action sous confirmation est refusée (D225), et seul l'amorçage par l'UI peut en remettre un.
- **Limite connue du §7.** Les agents tournent sous le même utilisateur Unix que le daemon : un agent déterminé pourrait lire le jeton de session (`0600`) et se faire passer pour l'UI. L'amorçage repose donc sur la confiance du Mac. Le journal et le bandeau rendent un amorçage inattendu visible. La vraie parade, un utilisateur Unix distinct pour les agents, est un chantier à part, à ouvrir plus tard dans le programme (lab, DM 92518, même classe que sa card #20).

### D227. Le réglage

- Migration 024 : `confirmations_reglage (action TEXT PRIMARY KEY, actif INTEGER NOT NULL)`, préremplie pour les quatre actions « par défaut », toutes à 1 (Q4). Il n'est pas dans `config.yaml`.
- Les actions « toujours » n'ont pas de ligne : on ne peut pas les couper.
- La valeur qui compte est celle lue **au moment de la demande**.
- `PUT /api/confirmations/reglage { action, actif }` crée toujours une demande `reglage` (classe « toujours »). Il n'existe aucune autre écriture.
- `GET /api/confirmations/reglage` renvoie l'état pour l'UI.

### D228. Le numéro de la classe « toujours »

- Le daemon tire 4 chiffres, les garde en base, et ne les met pas dans le corps signé.
- `GET /api/confirmations/:id/numero` ne répond qu'au principal `admin` par cookie, `Cache-Control: no-store`. C'est le seul endroit qui le sert.
- Il n'apparaît ni dans le journal, ni dans un événement (`/ws/`, `events`), ni dans un retour d'agent ou d'outil.
- L'app affiche « Retape le numéro affiché sur le Mac ». Le daemon compare le numéro de l'assertion à celui de la base (étape « numero » de D218).

### D229. L'invite

- `merge` : « Merge de <dépôt>#<pr> (<tête courte>), <stratégie>, branche supprimée oui/non ». Le titre de la PR n'y est pas : c'est du texte venu de la forge.
- `push` : « Push de <branche> (<tête courte>) ».
- `nettoyage` : « Nettoyage du sujet <branche> ».
- `projet.retirer` : « Retrait du projet <nom du dossier> ».
- `appairage` : « Approuver l'appareil <nom> ».
- `pda.activer` : « Activer le PDA <nom>, empreinte <XXXX-XXXX> ».
- `host.option` : « Montrer le code aux appareils » ou « Notifications push sur les appareils ».
- `reglage` : « Confirmations : <action> coupée » ou « allumée ».

Les noms (sujet, projet, appareil) passent par le relais, comme au 43 (Q4 du 43). Ils sont bornés à 60 caractères et nettoyés des caractères de contrôle.

### D230. La file, l'attente et le résultat

- `pda_demandes` gagne `classe`, `params` (JSON), `resume`, `resultat` (`executee`, `echouee`, `perimee`, `annulee` ou `NULL`) et `raison` (code court, sans contenu). Migration 024.
- `GET /api/confirmations` liste les demandes ouvertes, et les 20 dernières terminées.
- `DELETE /api/confirmations/:id` annule une demande ouverte : elle passe à `annulee`, et le daemon la retire du relais.
- Sans rejeu (L3) : la confirmation est consommée avant l'exécution, même si l'action échoue. Une nouvelle demande est nécessaire.
- Le résultat s'affiche sur le Mac et reste en base.
- Le push (32 bis) compte les demandes ouvertes, comme au 43.

### D231. L'UI du Mac

- Chaque bouton d'une action sous confirmation, sur une réponse 202, affiche « En attente de confirmation sur le téléphone », avec « Annuler ». Pour la classe « toujours », le numéro à retaper s'affiche **là**, en gros.
- Une section « Confirmations » dans le panneau du mode host : la file, les résultats, le réglage (des interrupteurs qui créent une demande `reglage`), et le bandeau d'amorçage.
- Un 409 `confirmation_impossible` affiche : « Allume le PDA et active un téléphone pour cette action ».

### D232. L'app du téléphone

- Elle lit le v2 : elle affiche le `resume` et, sous lui, les `params` utiles (D229), en texte React seul.
- Classe « toujours » : « Retape le numéro affiché sur le Mac ». « Confirmer » est actif dès que 4 chiffres sont saisis, puisque le téléphone ne connaît pas le numéro.
- Classe « par défaut » : comme au 43.

### D233. L'armement (décidé par Julien)

Le refus fermé de D225 bloquerait tout merge sur une installation qui n'a jamais eu de PDA. Julien a retenu l'armement au premier PDA :
- Les confirmations sont **armées** au premier amorçage (D226), par une ligne en base (`confirmations_armees`, horodatée).
- **Avant l'armement**, les actions de D222 s'exécutent comme aujourd'hui, sur le Mac seul. Le panneau dit « Confirmations non armées ».
- **Après l'armement**, c'est irréversible depuis l'API : la révocation de tous les appareils ne désarme pas, elle rend les actions impossibles (D225). Seule la commande locale `aid confirmations desarmer`, dans un terminal du Mac, désarme. Elle est journalisée et affichée.
- Ainsi, un agent qui révoque tout ne rouvre pas la porte du Mac seul.
- **Limite.** Un agent qui peut lancer un terminal peut aussi lancer cette commande (même limite que D226).

## 5. Points

### 34.1 Le plan

### 34.2 Le corps v2, les schémas d'action et le résumé (D222, D223, D229)

`src/shared/pda.ts` : `CorpsDemandeV2`, un schéma fermé par action, `lireCorpsDemande` qui accepte le v1 et le v2, et `resumeAction(params)`. `defiReponse` ne change pas. Les tests couvrent une clé en trop refusée par action, les bornes, les caractères de contrôle et `numero: null` pour « toujours ».

### 34.3 La migration 024 et le réglage (D227, D230)

`migrations/024_confirmations.sql`, `src/daemon/confirmations/reglage.ts`, `GET /api/confirmations/reglage`. Le `PUT` n'arrive qu'au 34.5.

### 34.4 L'attendu dans les scripts git (D224)

`topic-merge.sh` (tête obligatoire), `topic-push.sh` (`--force-with-lease`, tête locale), `topic-cleanup.sh` (tête de la branche). Les variables ne sont exigées que si elles sont passées, et les chemins actuels sans confirmation passent la tête courante. Tests de scripts avec un dépôt local et un dépôt « distant » nu : une tête qui a bougé est refusée.

### 34.5 La porte et l'exécution (D225, D228, D230)

`src/daemon/confirmations/porte.ts` : `preparer` et `executer` pour les huit actions, la création de la demande, le 202, le 409 `confirmation_impossible`, l'exécution depuis `FilePda` après la consommation, `perime` sur tout écart, le résultat en base. Les routes `GET /api/confirmations`, `DELETE /api/confirmations/:id`, `GET /api/confirmations/:id/numero` et `PUT /api/confirmations/reglage`. Tests : chaque action confirmée puis exécutée, refusée, expirée, annulée, périmée ; le numéro absent des journaux et des événements.

### 34.6 L'amorçage (D226)

Le chemin cookie seul, l'empreinte exigée, `pda.amorcage`, le bandeau. Tests : le bearer est refusé ; après la révocation du dernier appareil, toute action sous confirmation est refusée, et l'amorçage par cookie fonctionne.

### 34.7 L'app du téléphone (D232)

Le v2, l'affichage des `params`, le numéro « toujours ». Tests web, sur le modèle du 43.8.

### 34.8 L'UI du Mac (D231)

L'attente sur chaque bouton, le numéro « toujours », la section « Confirmations ». Tests web.

### 34.9 L'e2e et la fiche de recette

Un merge et un push confirmés de bout en bout avec le relais local et la passkey virtuelle. Un merge dont la tête bouge entre la demande et la confirmation, qui doit être refusé par la forge factice ou par le bail. Une approbation d'appareil avec le numéro lu sur le Mac. Le réglage coupé puis rallumé. L'amorçage après la révocation. La fiche : `docs/recette-chantier-34-confirmations.md`.

## 6. Pièges

- **Lignes existantes modifiées.** Ce chantier touche des routes existantes (merge, push, nettoyage, retrait de projet, appairage, options du host). Le nombre de lignes modifiées sera plus élevé qu'aux chantiers précédents. Chaque point le donne et le justifie.
- **Les tests existants** qui appellent ces routes tournent sans PDA armé (D233) : leur comportement ne change pas.
- **Le démarrage d'une installation existante.** Sans PDA armé, rien ne change (D233). La note de version dit comment armer.

## 7. Fini quand

- Les huit actions passent par la porte, avec leur attendu.
- Le gate, l'e2e, la revue de frontière du lab et la recette de Julien sont faits.

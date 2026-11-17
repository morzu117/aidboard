# Brief pour Swairm : un CLI interactif dans la « cell Swairm » d'A-I-D

> Brief adressé au projet **Swairm** (`~/Projects/swairm`), rédigé le 2026-10-25 depuis A-I-D.
> Il dit ce que Swairm doit fournir pour qu'A-I-D ouvre, dans le terminal d'un sujet, une
> session interactive de ses commandes. Le plan de développement côté A-I-D viendra après
> la mise à jour de Swairm.
>
> Ce brief se suffit à lui-même : l'exécutant n'a pas la conversation d'origine. Ce qui n'a
> pas été vérifié est marqué **À vérifier** et regroupé au §9.

## 1. La demande

Dans la barre de lancement d'un sujet A-I-D, à côté de « Lancer claude », « Lancer codex »,
« Ouvrir un shell » et « Ouvrir la cell swarph », l'opérateur veut un bouton **« Ouvrir la
cell Swairm »**. Il ouvre, dans le terminal du sujet (un PTY), une session `swairm`
**pleinement interactive** : voir la ruche, ce qui attend l'opérateur, suivre le journal en
direct, et agir (valider, répondre, merger…) sans quitter A-I-D.

Aujourd'hui `swairm` n'offre que trois commandes de lecture, à une seule émission chacune
(`status`, `inbox`, `events [--follow]`). Lancées dans un PTY, `status` et `inbox` rendent
la main aussitôt : il n'y a rien à « ouvrir ». Le manque est côté Swairm.

**Ce que « cell » veut dire ici.** C'est une session de terminal longue, comme la cell
swarph d'A-I-D, mais ce n'est **pas** une session Claude : c'est le CLI `swairm` lui-même,
en mode session. Une cell Swairm qui serait un agent Claude doté d'outils `swairm` est une
autre piste, hors périmètre (§8).

## 2. État constaté

Relevé le 2026-10-25.

| Fait                                                                                                                                                                                                                                                   | Source                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Le clone de déploiement `~/.swairm/deploy` est à `b8ec415`, le dépôt de développement `~/Projects/swairm` à `ada34db` (chantiers 07a et 07b mergés). C'est le clone de déploiement que le lanceur `bin/swairm` exécute : il doit être mis à jour.     | `git log` des deux dépôts                                                         |
| `swairm` n'a que `status`, `inbox`, `events`. Ni `--version`, ni commande d'écriture, ni mode session.                                                                                                                                                 | `scripts/swairm.py`                                                               |
| Depuis 07b, `swairm-inbox/1` ne porte plus `livraison_a_merger` mais `revue_humaine` (avec `raisons`), et `swairm-status/1` gagne `reine: {disjoncteur, protection}`.                                                                                   | `docs/cli-swairm.md` du dépôt de développement                                    |
| Les gestes existent déjà côté store : neuf verbes (`validate_plan`, `answer`, `merge`, `unqueue`, `pause`, `resume`, `abandon`, `require_review`, `rearm`), appliqués en une transaction par `submit()`. Seul `scripts/operator_command.py` les expose. | `hatchery/operator_commands.py`, `scripts/operator_command.py`                    |
| Le chemin d'écriture prévu passe par GitHub (`/swairm <verbe>` en commentaire, accusé par réaction, `swairm-command/1`). Il dépend des chantiers 07c puis 08, **dont aucun plan n'existe encore** dans `docs/chantiers/`.                               | `docs/github-fait-foi.md` §3.1, §5, §6, §11                                       |
| Le cockpit de la ruche 2 (`scripts/cockpit.py`) n'a ni pidfile, ni garde contre un double lancement ; `scripts/start-hive.sh` lance encore la ruche 1.                                                                                                 | `docs/github-fait-foi.md` §6, `scripts/start-hive.sh`                             |
| `swairm` n'est pas sur le `PATH` de ce poste. Le lanceur résout son lien symbolique pour trouver `.venv/bin/python`.                                                                                                                                   | `bin/swairm`                                                                      |
| Boards présents : `morzu117/projet-d` (une carte « à toi », `swairm/capacitor-socle`, gare) et `morzu117/swairm-essai`.                                                                                                                                 | `swairm status` du 2026-10-25, lu avec le clone de déploiement (donc avant 07a/b) |

## 3. Ce qu'A-I-D fera, pour que Swairm sache à quoi se brancher

Le mécanisme existe déjà pour la cell swarph (`src/daemon/pty/spawn.ts`, `manager.ts`) ;
la cell Swairm en est le décalque.

- Un nouveau genre d'agent, `swairm-cell`, lancé en PTY par le daemon : `<swairm.bin> cell
--project <owner/dépôt>`.
- **Répertoire courant** : le worktree du sujet (pas le dépôt de Swairm). Le PTY est en
  `xterm-256color`, `COLORTERM=truecolor`, taille initiale fixée puis redimensionnée à
  chaque changement de fenêtre.
- **Environnement** : celui du daemon, moins les clés API retirées, plus `AID_URL`,
  `AID_TOKEN`, `AID_TOPIC`, `AID_RUN`, `AID_AGENT`, `AID_SPOOL` et les variables des hooks.
  A-I-D n'ajoutera à la cell **aucun jeton** : ni jeton GitHub, ni autre secret.
- **Arrêt par paliers** : `SIGINT`, puis `SIGTERM`, puis `SIGHUP`, puis `SIGKILL` du groupe
  de processus entier.
- **Le terminal est reflété** par un émulateur côté daemon (le sujet affiche aussi un aperçu
  du terminal sur sa carte), et la sortie brute est journalisée dans
  `~/.aid/logs/<agent>.log`.
- Réglage côté A-I-D, comme `mesh.bin` : `swairm.bin` (chemin absolu, car le `PATH` du
  daemon n'est pas celui du shell de l'opérateur) et `swairm.boards`. Vide : bouton absent.
- Le bouton ne s'affiche que si `swairm.bin` est configuré **et** qu'un board existe pour
  le dépôt du sujet.
- Tests d'A-I-D : un faux binaire (`test/fixtures/fake-swairm.sh`), jamais le vrai.

## 4. Ce que Swairm doit fournir

Chaque exigence porte un identifiant (S1…) et une phase. **Phase A** : faisable dès
maintenant, en lecture seule, sans dépendre de 07c ni de 08. **Phase B** : l'écriture, qui
suit le chantier 08.

### 4.1 La session (phase A)

**S1. Une commande `swairm cell`.** Elle ouvre une session interactive sur un projet et ne
rend la main que quand l'opérateur quitte. Forme libre (boucle de commandes ou interface
plein écran), à choisir dans le chantier Swairm. Ce qui est exigé :

- un en-tête qui dit le projet, le nombre d'éléments « à toi », et l'âge de la dernière
  lecture ;
- les trois lectures actuelles, appelables sans quitter la session : `status`, `inbox` et
  `events` ;
- un **suivi en direct** : un nouvel élément dans la boîte, ou un nouvel événement, apparaît
  sans commande de l'opérateur, en moins de 3 secondes (la relecture de `--follow` est déjà
  de 2 s) ;
- un détail par sujet : titre, état, colonne, plan courant (version, pas, but de chaque
  pas), décision ouverte avec ses options, tête de livraison, et le signal « revue
  humaine » avec ses `raisons` ;
- une aide en ligne (`help`) et une sortie propre (`quit`, `Ctrl-D`).

**S2. Le projet se déduit du répertoire.** Sans `--project`, `swairm cell` lit
`git remote get-url origin` du répertoire courant et en tire `owner/dépôt` (A-I-D accepte
aussi un dépôt **sans** `origin` : `src/daemon/routes/workspaces.ts:108`, projet purement
local). Sans remote lisible, ou si aucun board ne correspond, la session s'ouvre sur la
liste des projets de la machine au lieu d'échouer. `--project` reste prioritaire.

**S3. Discipline de terminal.** La session tourne dans un PTY sans qu'on lui dise rien :

- elle détecte le terminal (`isatty`), et **refuse de démarrer sans TTY** (code 2, message
  sur `stderr`) ; les commandes non interactives actuelles ne changent pas ;
- largeur et hauteur lues sur le terminal, et relues à chaque `SIGWINCH` ; aucun
  alignement qui dépende de caractères larges ;
- couleurs coupées par `NO_COLOR` et quand la sortie n'est pas un terminal ; rien d'autre
  que `xterm-256color` n'est supposé ;
- aucun paginateur (`less`, `more`) ;
- si l'écran alternatif est utilisé, il est **toujours** quitté et le terminal restauré
  (mode brut, curseur) à la sortie, y compris sur signal ou exception.

**S4. Les signaux d'A-I-D.** A-I-D arrête un agent par `SIGINT`, puis `SIGTERM`, puis
`SIGHUP`, puis `SIGKILL`. La session doit :

- sortir **tout de suite**, code 0, terminal restauré, sur `SIGTERM` et `SIGHUP` ;
- sur `SIGINT` : annuler l'opération en cours (un suivi d'événements, par exemple) et
  revenir à l'invite ; sur une invite vide, **sortir** (sinon l'arrêt par palier attend le
  `SIGTERM` pour rien) ;
- ne laisser aucun processus enfant : s'il en lance, ils partent avec elle.

**S5. Une invite stable.** A-I-D estime l'état d'un agent sans hook d'après le silence du
terminal et la détection d'une invite. La cell doit donc afficher, quand elle attend
l'opérateur, une invite **toujours la même** et facile à reconnaître. La forme est à fixer
avec A-I-D (§9, Q4).

**S6. Reprise.** Quitter puis rouvrir ne perd rien : l'état vit dans les boards, jamais dans
la session. Un historique de commandes est gardé sous `~/.swairm/` (jamais dans le dépôt de
l'opérateur, jamais dans le worktree).

**S7. Lecture hors ligne.** La session marche ruche éteinte, GitHub injoignable et cockpit
arrêté, comme `status` aujourd'hui. Un board illisible (code 3 de la commande actuelle)
s'affiche comme un message, sans fermer la session.

### 4.2 La mise en route (phase A)

**S8. `swairm --version`.** Rend le numéro de version et le **schéma de board attendu**.
A-I-D s'en sert pour distinguer « CLI trop ancien pour ce board » d'une panne.

**S9. `swairm doctor [--json]`.** Un diagnostic lisible par `aid doctor`, format versionné
`swairm-doctor/1`. Chaque ligne : un nom, un état (`ok`, `avertissement`, `erreur`), un
message, et un correctif quand il y en a un. Contrôles attendus :

- le CLI et son interpréteur (`.venv`) sont lancables ;
- le dossier des boards est lisible ; chaque board est lisible et d'un schéma compatible ;
- la ruche (cockpit) tourne-t-elle sur ce dépôt ? (à défaut d'un lanceur, dire « inconnu ») ;
- `gh` est authentifié (utile dès la phase B) ;
- la sonde de protection de branche (le champ `reine.protection`).

**S10. Un lancement rapide.** Le démarrage de la session doit rester de l'ordre de la
seconde : l'opérateur la rouvre souvent. À mesurer, pas à supposer (§9, Q5).

### 4.3 Agir (phase B, après 07c et 08)

Ces exigences s'appuient sur le chantier 08 (« CLI en écriture et pilotage ») et sur
`swairm-command/1`. **Ne pas les construire avant** : un second chemin d'écriture, local,
contredirait la règle « ce qui n'est pas sur GitHub n'a pas eu lieu ».

**S11. Les sept verbes dans la session**, plus `revue-humaine`, `rearmer`, `new` et
`hive start|stop|status`. Chacun passe par le **même code** que la commande autonome
(`swairm validate …`), jamais par un sous-processus, et rend un `swairm-command/1`
(`applique`, `refuse`, `en_attente`, raison, lien du commentaire).

**S12. Agir depuis la boîte.** Sur un élément de l'inbox, la session propose l'action prête
à lancer (le champ `actions` prévu au §6 de `docs/github-fait-foi.md`) :

| Élément               | Ce que l'opérateur voit avant d'agir                       | Geste                     |
| --------------------- | ---------------------------------------------------------- | ------------------------- |
| `plan_a_valider`      | but et périmètre de chaque pas, version du plan            | `validate` (version)      |
| `decision`            | la question, les options numérotées                        | `answer` (un numéro)      |
| `revue_humaine`       | la tête, les `raisons`, le verdict de la Reine             | `merge` (tête) ou retenir |
| `sujet_gare`          | pourquoi il est garé, dernier événement                    | `resume`, `abandon`       |
| `commande_en_attente` | la commande postée, depuis quand, la raison de l'attente   | rien (lecture)            |

**S13. Confirmation selon la gravité.**

- Les gestes **réversibles** (`pause`, `resume`, `unqueue`, `answer`) : une confirmation
  d'une touche.
- Les gestes **irréversibles** (`merge`, `abandon`) : l'opérateur **retape** l'identifiant
  du sujet, et la session affiche ce qui va être fait (version du plan, tête mergée).
- Aucune confirmation ne s'enregistre d'avance : pas de « toujours oui ».

**S14. Le trou des agents locaux.** Sur le poste, `gh` est authentifié pour tout le compte :
un agent Claude lancé par A-I-D dans le même worktree pourrait taper `swairm validate`
(risque du §9 de `docs/github-fait-foi.md`). Les commandes d'écriture doivent donc :

- exiger un TTY ou un `--yes` explicite ;
- ne jamais lire de réponse sur un tube ou un fichier ;
- une écriture lancée **par la session** se fait dans son processus, sous la confirmation
  de S13 ; un `--yes` hors session reste possible mais est **journalisé** avec la source
  (`AID_AGENT`, s'il est défini).

La parade complète n'est pas décidée (§9, Q3). Ce brief ne prétend pas la fermer.

**S15. Pas d'attente muette.** Une commande en attente d'accusé (20 s par défaut) affiche
un compte à rebours ; passé le délai, la session dit `en_attente` et la garde dans la
liste, au lieu d'échouer.

## 5. Ordre proposé

| Étape | Contenu                                                        | Dépend de      |
| ----- | -------------------------------------------------------------- | -------------- |
| 0     | Mettre à jour le clone de déploiement ; lier `swairm` au PATH  | rien           |
| 1     | S8 et S9 : `--version` et `doctor`                             | 0              |
| 2     | S1 à S7 : la session en lecture                                | 0              |
| 3     | A-I-D : le bouton « Ouvrir la cell Swairm » (plan à écrire)    | 1 et 2         |
| 4     | S11 à S15 : l'écriture dans la session                         | 07c, puis 08   |

Pour Swairm, l'étape 2 est un chantier à part entière (par exemple « 06b »), indépendant des
chantiers 07c et 08 ; l'étape 4 se range **dans** le chantier 08.

## 6. Critères d'acceptation

Testables sans réseau ni GitHub, avec un board de test et un PTY :

1. `swairm cell` lancé sans TTY (stdin fermé, ou tube) sort en code 2 sans rien écrire sur
   `stdout`.
2. Lancé dans un PTY, il affiche l'en-tête et l'invite, et `inbox` y rend les mêmes éléments
   que `swairm inbox --json`.
3. Un événement ajouté au board pendant la session s'affiche en moins de 3 secondes.
4. `SIGTERM` : sortie en moins de 1 seconde, code 0, terminal restauré (mode brut quitté,
   curseur visible, écran alternatif quitté).
5. `SIGINT` à l'invite vide : sortie propre. `SIGINT` pendant un suivi : retour à l'invite.
6. Redimensionner le PTY (`SIGWINCH`) réajuste la mise en page sans caractère perdu, de 80 à
   200 colonnes.
7. Avec `NO_COLOR=1`, aucune séquence d'échappement de couleur n'est écrite.
8. Un board illisible, ou d'un schéma plus récent, s'affiche comme un message ; la session
   reste ouverte.
9. `swairm --version` et `swairm doctor --json` rendent un format versionné, un code de
   sortie stable, et le correctif de chaque erreur.
10. (Phase B) Un geste irréversible refusé à la confirmation n'écrit **rien** sur GitHub ni
    au board.

## 7. Ce qui ne change pas

- `status`, `inbox`, `events` gardent leurs formats `/1`, leurs options et leurs codes de
  sortie. La session s'**ajoute** ; elle ne remplace rien. A-I-D les appellera encore sans
  TTY (`< /dev/null`).
- Le CLI n'écrit rien dans les boards en lecture (`mode=ro` ou `immutable=1`).
- A-I-D ne lit jamais un board SQLite directement : tout passe par le CLI.

## 8. Hors périmètre

- Une cell Swairm sous forme de **session Claude** qui piloterait la ruche avec des outils
  (comme `swarph spawn`). À examiner plus tard, avec le chantier 09 côté A-I-D.
- Le suivi permanent par le daemon d'A-I-D (le « v0.4 » de lecture seule : `events --follow`
  consommé en continu, raison `hive`, agents `swairm-drone` distants). Il vit à côté de la
  cell, pas dedans.
- La création de sujets A-I-D « par la ruche » (`swairm new` depuis le dialogue de création).
- Toute gestion de jeton ou d'identité GitHub par A-I-D.

## 9. Questions ouvertes et points à vérifier

| #   | Question                                                                                                                                                                                                               | Qui tranche           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Q1  | **La forme de la session** : une boucle de commandes (simple, robuste, lisible dans l'aperçu du terminal), ou une interface plein écran (plus riche, mais écran alternatif et redessin sous un émulateur côté daemon) ? | l'opérateur et Swairm |
| Q2  | Faut-il une cell **par projet**, ou une seule qui change de projet ? A-I-D n'impose rien ; il refusera de lancer deux sessions identiques sur un même projet.                                                          | l'opérateur           |
| Q3  | **La parade du §9 de `github-fait-foi`** (un agent local qui poste sous l'identité de l'opérateur) : TTY exigé, `--yes` journalisé, ou jeton distinct pour l'opérateur dans A-I-D ?                                     | l'opérateur           |
| Q4  | **La forme de l'invite** que le daemon reconnaît. Je n'ai pas lu la détection d'invite d'A-I-D ; elle sera lue au plan A-I-D, et la forme figée ici d'un commun accord.                                                | A-I-D, au plan        |
| Q5  | **Temps de démarrage** du CLI Python sous `.venv` : non mesuré.                                                                                                                                                       | Swairm, à mesurer     |
| Q6  | L'**émulateur du daemon** rend-il fidèlement le mode d'écran retenu en Q1 (souris, écran alternatif, redimensionnement) ? Non vérifié.                                                                                | A-I-D, au plan        |
| Q7  | Les chantiers **07c et 08** : leur plan n'existe pas ; leur calendrier décide quand arrive la phase B. Si l'opérateur veut agir plus tôt, la seule voie existante est `scripts/operator_command.py` (écriture locale, source `script`), **à l'encontre** de « GitHub fait foi ». | l'opérateur           |
| Q8  | Le **lanceur du cockpit** (S9 : « la ruche tourne-t-elle ? ») n'existe pas encore (D13).                                                                                                                               | Swairm, chantier 08   |

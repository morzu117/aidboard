# 10 — Décommission de gbrain : récupérer la connaissance, puis retirer les composants

Branche : `chore/decommission-gbrain`, depuis `main`.

## 1. Pourquoi

Décision prise le 2026-10-17 : gbrain est décommissionné partout, pas seulement « déprécié
depuis 0.9.0, retrait prévu en 1.0 » comme le disait jusqu'ici `kernel/adapters/gbrain.md`. La
capacité `memory` est déjà portée par `aid` (chantier 06) ; gbrain ne rend plus aucun service
que `aid mem` ne rende pas. Mais avant de retirer un composant, il faut avoir récupéré ce qu'il
contenait — la migration 0.9.0 (`kernel/CHANGELOG.md`, entrée `[0.9.0]`) avait déjà planifié ce
geste (étape 4 : `bun remove -g gbrain`, retrait des secrets, suppression du projet Supabase)
mais **ne l'a jamais exécuté jusqu'au bout** : vérifié le 2026-10-17 sur ce poste, gbrain est
toujours installé, les secrets (`VOYAGE_API_KEY`, `GBRAIN_DATABASE_URL`) sont toujours dans
`~/.config/agent-kernel/secrets.env`, et surtout il reste des pages non récupérées.

Ce chantier n'est pas une réécriture de politique : `policy/*.md` ne nomme déjà que des rôles,
jamais gbrain. C'est un chantier d'exécution — recenser ce qui est réellement récupérable,
le récupérer vérifiablement, puis seulement retirer les composants (fichier adaptateur,
références, binaire, secrets, base distante).

## 2. État actuel

Vérifié le 2026-10-17 (`gbrain sources list --json`, `gbrain status default --json`,
échantillonnage par source) :

| Source    | Chemin local                        | Pages | Dernière synchro        | Nature |
| --------- | ------------------------------------ | ----- | ------------------------ | --- |
| `default` | `~/.gbrain/sources/default`          | 418   | **jamais** (`null`)      | orpheline, pas de dépôt git associé. **Traitée (10.1, 2026-10-17)** : 346 transcripts + 23 cartes swairm `verdict: périmée` + 21 dev-handoff klasso non validés + 2 pages bruit gardés au froid dans le backup ; 26 fichiers extraits en 29 pages `aid mem` (détail : `~/.aid/backups/gbrain-2026-10-17/default/TRIAGE-10.1.md`). |
| `klasso`  | `~/Projects/myskooli`                | 1202  | 2026-09-24 (540h, severe) | **Traitée (10.2, 2026-10-17)** : 1085 pages (`code`/`design_wf`/`docs`/`style`/`packages`/meta) redondantes avec le dépôt git, vérifiées par contenu, écartées ; 6 pages mortes ou doublons écartées ; 111 extraites en `aid mem` (dont 1 nouveau namespace `versos/`, un projet découvert en triage). Détail : `~/.aid/backups/gbrain-2026-10-17/klasso/TRIAGE-10.2.md`. |
| `swairm`  | `~/Projects/swairm`                  | 153   | 2026-10-15 (fresh)        | **Traitée (10.3, 2026-10-17)** : 83 pages (`code`/`design`/`docs`/`morphs`/notes racine) redondantes avec le dépôt git ou doublons exacts de pages déjà extraites en 10.1, écartées ; 70 pages de cycle (`swairm/swairm/{dev-handoff,plan,review,retro}/*`) extraites sous `swairm/{dev-handoff,plan,review,retro}/*`. Détail : `~/.aid/backups/gbrain-2026-10-17/swairm/TRIAGE-10.3.md`. |
| `descent-wf` | `~/Projects/descent-wf`           | 152   | 2026-10-15 (fresh)        | **Traitée (10.4, 2026-10-17)** : 71 pages (`design`/`docs`/`ressources`/`tools`/notes racine + 1 page de test) redondantes avec le dépôt git ou sans valeur, écartées ; 81 pages extraites (`descent-wf/{dev-handoff,plan,review}/*`, 56 ; `swairm/{anticipation,decisions,reine}/*`, 25). Détail : `~/.aid/backups/gbrain-2026-10-17/descent-wf/TRIAGE-10.4.md`. |
| `lessons` | `~/.agent-kernel` (= agent-kernel)    | 48    | 2026-10-15 (fresh)        | **déjà redondant** : vérifié page à page, c'est une réindexation du contenu déjà commité d'agent-kernel (`adapters/`, `policy/`, `roles/`, `commands/sync.md`) plus les leçons déjà présentes dans `aid mem` sous un slug légèrement différent (accents normalisés différemment). Rien d'unique à récupérer ici. |

Aucun des quatre projets réels (myskooli, swairm, descent-wf — hors `default`, orpheline) n'a de
mirroir markdown commité de ses pages gbrain : seuls `.gbrain-owner.json` et
`.git/gbrain-managed.json` (métadonnées internes de gbrain) existent dans leurs dépôts. Le
contenu des pages n'existe **qu'en base** (Supabase, `GBRAIN_DATABASE_URL`).

`aid mem list` (sur ce poste) : 25 pages, toutes `lesson/*`. Aucune ne porte de préfixe
`swairm/`, `myskooli/` ou `descent-wf/` — la taxonomie transverse (`lesson/<domaine>/<slug>`,
`policy/namespace.md`) est déjà en place côté `aid`, mais rien des quatre sources à risque n'y a
encore été extrait.

Le binaire `gbrain` (`bun`, `github:garrytan/gbrain#ea93c77`) est installé sur ce poste ; un
fichier `.gbrain-owner.json` (untracked) existe aussi à la racine d'`agent-kernel` lui-même.

## 3. Cible et hors-périmètre

Cible : chaque page des quatre sources à risque (`default`, `klasso`, `swairm`, `descent-wf`)
est, selon sa nature, soit (a) extraite dans `aid mem` sous un namespace cohérent avec
`policy/namespace.md`, soit (b) explicitement jugée superflue et journalisée comme telle (pas
silencieusement perdue) — jamais la troisième option implicite (ni gardée, ni actée). Une fois
les quatre sources traitées et vérifiées, gbrain est retiré : `kernel/adapters/gbrain.md`,
toute référence dans `commands/sync.md`/`manifest.schema.yml`/`defaults.yml`, le binaire
(`bun remove -g gbrain`), les secrets (`VOYAGE_API_KEY`, `GBRAIN_DATABASE_URL`), et in fine le
projet Supabase (geste de Julien, hors d'atteinte d'un agent).

Hors périmètre :

- La source `lessons` : déjà vérifiée redondante (§2), rien à en extraire. Elle disparaît
  mécaniquement avec le retrait du binaire, pas de point dédié.
- Toute réécriture de `policy/*.md`/`roles/*.md` : ils ne nomment déjà pas gbrain.
- La suppression du projet Supabase lui-même et la révocation de la clé Voyage — actions de
  compte externes, décrites en 10.6 mais exécutées par Julien, pas par un agent.
- Les autres postes qui auraient leur propre installation gbrain — ce chantier couvre ce poste ;
  « pour tous » (la décision de principe) se vérifie projet par projet si un autre poste a
  encore une source active, pas supposé réglé par ce seul passage.

## 4. Décisions prises

- Décommission complète de gbrain décidée (Julien, 2026-10-17) — plus de statut « déprécié,
  toléré » : un retrait net, après récupération vérifiée.
- Chantier dédié, exécuté source par source, avec vérification avant tout retrait de composant
  (Julien, 2026-10-17, en réponse à l'ampleur réelle découverte : ~1925 pages hors `lessons`,
  dont 418 jamais synchronisées).

Décisions ouvertes (à valider par Julien, une par point d'exécution) :

- **DO1 — Format de récupération par type de page.** Un `concept` de type `dev-handoff` ou
  `decisions` est probablement une connaissance durable (namespace transverse ou projet) ; un
  `concept` de type `anticipation` sur une issue déjà fermée, ou un `code` qui n'est qu'un
  snapshot d'un fichier toujours présent dans le dépôt git du projet, est probablement sans
  valeur ajoutée sur ce que git donne déjà. Pas de règle générale fiable sans relire un
  échantillon par source — à trancher au moment de chaque point (10.1-10.4), pas ici.
- **DO2 — Namespace cible dans `aid mem`.** Décidée (Julien, 2026-10-17) : mixte. Préfixe projet
  (`klasso/…`, `swairm/…`) pour le contenu propre à un projet (notes, décisions, design, docs,
  timelines) ; `lesson/<domaine>/<slug>` pour le généralisable au-delà du projet d'origine
  (insights opérationnels, rétros de process). Appliquée pour 10.1 (voir TRIAGE-10.1.md) ; à
  reconduire pour 10.2-10.4.
- **DO3 — Ordre des sources.** `default` (orpheline, jamais synchronisée, le risque le plus
  ancien) d'abord, ou les projets actifs (`klasso`, plus gros volume) d'abord ? Proposé : `default`
  d'abord — c'est la seule qui n'a strictement aucune autre copie, nulle part.

## 5. Contrat

Pour chaque source traitée (un point du plan) :

1. Export brut intégral (`gbrain list --source <id>` puis lecture page à page, ou export natif
   si `gbrain` en propose un) vers un fichier hors du dépôt (`~/.aid/backups/gbrain-<source>-
   <date>.jsonl` ou équivalent) — **avant** toute triage. Ce fichier est la garantie anti-perte :
   si le triage se trompe, la donnée brute reste récupérable.
2. Triage par type (DO1) : classement explicite de chaque page en « à extraire dans `aid mem` »
   ou « jugée superflue », jamais un troisième statut implicite.
3. Écriture dans `aid mem` des pages retenues (DO2 pour le namespace), par `aid mem put`.
4. Vérification : comptage avant/après, échantillon relu côté `aid mem search`/`aid mem get`.
5. Rapport : combien de pages, combien extraites, combien écartées et pourquoi (même bref).

Pas de suppression de composant gbrain avant que les quatre sources à risque (10.1-10.4) soient
closes et vérifiées.

## 6. Points

### 10.1 — Source `default` (418 pages, jamais synchronisée) — **fait (2026-10-17)**

Export réutilisé (backup déjà présent, complet et vérifié). Triage intégral page par page :
392 pages gardées au froid dans le backup (346 transcripts, 23 cartes swairm `verdict: périmée`,
21 dev-handoff klasso `agent_written`/non validés redondants avec git, 2 pages bruit), 26
fichiers extraits en 29 pages `aid mem` (namespace mixte DO2 : `klasso/…`, `swairm/…`,
`lesson/<domaine>/…`). Détail et justification page-type par page-type :
`~/.aid/backups/gbrain-2026-10-17/default/TRIAGE-10.1.md`. Vérifié par `aid mem list`/`get`/
`search` sur un échantillon.

### 10.2 — Source `klasso` / myskooli (1202 pages) — **fait (2026-10-17)**

Confirmé : les pages `code` (920) ainsi que `design_wf`/`docs`/`style`/`packages`/les 4 fichiers
meta racine (165 de plus, 1085 au total) correspondent à des fichiers toujours présents et à
jour dans le dépôt `myskooli` (vérifié par contenu, pas que par chemin) — écartées sans
extraction. Le reste (`memoire`, cycles `dev-handoff`/`plan`/`review`/`retro`, 4 pages `swairm`
capturées par erreur d'attribution) a été trié page par page : 111 extraites dans `aid mem`
(`klasso/memoire/*`, `lesson/<domaine>/*`, `klasso/{dev-handoff,plan,review,retro}/*`,
`swairm/{decisions,reine}/*`, et un nouveau namespace `versos/*` pour un projet découvert en
triage), 6 écartées (1 page morte sur gbrain lui-même, 5 doublons vérifiés de leçons déjà
présentes). Détail : `~/.aid/backups/gbrain-2026-10-17/klasso/TRIAGE-10.2.md`.

### 10.3 — Source `swairm` (153 pages) — **fait (2026-10-17)**

Confirmé : les pages `code` (38), `design` (7/10, les 3 restantes étant des doublons exacts du
trio déjà extrait en 10.1 sous `swairm/design/overlord-upgraded/*`), `docs` (32, y compris
`docs/multi-agent/readme-1.md` = capture mal slugifiée de `README (1).md` du dépôt), `morphs`
(1) et les notes racine `agents.md`/`claude.md` (dépassées par le dépôt) — 83 pages au total —
sont redondantes avec le dépôt `swairm` ou doublons d'extractions antérieures, écartées sans
extraction. Le reste, `swairm/swairm/{dev-handoff,plan,review,retro}/*` (70 pages, cycles réels
des slices A-J de swairm elle-même), a été extrait tel quel sous
`swairm/{dev-handoff,plan,review,retro}/*` : les leçons durables citées dans les rétros étaient
déjà présentes dans `aid mem` (vérifié avant extraction), donc rien à dupliquer côté `lesson/` —
seule la trace de cycle (coût, PR, findings) manquait. Détail :
`~/.aid/backups/gbrain-2026-10-17/swairm/TRIAGE-10.3.md`.

### 10.4 — Source `descent-wf` (152 pages) — **fait (2026-10-17)**

Même profil que swairm (§10.3), même traitement. Confirmé : `design` (3), `docs` (63, y compris
`plans/01-30`, `handoffs/*`, `releves/acte-1/*`), `ressources` (1), `tools/skill_editor` (1) et
les notes racine `agents.md`/`claude.md` (dépassées par le dépôt) — 70 pages — sont redondantes
avec le dépôt `descent-wf` ; `swairm/preflight-test.md` (1) est une page de test triviale. Total
écarté : 71. Le reste (81 pages) a été extrait : `descent-wf/{dev-handoff,plan,review}/*` (56,
cycles réels du moteur de règles, aucun dossier `retro` dans cette source) et
`swairm/{anticipation,decisions,reine}/*` (25 cartes de la ruche swairm travaillant sur ce
dépôt — 3 anticipations **validées** cette fois, à la différence des 23 `périmée` de 10.1 ;
10 décisions + 12 tours de reine avec PR réelles). Vérifié non dupliqué dans le backup de la
source `swairm` elle-même. Détail : `~/.aid/backups/gbrain-2026-10-17/descent-wf/TRIAGE-10.4.md`.

Les quatre sources à risque (`default`, `klasso`, `swairm`, `descent-wf`) sont closes. Reste
10.5 (retrait des composants) et 10.6 (geste externe, Julien).

### 10.5 — Retrait des composants — **fait (2026-10-17)**

Dans `agent-kernel` (commit `bbc4cd8`, poussé sur `origin main`) : `adapters/gbrain.md`
supprimé, `commands/sync.md` (l'avertissement « adapter: gbrain, déprécié » du §2 bis retiré —
un manifeste qui déclarerait encore cet adaptateur tombe désormais dans la règle générale
« capacité déclarée mais absente »), `manifest.schema.yml` (l'exemple de capacité à options
utilise `aid`, plus `gbrain`), `CHANGELOG.md` (entrée `[1.0.0]`, distincte de `[0.9.0]` qui
n'annonçait que la dépréciation), `VERSION` passé à `1.0.0`. Les mentions de `gbrain` restant
dans `CHANGELOG.md` (versions passées) et `docs/chantiers/01-04` (chantiers déjà clos de la
migration 0.9.0) sont laissées telles quelles : historique, pas prescriptif.

Côté machine : `bun remove -g gbrain` (vérifié : plus dans le `PATH`), `VOYAGE_API_KEY` et
`GBRAIN_DATABASE_URL` retirés de `~/.config/agent-kernel/secrets.env` (sauvegarde locale
`secrets.env.bak-10.5`, jamais commitée), `.gbrain-owner.json` et `.git/gbrain-managed.json`
supprimés dans les quatre projets concernés (`agent-kernel`, `myskooli`, `swairm`, `descent-wf`).

`npm run gate` (aidboard) vert (commit `29964b5`) : les 4 échecs rencontrés en premier passage
(`test/memory-routes.test.ts`, `test/cli-mem.test.ts`) n'étaient pas une régression de ce point —
sans `memory.embeddings.provider: off` explicite, un daemon de test détecte le vrai Ollama
installé sur ce poste et bascule en recherche hybride au lieu de `fts`. Même classe de piège que
`structuralEngine` (chantier 08) côté structurel, sans son équivalent côté mémoire ; corrigé dans
`test/helpers/daemon.ts` et `test/cli-mem.test.ts`.

### 10.6 — Geste externe (Julien) — **fait (2026-10-17)**

Projet Supabase (`db.mlkiwejhkgkojflvvuxl.supabase.co`) supprimé et clé Voyage
(`dash.voyageai.com`) révoquée, par Julien — accès à des comptes externes, non automatisable.
Une fois confirmé, `~/.config/agent-kernel/secrets.env.bak-10.5` (sauvegarde locale prise avant
le retrait des secrets en 10.5) a été supprimé : son seul rôle était de couvrir la fenêtre entre
le retrait des secrets et la suppression effective des comptes externes.

**Chantier 10 clos.** Les quatre sources à risque sont récupérées et vérifiées dans `aid mem`,
les composants gbrain sont retirés d'`agent-kernel`, et les deux comptes externes sont
supprimés/révoqués.

## 7. Pièges

- Ne jamais retirer un composant gbrain avant que toutes les sources à risque (10.1-10.4) soient
  closes : le binaire désinstallé ou les secrets retirés rendent les pages restantes
  irrécupérables.
- La source `default` n'a pas de `local_path` git — son export est la seule sauvegarde possible
  avant tout accès perdu à Supabase. Ne pas la traiter en dernier en se fiant à sa petite taille
  relative : c'est la plus fragile, pas la plus grosse qui compte ici.
- Les pages `code` de `klasso` peuvent sembler redondantes avec git alors qu'elles datent d'un
  état du fichier déjà réécrit depuis — comparer le contenu, pas seulement l'existence du
  chemin, avant d'écarter.
- Une page gbrain « cyclique » (namespace projet) qui n'a pas encore sa retro écrite n'est pas
  superflue : c'est un cycle en cours, pas un déchet.
- Le décompte de `lessons` (48) contre `aid mem` (25) a un écart qui n'est **pas** une perte —
  vérifié : différence de normalisation de slug (accents), pas de contenu manquant. Ne pas
  reproduire cette confusion pour les autres sources sans la même vérification page à page.
- Une source gbrain peut contenir des pages d'un **autre projet que celui qu'elle nomme** :
  10.2 (source `klasso`) contenait 4 pages `swairm` (ruche qui travaillait sur ce dépôt) et 1
  page `versos` (un projet jamais mentionné dans ce chantier, capturé par erreur
  d'attribution). Vérifier qu'un titre/chemin correspond vraiment au projet de la source avant
  de le classer dans son namespace — sinon il finit dans le mauvais dossier ou, pire, écarté à
  tort comme bruit.
- Un titre de page `memoire`/`feedback-*` peut être tronqué par l'export gbrain (~80 caractères
  + `…`) ; le champ `description:` du frontmatter est la source fiable pour reconstituer un
  titre complet avant d'écrire dans `aid mem` — ne pas importer le titre tronqué tel quel.
- Un même handoff peut être capturé deux fois sous deux dossiers différents (10.3 : le trio
  `design_handoff_swairm_overlord-2/*` est un doublon exact de `overlord-upgraded/*` déjà extrait
  en 10.1) — toujours diffuser le contenu contre les pages déjà extraites avant de conclure
  « absent du dépôt donc à garder ». De même, un fichier au nom gbrain « propre »
  (`readme-1.md`) peut correspondre à un fichier réel au nom mal formé côté dépôt
  (`README (1).md`, espace + parenthèse) — vérifier par contenu avant de conclure à une
  absence.
- Toutes les cartes `anticipation` ne sont pas périmées : celles de 10.1 l'étaient (23/23,
  `verdict: périmée`) mais celles de 10.4 étaient `verdict: validée` (proposition réalisée, PR
  citée) — toujours lire le champ `verdict`, ne jamais présumer du statut par type de page seul.
- Un sous-dossier `swairm/` dans une source projet (`klasso` en 10.2, `descent-wf` en 10.4) n'est
  pas forcément une erreur d'attribution : c'est aussi la convention de la ruche pour classer ses
  propres cartes (décisions, tours de reine, anticipations) par type d'auteur plutôt que par
  projet, même quand leur contenu appartient bien au projet de la source. Vérifier le contenu
  (nom du projet cité, numéros d'issue absents du backup `swairm` lui-même) avant de conclure à
  une mauvaise attribution.

## 8. Fini quand

- [x] Les quatre sources à risque (`default`, `klasso`, `swairm`, `descent-wf`) ont un export brut
  sauvegardé, un triage explicite et journalisé, et leurs pages retenues sont dans `aid mem`,
  vérifiées par échantillon.
- [x] `adapters/gbrain.md` et toute référence prescriptive à gbrain dans `agent-kernel` ont
  disparu.
- [x] Le binaire gbrain est désinstallé sur ce poste, les secrets retirés de
  `~/.config/agent-kernel/secrets.env`.
- [x] `CHANGELOG.md` porte l'entrée de retrait effectif (`[1.0.0]`).
- [x] `npm run gate` (aidboard) vert.
- [x] Julien a traité le geste externe (10.6) : projet Supabase supprimé, clé Voyage révoquée,
  sauvegarde locale des secrets supprimée.

**Chantier terminé le 2026-10-17.**

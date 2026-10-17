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
| `default` | `~/.gbrain/sources/default`          | 418   | **jamais** (`null`)      | orpheline, pas de dépôt git associé. Mélange `concept`/`note`/`timeline`/`transcript`/`learning` — un modèle de données plus ancien que les sources fédérées actuelles. |
| `klasso`  | `~/Projects/myskooli`                | 1202  | 2026-09-24 (540h, severe) | projet réel (myskooli). Contient des snapshots de code (`packages/ai/...json`), des pages `dev-handoff`, `decisions`, `memoire`. |
| `swairm`  | `~/Projects/swairm`                  | 153   | 2026-10-15 (fresh)        | projet réel. `concept` (anticipation, décisions, review, retro) et quelques `note`. |
| `descent-wf` | `~/Projects/descent-wf`           | 152   | 2026-10-15 (fresh)        | projet réel, même profil que swairm. |
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
- **DO2 — Namespace cible dans `aid mem`.** Garder le préfixe projet tel que gbrain le portait
  (`myskooli/…`, `swairm/…`) ou normaliser vers `lesson/<domaine>/<slug>` quand la page est
  généralisable au-delà du projet d'origine ? Les deux cas existent dans l'échantillon lu.
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

### 10.1 — Source `default` (418 pages, jamais synchronisée)

La plus ancienne, la plus à risque : aucune autre copie n'existe. Export intégral, triage par
type (`concept`/`note`/`timeline`/`transcript`/`learning` — échantillon §2), extraction dans
`aid mem`.

### 10.2 — Source `klasso` / myskooli (1202 pages)

Le plus gros volume. Les pages `code` (snapshots `packages/ai/...json`) : vérifier d'abord
qu'elles correspondent à des fichiers toujours présents et à jour dans le dépôt `myskooli` —
si oui, écartées sans extraction (git fait déjà ce travail). Le reste (`dev-handoff`,
`decisions`, `memoire`) : triage normal.

### 10.3 — Source `swairm` (153 pages)

Essentiellement des pages `concept` de cycle (anticipation, décisions, review, retro). Le
chantier 09 (fusion du noyau) a déjà établi que les pages projet-préfixées sont cycliques et
purgent après retro (`policy/namespace.md`) — vérifier combien de ces 153 pages sont des cycles
déjà clos (retro écrite) dont les leçons durables sont déjà extraites ailleurs, avant de décider
quoi garder.

### 10.4 — Source `descent-wf` (152 pages)

Même profil que swairm (§10.3), même traitement.

### 10.5 — Retrait des composants

Après 10.1-10.4 vérifiés : `kernel/adapters/gbrain.md` supprimé, `commands/sync.md` §2bis
(l'avertissement « adapter: gbrain, déprécié ») retiré, `manifest.schema.yml` (gbrain comme
valeur d'adaptateur valide) retiré, entrée `kernel/CHANGELOG.md` documentant le retrait effectif
(distincte de l'entrée `[0.9.0]` qui ne faisait qu'annoncer la dépréciation). Côté machine :
`bun remove -g gbrain`, retrait de `VOYAGE_API_KEY`/`GBRAIN_DATABASE_URL` de
`~/.config/agent-kernel/secrets.env`, suppression de `.gbrain-owner.json` dans chaque projet
concerné (agent-kernel, myskooli, swairm, descent-wf) et de `.git/gbrain-managed.json`.

### 10.6 — Geste externe (Julien)

Suppression du projet Supabase (`db.mlkiwejhkgkojflvvuxl.supabase.co`) et révocation de la clé
Voyage (`dash.voyageai.com`). Décrit ici pour mémoire, pas exécuté par un agent — accès à des
comptes externes.

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

## 8. Fini quand

- Les quatre sources à risque (`default`, `klasso`, `swairm`, `descent-wf`) ont un export brut
  sauvegardé, un triage explicite et journalisé, et leurs pages retenues sont dans `aid mem`,
  vérifiées par échantillon.
- `kernel/adapters/gbrain.md` et toute référence à gbrain dans `kernel/` ont disparu.
- Le binaire gbrain est désinstallé sur ce poste, les secrets retirés de
  `~/.config/agent-kernel/secrets.env`.
- `kernel/CHANGELOG.md` porte l'entrée de retrait effectif.
- `npm run gate` (aidboard) vert.
- Julien a traité le geste externe (10.6) de son côté — pas une condition de clôture du chantier
  lui-même, juste la dernière case non automatisable.

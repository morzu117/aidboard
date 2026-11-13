# Chantier 50 : les e2e après D314

| Champ | Valeur |
|---|---|
| État | **Révision 0, 13 novembre 2026.** Julien a demandé de regarder les e2e après le merge du 49. |
| Emplacement final | `docs/chantiers/50-e2e-env.md` sur `main` |
| Base | `main`, après le merge du 49 (#161). |
| Organisation | La cell de gestion de Julien gère le chantier. Un agent Codex CLI fait la correction sur un brief tiré de ce plan. La cell de gestion relit le diff, lance le gate et l'e2e, commite et ouvre la PR. |
| Validation | Seuls les tests changent, et D314 reste tel quel : le lab ne relit pas ce chantier. Julien donne son oui pour le merge, CI verte. |

## 1. Le constat

Sur `main`, 9 des 10 e2e de `e2e/mesh.spec.ts` et `e2e/board.spec.ts` échouent. Le board ne montre aucune carte, et le journal du faux `swarph` n'existe pas. La CI ne lance pas l'e2e, ce qui explique que personne ne l'ait vu.

## 2. La cause

Depuis le 46.2 (D314), `envSwarph` ne transmet à `swarph` qu'une liste fermée de variables (`PATH`, `LANG`, `LC_*`, `TMPDIR`, `USER`, `LOGNAME`, `SHELL`), plus celles du mesh. Les anciens e2e passaient leurs réglages au faux `swarph` par des variables `FAKE_SWARPH_*` posées sur le daemon. Elles n'arrivent plus. Le faux `swarph` ne trouve plus ses fixtures du board, et il journalise dans `/dev/null`.

L'e2e du 46 et celui du 48 (`e2e/helpers-multi-mesh.ts`) n'ont pas ce problème : ils lancent le faux `swarph` par un petit script qui exporte lui-même ses variables, puis exécute le faux binaire.

## 3. Décision

### D327. Les réglages du faux swarph passent par un script

- Chaque e2e qui règle le faux `swarph` par une variable `FAKE_SWARPH_*` (ou le faux `tailscale` par `FAKE_TAILSCALE_*`, si son environnement est filtré lui aussi) le lance par un script généré dans le dossier temporaire du test. Ce script exporte ces variables, puis exécute le faux binaire, comme dans `e2e/helpers-multi-mesh.ts`.
- `mesh.bin` (et `mesh.tailscale.bin` au besoin) pointe vers ce script.
- `envSwarph` et D314 ne changent pas. Aucune variable n'est ajoutée à la liste.

## 4. Point

### 50.1 La correction

- `e2e/global-setup.ts`, et chaque spec qui pose une variable `FAKE_*` destinée au faux `swarph` ou au faux `tailscale`.
- Un fichier d'erreur ou un réglage que le test change en cours de route reste un chemin de fichier, exporté par le script.
- **Tests :**
  - l'e2e entier, avant et après : chaque test qui échouait à cause de D314 passe, et aucun test qui passait n'échoue ;
  - le gate entier.
50.1 commité. Gate vert (3 884 tests). E2e : 121 tests passent, 14 échecs D314 résolus ; restent 6 échecs, causés par la page /swarph (50.2).

### 50.2 La page swarph sans mesh, et les daemons laissés par un e2e

- **Le constat.** Les trois e2e de `e2e/swairm-ask.spec.ts` (Swairm configuré, aucun mesh) attendent 90 s le bouton `swarph.ask`, sans le trouver. Sur la page `/swarph`, toute la zone principale manque, titre compris : la page semble planter. Piste à confirmer : `DemandesAvis` affiche aussi `DemandesAvisMesh` (40), qui supposerait un mesh.
- **La cascade.** Ces tests dépassent leur délai avant le `finally` qui arrête leur daemon. Les daemons restent en vie sur leurs ports. Les e2e suivants du mode host (`avis-mesh`, `confirmations-completes`, `mode-host`) trouvent alors ces ports pris (« Port des appareils indisponible », `EADDRINUSE`).
- **La correction.**
  - Trouver la cause du plantage, avec un test web qui la reproduit (Swairm configuré, aucun mesh), puis la corriger dans le web : la page `/swarph` et le bouton « Demander N avis » s'affichent sans mesh, et les salles d'avis mesh n'apparaissent qu'avec un mesh.
  - Dans `e2e/swairm-ask.spec.ts`, le daemon est arrêté même quand le test dépasse son délai (par exemple dans un `test.afterEach` ou par un délai de test plus court que celui de Playwright). Aucune assertion ne change.
- **Tests :**
  - le test web du plantage, rouge avant la correction et vert après ;
  - l'e2e entier sur le VPS, un worker : aucun échec, et aucun daemon de test en vie à la fin ;
  - le gate entier.

## 5. Fini quand

- Les points 50.1 et 50.2 sont commités, le gate est vert, l'e2e est vert sur le VPS, et la CI de la PR est verte.
- Julien a donné son oui pour le merge.

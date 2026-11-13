# Chantier 51 : l'e2e dans la CI

| Champ | Valeur |
|---|---|
| État | **Révision 0, 13 novembre 2026.** Julien a demandé d'ajouter les e2e à la CI, après le merge du 50. |
| Emplacement final | `docs/chantiers/51-e2e-ci.md` sur `main` |
| Base | `main`, après le merge du 50 (#162). |
| Organisation | La cell de gestion de Julien gère le chantier. Un agent Codex CLI écrit le job sur un brief tiré de ce plan. La cell de gestion relit le diff, lance le gate et l'e2e, commite et ouvre la PR. La CI de la PR elle-même prouve le job. |
| Validation | Seule la CI change. Aucun secret, aucun mesh, aucun réseau du lab : le lab ne relit pas ce chantier. Julien donne son oui pour le merge, CI verte, job e2e compris. |

## 1. Le constat

La CI lance le gate (typecheck, lint, build, tests) sous Node 22 et 24, et le labo serveur. Elle ne lance pas `npm run gate:e2e`. Entre le 46 et le 50, 25 des 132 e2e ont échoué sur `main` sans que personne ne le voie : D314 avait coupé les réglages du faux `swarph`, et les pages `/board` et `/swarph` restaient blanches sans mesh (chantier 50).

## 2. Décision

### D328. Un job e2e dans la CI

- `.github/workflows/ci.yml` gagne un job `e2e`, nommé « e2e », à côté de `gate` et de `labo`. Il tourne sur chaque PR et sur chaque push sur `main`, comme les autres.
- Le job tourne sur `ubuntu-22.04`, sous Node 22, avec les mêmes outils de compilation que le gate (`build-essential`, `python3`), puis `npm ci`.
- Il installe Chromium et ses dépendances système par Playwright (`npx playwright install --with-deps chromium`), à la version de Playwright fixée par `package-lock.json`.
- Il lance `npm run gate:e2e`, sans rien changer à ce script : le build, le test du paquet, puis l'e2e entier sur un seul worker.
- Aucune relance automatique d'un test qui échoue (`retries` reste à 0) : un test instable se corrige, il ne se cache pas.
- Quand le job échoue, il dépose les traces de Playwright (`test-results/`) en artefact, gardées 7 jours. Les traces ne montrent que des daemons, des fixtures et des faux binaires de test.
- Le job n'a que la permission `contents: read`, et il ne lit aucun secret.
- Le gate, le labo et le script `gate:e2e` ne changent pas. La configuration de Playwright ne change que si la CI le demande, avec la raison écrite dans le rapport.

## 3. Point

### 51.1 Le job e2e

- `.github/workflows/ci.yml` : le job de D328, avec un commentaire d'en-tête qui renvoie au chantier 51, sur le modèle du job `labo`.
- `README.md`, section « Développer » : une ligne dit que la CI lance aussi `gate:e2e`.
- `docs/chantiers/README.md` : la ligne du chantier 51.
- **Tests :**
  - l'e2e entier en local, avec `CI=1` dans l'environnement, comme sur le runner ;
  - le gate entier ;
  - la CI de la PR : les jobs `gate (node 22)`, `gate (node 24)`, `labo serveur` et `e2e` passent.
51.1 commité. Gate vert (3 889 tests). E2e local avec `CI=1` : 131 tests passent, 1 échoue par le temps (`e2e/coque.spec.ts:78`, une minute passe entre deux lectures du libellé « hors mesh depuis N min ») ; corrigé au 51.2.

### 51.2 Les e2e qui dépendent de l'horloge, et la marge du job

- **Le constat.** Sans relance, un e2e qui dépend du passage d'une minute fait échouer la CI au hasard. `e2e/coque.spec.ts:78` lit le libellé « hors mesh depuis N min » dans la barre, puis attend exactement le même texte dans les Réglages : quand une minute passe entre les deux, il échoue (« 2 min » attendu, « 3 min » reçu).
- **La correction.**
  - Ce test compare la partie stable du libellé : le même état, avec une durée de la forme attendue, sans exiger le même nombre de minutes. Ce qu'il prouve ne change pas : la pastille mène aux Réglages, section Mesh, sans rien basculer.
  - Les autres e2e qui comparent un libellé d'horloge (durée relative, heure, date) entre deux lectures, ou à une valeur calculée avant l'action, sont listés dans le rapport et corrigés de la même façon.
  - `eslint.config.js` ignore `test-results/`, comme `.gitignore` et `.prettierignore` : un gate lancé après un e2e local ne lit plus les traces de Playwright.
  - Le job `e2e` passe de 30 à 45 minutes de délai : un runner est plus lent que le VPS, où l'e2e prend 12 minutes.
- **Tests :**
  - le test de `coque.spec.ts` passe quand la minute change entre les deux lectures (par exemple en avançant l'horloge de la page avec `page.clock`, ou en le relançant à cheval sur une minute) ;
  - l'e2e entier en local, avec `CI=1` : aucun échec ;
  - le gate entier, lancé après l'e2e, dans le même worktree ;
  - la CI de la PR, job `e2e` compris.
51.2 commité. Gate vert (3 889 tests). E2e entier vert avec `CI=1` (132 tests), aucun daemon résiduel. Aucun autre e2e ne compare deux lectures d'un libellé d'horloge.

## 4. Fini quand

- Les points 51.1 et 51.2 sont commités, le gate est vert, l'e2e est vert sur le VPS, et la CI de la PR est verte, job `e2e` compris.
- Julien a donné son oui pour le merge.

## 5. Hors périmètre

- Rendre des jobs obligatoires dans la protection de `main` : `main` n'a pas de règle de protection aujourd'hui, et c'est un réglage du dépôt que Julien décide.
- L'e2e sous Node 24, sous macOS ou sous Windows.

# Chantier 53 : le champ « Aller au dossier » et la saisie pendant le premier chargement

| Champ | Valeur |
|---|---|
| État | **Révision 0, 13 novembre 2026.** Le job `e2e` de la CI a échoué une fois au hasard sur la PR #164. |
| Emplacement final | `docs/chantiers/53-e2e-dossier.md` sur `main` |
| Base | `main`, après le merge du 51 (#163). |
| Organisation | La cell de gestion de Julien gère le chantier. Un agent Codex CLI fait la correction sur un brief tiré de ce plan. La cell de gestion relit le diff, lance le gate et `gate:e2e`, commite et ouvre la PR. |
| Validation | Seuls le sélecteur de dossier et les e2e changent : aucun mesh, aucune frontière de sécurité. Le lab ne relit pas ce chantier. Julien donne son oui pour le merge, CI verte. |

## 1. Le constat

Sur la CI de la PR #164, `e2e/reconnexion.spec.ts:22` a échoué une fois, sans lien avec le diff de la PR. Le test enregistre un dépôt par `registerWorkspace` (`e2e/helpers.ts`), qui remplit le champ « Aller au dossier » avec `fill`. Le champ a reçu :

- attendu : `/tmp/aid-e2e-repo-PQwOCk/depot-reco` ;
- reçu : `/tmp/aid-e2e-repo-SzyfHs/tmp/aid-e2e-repo-PQwOCk/depot-reco`.

Le chemin du premier chargement de l'explorateur s'est retrouvé devant la saisie. `web/src/dialogues/SelecteurDossier.tsx` traite déjà ce cas : au premier chargement, quand le champ a le focus, il y pose le chemin sélectionné, pour que la frappe suivante le remplace. Cette parade ne couvre pas tous les ordres d'arrivée. Le même défaut touche une personne qui tape vite à l'ouverture du dialogue.

## 2. Décision

### D330. Une saisie commencée n'est jamais complétée par le premier chargement

- Le sélecteur de dossier ne doit jamais coller le chemin du premier chargement devant ou derrière une saisie commencée, quel que soit l'ordre d'arrivée entre la réponse du daemon, le focus et la frappe.
- La cause exacte est d'abord établie, avec un test web qui reproduit l'ordre fautif. La correction se fait dans le composant : un e2e qui attendrait seulement la fin du chargement cacherait le défaut sans le corriger.
- Ce que voit l'utilisateur ne change pas par ailleurs : le chemin chargé s'affiche dans le champ, « Entrée » ouvre le chemin tapé, et une réponse arrivée en retard n'écrase jamais un chemin tapé.

## 3. Point

### 53.1 La cause et la correction

- `web/src/dialogues/SelecteurDossier.tsx`, et un test web sous `test/web/` qui reproduit l'ordre fautif : rouge avant la correction, vert après.
- `e2e/helpers.ts` ne change que si la cause est dans le test et non dans le composant, avec la raison écrite dans le rapport.
- **Tests :**
  - le test web, rouge puis vert ;
  - les tests web existants du sélecteur ;
  - `e2e/reconnexion.spec.ts` lancé 20 fois de suite (`--repeat-each=20`), sans échec ;
  - le gate entier, et `gate:e2e` entier sous Node 22 avec `CI=1`.

## 4. Fini quand

- Le point 53.1 est commité, le gate et `gate:e2e` sont verts sur le VPS, et la CI de la PR est verte.
- Julien a donné son oui pour le merge.

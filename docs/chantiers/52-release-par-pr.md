# Chantier 52 : la release sans push sur main

| Champ | Valeur |
|---|---|
| État | **Révision 0, 13 novembre 2026.** Julien a fait protéger `main` après le 51, et a choisi de faire passer la version par une PR ordinaire. |
| Emplacement final | `docs/chantiers/52-release-par-pr.md` sur `main` |
| Base | `main`, après le merge du 51 (#163). |
| Organisation | La cell de gestion de Julien gère le chantier. Un agent Codex CLI fait le changement sur un brief tiré de ce plan. La cell de gestion relit le diff, lance le gate et `gate:e2e`, commite et ouvre la PR. |
| Validation | Seuls le workflow Release et son outillage changent : aucun secret nouveau, aucun mesh. Le lab ne relit pas ce chantier. Julien donne son oui pour le merge, CI verte. La première vraie release après le merge sert de recette. |

## 1. Le constat

Depuis le 13 novembre 2026, une règle GitHub protège `main` : les jobs `gate (node 22)`, `gate (node 24)`, `labo serveur` et `e2e` sont obligatoires, la PR doit être à jour avec `main`, et personne n'en est exempté. Le workflow Release (DR2, chantier 13) fixe la version, commite `release: v<version>` et le pousse directement sur `main` avec le jeton de GitHub Actions. Ce push est désormais refusé. Sur un dépôt personnel, GitHub ne permet pas d'exempter GitHub Actions d'une règle.

## 2. Décisions

### D329. La version passe par une PR ordinaire, Release ne fait plus que le tag et la publication

- **Le bump.** Un script, `scripts/preparer-release.sh <X.Y.Z>`, lancé par `npm run release:preparer -- <X.Y.Z>`, fait ce que faisait l'étape « fixer la version » de Release : il contrôle le semver (`X.Y.Z`, sans suffixe, DR16), met la version dans `package.json` et `package-lock.json` (`npm version --no-git-tag-version`), la recopie dans `app/src-tauri/tauri.conf.json` (DR1), puis passe Prettier sur ces fichiers. Il ne commite pas, ne crée pas de tag et ne pousse rien.
- **La PR.** La cell de gestion lance ce script quand Julien demande une release, sur une branche `release/v<X.Y.Z>`, et ouvre une PR titrée `release: v<X.Y.Z>`. Elle passe la CI comme toute PR, puis se merge sur le oui de Julien.
- **Le workflow Release** (`workflow_dispatch`, entrée `version` inchangée) ne commite plus rien et ne pousse plus sur `main`. Le job `version` :
  - contrôle le semver et que le tag `v<version>` est libre, comme avant ;
  - contrôle que `package.json` et `app/src-tauri/tauri.conf.json` sur `main` portent déjà cette version. Sinon, il échoue avec un message qui renvoie à `npm run release:preparer` ;
  - pose le tag sur le commit de `main` qu'il a lu, pousse ce seul tag, et crée la release brouillon, comme avant.
- Les jobs `server`, `board` et `publish` ne changent pas.
- **DR2 change.** « Personne ne gère de tag » reste vrai : seul Release pose le tag. Le bump de version se fait désormais dans une PR, mais seulement par ce script et à la demande de Julien. La règle d'exécution « Ne bump aucune version » reste valable pour les chantiers.

## 3. Point

### 52.1 Le script, le workflow et la doc

- `scripts/preparer-release.sh` et le script npm `release:preparer`.
- `.github/workflows/release.yml` : le job `version` selon D329. Le commentaire d'en-tête dit le nouveau déroulé.
- `docs/chantiers/13-aid-server-aid-board.md` : sous DR2, une ligne renvoie au chantier 52, sans réécrire DR2.
- `README.md` : une courte section « Publier une release », avec les deux temps : la PR de version, puis le workflow Release.
- `docs/chantiers/README.md` : la ligne du chantier 52.
- **Tests :**
  - un test du script, dans un dossier temporaire qui contient une copie de `package.json`, de `package-lock.json` et de `app/src-tauri/tauri.conf.json` : la version passe dans les trois fichiers, un semver invalide est refusé sans rien changer, et aucun fichier hors de ces trois n'est touché ;
  - un test qui lit `release.yml` : aucun `git push` vers `main`, aucun `git commit`, et le contrôle de la version sur `main` est présent ;
  - le gate entier, et `gate:e2e` entier sous Node 22 avec `CI=1`.
52.1 commité. Gate vert (3 891 tests). `gate:e2e` entier vert sous Node 22 avec `CI=1` (paquet, archive serveur, 132 tests Playwright), aucun daemon résiduel. Le script travaille toujours dans le dossier courant : `AID_RELEASE_DIR` reste la variable du dossier de sortie de `package-server.sh`.

## 4. Fini quand

- Le point 52.1 est commité, le gate et `gate:e2e` sont verts sur le VPS, et la CI de la PR est verte.
- Julien a donné son oui pour le merge.
- La recette se fait à la prochaine release que Julien demande : la PR de version, puis le workflow Release jusqu'à la publication.

## 5. Hors périmètre

- Une release maintenant : aucune n'est demandée.
- Une exemption de la règle de `main`, par une clé de déploiement ou autrement.

# Chantier 54 : un identifiant neutre dans les tests et le code

| Champ | Valeur |
|---|---|
| État | **Révision 0, 13 novembre 2026.** Julien a demandé de remplacer son prénom dans les e2e. |
| Emplacement final | `docs/chantiers/54-prenom-tests.md` sur `main` |
| Base | `main`, après le merge du 53 (#165). |
| Organisation | La cell de gestion de Julien gère le chantier. Un agent Codex CLI fait les remplacements sur un brief tiré de ce plan. La cell de gestion relit le diff, lance le gate et `gate:e2e`, commite et ouvre la PR. |
| Validation | Des données de test et des commentaires changent, sans changer de comportement. Les tests de frontière changent seulement par leurs données. Le lab ne relit pas ce chantier. Julien donne son oui pour le merge, CI verte. |

## 1. Le constat

Le prénom de Julien sert d'identité synthétique dans les tests : le login Tailscale du faux appairage (`<prénom>@exemple`), le nom d'utilisateur posé par le faux Serve, des noms d'appareil et des titres de sujet. On le trouve dans 2 fichiers de `e2e/`, 13 fichiers de `test/`, et 3 commentaires de code (`src/shared/host.ts`, `src/cli/commands/mcp.ts`, `scripts/sonde-serve.mjs`). Le dépôt est public.

## 2. Décisions

### D331. Une identité de test neutre

- Le login synthétique devient `utilisateur@exemple`. La variante `<prénom>@exemple.fr` de `test/secrets.test.ts` devient `utilisateur@exemple.fr`.
- Un nom d'utilisateur, un nom d'appareil ou un titre de sujet qui contient le prénom prend une forme neutre sans prénom, par exemple `Utilisateur`, `Mon iPhone` ou `Titre privé`. Chaque test garde la même forme de donnée (espaces, longueur, casse) quand l'assertion en dépend.
- Dans un commentaire de code, le prénom devient une désignation de rôle, par exemple « l'utilisateur » ou « le propriétaire du poste ».
- Aucune assertion ne change de sens. Dans les tests de frontière (`test/host-liste.test.ts`, `test/host-masque.test.ts`), seules les chaînes de données changent.

### D332. Une garde sur les dossiers de code et de test

- `test/noms-neutres.test.ts` gagne une seconde liste d'empreintes, qui ne vaut que pour les fichiers suivis sous `e2e/`, `test/`, `src/`, `web/`, `scripts/` et `app/`. Elle contient l'empreinte SHA-256 du prénom en minuscules. Le prénom n'apparaît en clair nulle part, pas même dans la garde.
- Les plans, la doc, les maquettes, `brief.md` et `LICENSE` sont hors de cette garde. Le prénom y désigne la personne qui décide ou le titulaire du droit d'auteur, et non une donnée de test.

## 3. Point

### 54.1 Les remplacements et la garde

- Les fichiers listés au constat, selon D331.
- `test/noms-neutres.test.ts`, selon D332, avec un test qui montre que la garde rejette ce nom sous `e2e/` ou `test/`, et l'accepte sous `docs/`.
- **Tests :**
  - `git grep -i` du prénom sous les six dossiers de D332 ne trouve plus rien ;
  - le gate entier, et `gate:e2e` entier sous Node 22 avec `CI=1`.
54.1 commité. Gate vert (3 893 tests). `gate:e2e` entier vert sous Node 22 avec `CI=1` (paquet, archive serveur, 132 tests Playwright), aucun daemon résiduel. Le prénom ne figure plus sous les six dossiers de D332.

### 54.2 Correctif : une garde qui tient dans le délai de la CI

Sur la CI de la PR #167, le test « les fichiers texte suivis utilisent des noms neutres » a dépassé le délai par défaut de 5 s (5 044 ms sous Node 22, 5 160 ms sous Node 24). Depuis le 54.1, chaque mot d'un fichier sous les six dossiers de D332 est haché deux fois, une fois par liste d'empreintes.

- Chaque mot est haché une seule fois. L'empreinte est comparée à la liste générale, puis, pour un fichier sous les six dossiers, à la liste du code. Les messages d'erreur ne changent pas.
- Le test du parcours reçoit un délai explicite de 30 s, pour ne pas dépendre de la vitesse de la machine.
- Les deux autres tests de la garde ne changent pas de sens.
- **Tests :** le gate entier ; le temps du test du parcours, avant et après, relevé dans le rapport.

## 4. Fini quand

- Le point 54.1 est commité, le gate et `gate:e2e` sont verts sur le VPS, et la CI de la PR est verte.
- Julien a donné son oui pour le merge.

## 5. Hors périmètre

- Le prénom dans `docs/`, `design/`, `brief.md` et `LICENSE`.
- L'historique git : la réécrire est une décision de Julien, déjà ouverte depuis le 49.

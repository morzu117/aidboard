# Chantier 47 : les avatars des pairs

| Champ | Valeur |
|---|---|
| État | **Révision 0, 12 novembre 2026.** Julien a choisi ce chantier dans la ligne « Plus tard » du programme. Il a demandé d'avancer seul pendant la nuit : les questions Q-J1 à Q-J3 sont tranchées par morzu-vps, à confirmer par Julien avant le merge. |
| Emplacement final | `docs/chantiers/47-avatars-pairs.md` sur `main` |
| Base | `main`, après le merge du 46 (#158). |
| Organisation | morzu-vps gère le chantier. Un agent Codex CLI écrit le code et les tests de chaque point, sur un brief tiré de ce plan. morzu-vps relit chaque diff, lance le gate, commite et ouvre la PR. |
| Validation | Le chantier ne touche ni au mesh, ni aux écritures, ni au corps signé : le lab ne le relit pas. Viennent ensuite la recette de Julien et son oui pour le merge, CI verte. |

## 1. Pourquoi

Le programme (§5, phase 5, « Plus tard ») prévoit des avatars de pairs. Depuis le 40 et le 46, une même vue montre beaucoup de cells : la boîte fusionnée de plusieurs meshes, les salles d'avis, le board et ses responsables. Un repère visuel stable par cell aide à les distinguer d'un coup d'œil.

## 2. État actuel

| Zone | Où | Ce qui existe |
|---|---|---|
| La boîte | `web/src/ecrans/Boite.tsx:380-394` | L'expéditeur d'un DM, en texte (`dm.from`). |
| Les cells | `web/src/ecrans/Cells.tsx` | Le tableau des pairs, par nom. |
| Le board | `Board.tsx:196`, `CarteBoard.tsx:104, 164, 378` | Le responsable d'une carte (`assignee`) et le porteur d'une obligation (`holder`), en texte. |
| Les salles d'avis | `TableauAvisMesh.tsx:47, 72, 126`, `FormulaireAvisMesh.tsx:105-140` | La cell de chaque avis, la baseline, et le choix des cells d'une salle. |
| Le rail | `web/src/ui/Nav.tsx:21-39` | `initialesGroupe` et la palette `COULEURS_GROUPE` (huit couleurs, chacune avec une couleur de texte lisible), pour les carrés des groupes. |
| swarph | `swarph mesh peers` | Aucun champ d'avatar, d'image ni de couleur. |

## 3. Cible et hors-périmètre

**Cible.** Chaque nom de cell affiché dans les zones ci-dessus est précédé d'un petit disque, avec les initiales de la cell sur une couleur de la palette. Les initiales et la couleur se calculent à partir du nom ; la config locale peut les remplacer.

**Hors périmètre.**

- Les images : ni téléversement, ni lien, ni lecture sur le réseau.
- Un avatar publié par le mesh : swarph n'en porte pas.
- Le téléphone (`AppPda`), le panneau des confirmations du Mac (`ParametresSignes`), l'appareil (`AppAppareil`, `AccueilAppareil`, `ParcoursAppareil`), le mode host et les notifications du système. Ces écrans restent en texte seul : ce qu'on y signe ou y voit ne doit dépendre d'aucun décor.
- L'édition des avatars à l'écran.

## 4. Décisions

### D318. Le calcul

- **Les initiales.** Le nom est coupé sur `-`, `_`, `.` et l'espace. Avec au moins deux morceaux, on prend la première lettre ou le premier chiffre des deux premiers ; sinon, les deux premiers caractères. Le résultat est en majuscules, et `?` remplace une suite vide.
  - Exemples : `peer-a` → `PA` ; `principal` → `PR` ; `aid_e2e` → `AE`.
- **La couleur.** Un hachage FNV-1a 32 bits du nom, modulo sept, choisit parmi les sept premières couleurs de la palette. `gris` est réservé à une valeur inconnue.
- **La palette** est définie une seule fois, dans `src/shared/avatars.ts`, avec des identifiants stables : `menthe`, `violet`, `orange`, `bleu`, `rose`, `ambre`, `turquoise`, `gris`. `Nav.tsx` l'importe au lieu de garder sa copie : mêmes valeurs, même ordre.
- **Une cell a le même avatar dans tous les meshes** : la clé est son nom seul. Julien a choisi « les mêmes cells » pour ses meshes (46).

### D319. La surcharge locale

- Dans `config.yaml`, une table facultative :

  ```yaml
  avatars:
    peer-a: { initiales: "A1", couleur: bleu }
    peer-b: { couleur: rose }
  ```

- **Les validations** : une clé suit `/^[^\s\p{Cc}]{1,64}$/u` ; `initiales` suit `/^[\p{L}\p{N}]{1,2}$/u` ; `couleur` est un identifiant de la palette ; aucune autre clé n'est admise. La table compte au plus 200 entrées. Une valeur invalide arrête le chargement de la config avec un message clair, comme les autres sections.
- **La route** `GET /api/avatars` rend `{ avatars: { [cell]: { initiales?, couleur? } } }`. Elle suit la même garde que `GET /api/meshes`. Elle ne fait pas partie des routes du mode host. Sans route, ou en cas d'erreur, le web garde l'avatar calculé.

### D320. L'affichage

- **Un composant** `AvatarCell`, un disque de 1,25 em, avec les initiales dans la couleur de texte de la palette. Il est **décoratif** : `aria-hidden`, et le nom de la cell reste toujours écrit à côté, en texte. Un avatar ne remplace jamais un nom, puisque deux cells peuvent se ressembler.
- **Il est placé** devant l'expéditeur d'un DM, le nom d'un pair dans `Cells`, le responsable et le porteur sur le board, la cell d'un avis et la baseline, et chaque cell du choix d'une salle.
- **Sa cell à lui** (la cell d'A-I-D sur ce mesh) porte en plus un anneau, avec le titre « cette cell ».
- Le texte des initiales passe par React, jamais par du HTML. La couleur vient de la palette, jamais d'une valeur libre.
- Rien d'autre ne change dans la mise en page.

### Les questions tranchées pour Julien

- **Q-J1, la surcharge** : dans la config seulement, sans édition à l'écran (choix de morzu-vps, à confirmer). L'interface va bouger ; un réglage à l'écran viendra avec elle.
- **Q-J2, les écrans en texte seul** : le téléphone, les confirmations, l'appareil et le mode host (choix de morzu-vps, à confirmer).
- **Q-J3, la même cell dans deux meshes** : le même avatar (choix de morzu-vps, à confirmer).

## 5. Points

### 47.1 Le calcul, la config et la route (D318, D319)

- `src/shared/avatars.ts` : la palette, `initialesCell`, `couleurCell` et `avatarCell(nom, surcharges)`.
- `src/daemon/config.ts` : `parseAvatars`, branché comme les autres sections.
- `GET /api/avatars`, avec sa garde.
- `Nav.tsx` importe la palette partagée.
- **Tests :**
  - les initiales des exemples de D318, d'un nom vide, d'un nom en un seul morceau, et d'un nom non latin ;
  - une couleur stable pour un même nom, et la répartition de vingt noms sur au moins quatre couleurs ;
  - la surcharge partielle et complète ;
  - chaque refus de la config : clé, initiales, couleur, clé inconnue et plus de 200 entrées ;
  - la route, sa garde et son absence en mode host ;
  - le rail inchangé.
47.1 commité en local. Gate vert (3 784 tests). Le calcul, la config avatars et GET /api/avatars ; absent du serveur host (host-liste).

### 47.2 Le web et la recette (D320)

- `web/src/ui/AvatarCell.tsx`, un hook `useAvatars()` (une lecture, gardée en mémoire), et le style dans le CSS existant, valable en thème clair et sombre.
- Les placements de D320.
- La fiche `docs/recette-chantier-47-avatars-pairs.md`, et la ligne du README.
- **Tests :**
  - le composant : `aria-hidden`, le nom toujours présent, l'anneau de sa propre cell ;
  - chaque placement ;
  - le repli sur l'avatar calculé quand la route échoue ;
  - aucun avatar sur le téléphone, les confirmations et l'appareil ;
  - des initiales de surcharge rendues comme du texte.

## 6. Pièges

- Ne jamais rendre une couleur ou un texte de la config autrement que par la palette et par React.
- Ne jamais retirer le nom d'une cell au profit de son avatar.
- Aucun nom de cell réel dans le code, les tests ou la doc : `principal`, `perso`, `peer-a`, `peer-b`.
- Les tests de frontière host ne changent pas.

## 7. Fini quand

- Les points 47.1 et 47.2 sont commités.
- Le gate est vert, et la CI de la PR est verte.
- Julien a confirmé Q-J1 à Q-J3, a fait la recette et a donné son oui pour le merge.
